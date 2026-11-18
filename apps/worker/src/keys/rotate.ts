import { randomBytes } from "node:crypto";
import {
  DecryptionError,
  KeyServiceUnavailableError,
  type KeyProvider,
  type Logger,
} from "@valtrexia/core/server";
import { rewrapRecord, type Db, type EncryptedRecordRef } from "@valtrexia/db";

export interface RotationDeps {
  db: Db;
  keyProvider: KeyProvider;
  logger: Logger;
}

export interface RotationOptions {
  /** Records read per page. Default 100. */
  batchSize?: number;
  /** Count what would move, and change nothing. */
  dryRun?: boolean;
}

export interface RotationSummary {
  /** The key every record should end up under. */
  currentKeyId: string;
  /** Records found under another key. */
  examined: number;
  rewrapped: number;
  /** Replaced or removed while the command ran; nothing to do. */
  skipped: number;
  /** Could not be read with any configured key. Listed by id, never by content. */
  unreadable: Pick<EncryptedRecordRef, "tenantId" | "type" | "id">[];
  /** True when the key service stopped answering and the run ended early. Run again to resume. */
  interrupted: boolean;
  /** Records still under another key when the run ended, by key. */
  remaining: { keyId: string | null; records: number }[];
}

/**
 * The key id new data keys are wrapped under. Found by wrapping a throwaway
 * key, which also proves the current key is usable before anything is moved.
 * For AWS KMS that is one Encrypt call, and resolves an alias to its key.
 */
export async function currentKeyId(keyProvider: KeyProvider): Promise<string> {
  const probe = randomBytes(32);
  try {
    return (await keyProvider.wrapKey(probe, Buffer.from("v1|key-probe|-|-", "utf8"))).keyId;
  } finally {
    probe.fill(0);
  }
}

/**
 * Moves every encrypted record (integration credentials and webhook
 * destinations, in every tenant) to the key provider's current key.
 *
 * Only each record's small wrapped data key is replaced; the stored values
 * are not re-encrypted, and no value is ever returned or logged. Safe to run
 * while the app serves requests, provided the app is configured with the
 * same current key and can still unwrap the old ones. Resumable: a second run
 * picks up whatever the first did not finish, and records already moved are
 * not touched. One record at a time, to be gentle on the key service.
 */
export async function rotateKeys(
  deps: RotationDeps,
  options: RotationOptions = {},
): Promise<RotationSummary> {
  const batchSize = Math.min(Math.max(options.batchSize ?? 100, 1), 1000);
  const target = await currentKeyId(deps.keyProvider);
  const summary: RotationSummary = {
    currentKeyId: target,
    examined: 0,
    rewrapped: 0,
    skipped: 0,
    unreadable: [],
    interrupted: false,
    remaining: [],
  };

  let after: EncryptedRecordRef | null = null;
  pages: for (;;) {
    const page = await deps.db.listEncryptedRecords({
      excludeKeyId: target,
      after,
      limit: batchSize,
    });
    if (page.length === 0) break;
    for (const record of page) {
      summary.examined += 1;
      if (options.dryRun) continue;
      try {
        const { outcome } = await rewrapRecord(deps.db, deps.keyProvider, record, target);
        if (outcome === "rewrapped") summary.rewrapped += 1;
        else summary.skipped += 1;
      } catch (error) {
        if (error instanceof KeyServiceUnavailableError) {
          deps.logger.warn(
            { recordType: record.type, recordId: record.id },
            "key service unavailable; stopping. Run the command again to resume",
          );
          summary.interrupted = true;
          break pages;
        }
        if (!(error instanceof DecryptionError)) throw error;
        deps.logger.error(
          { tenantId: record.tenantId, recordType: record.type, recordId: record.id },
          "record cannot be read with any configured key",
        );
        summary.unreadable.push({ tenantId: record.tenantId, type: record.type, id: record.id });
      }
    }
    after = page[page.length - 1]!;
    if (page.length < batchSize) break;
  }

  const byKey = new Map<string | null, number>();
  for (const row of await deps.db.countEncryptedRecordsByKey()) {
    if (row.keyId === target) continue;
    byKey.set(row.keyId, (byKey.get(row.keyId) ?? 0) + row.records);
  }
  summary.remaining = [...byKey].map(([keyId, records]) => ({ keyId, records }));
  return summary;
}
