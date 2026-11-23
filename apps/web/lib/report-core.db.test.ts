import { randomUUID } from "node:crypto";
import { createDb, type Db } from "@valtrexia/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { getClientReport } from "./report-core";
import type { TenantSession } from "./session-core";

const urls = inject("databaseUrls");
let db: Db;
beforeAll(() => {
  db = createDb({ url: urls.app });
});
afterAll(async () => {
  await db.disconnect();
});

// 23:30 UTC on 30 November: already December in Tokyo.
const NOW = new Date("2026-11-30T23:30:00Z");

async function seed(timeZone: string) {
  const tenantId = await db.provisionTenant({ clerkOrgId: `org_${randomUUID()}`, name: "MSP" });
  return db.withTenant(tenantId, async ({ tx }) => {
    await tx.tenant.update({ where: { id: tenantId }, data: { timeZone } });
    const user = await tx.user.create({
      data: {
        tenantId,
        clerkUserId: `user_${randomUUID()}`,
        email: "tech@msp.example",
        name: "Alex Tech",
        role: "technician",
      },
    });
    const client = await tx.client.create({ data: { tenantId, name: "Acme" } });
    const session: TenantSession = {
      tenantId,
      userId: user.id,
      clerkUserId: user.clerkUserId,
      role: user.role,
    };
    return { session, clientId: client.id };
  });
}

describe("getClientReport", () => {
  it("shows the last full month in the workspace's time zone, with its neighbours", async () => {
    const { session, clientId } = await seed("Asia/Tokyo");
    const page = await getClientReport({ db }, session, clientId, undefined, NOW);
    expect(page).toMatchObject({
      client: { id: clientId, name: "Acme" },
      timeZone: "Asia/Tokyo",
      month: "2026-11",
      previous: "2026-10",
      next: "2026-12",
    });
    expect(page!.report.partial).toBe(false);
  });

  it("shows the current month without a next one, and ignores a month out of range", async () => {
    const { session, clientId } = await seed("UTC");
    const current = await getClientReport({ db }, session, clientId, "2026-11", NOW);
    expect(current).toMatchObject({ month: "2026-11", next: null });
    expect(current!.report.partial).toBe(true);
    const oldest = await getClientReport({ db }, session, clientId, "2025-11", NOW);
    expect(oldest).toMatchObject({ month: "2025-11", previous: null });
    expect((await getClientReport({ db }, session, clientId, "2025-10", NOW))!.month).toBe(
      "2026-10",
    );
  });

  it("finds nothing for another tenant's client or a malformed id", async () => {
    const first = await seed("UTC");
    const second = await seed("UTC");
    expect(
      await getClientReport({ db }, second.session, first.clientId, undefined, NOW),
    ).toBeNull();
    expect(await getClientReport({ db }, first.session, "not-a-uuid", undefined, NOW)).toBeNull();
  });
});
