import type { RaisedIncidentType } from "@valtrexia/core";
import {
  KeyServiceUnavailableError,
  PsaError,
  Secret,
  SYNCRO_SUBDOMAIN,
  SyncroClient,
  type PsaCustomer,
  type SyncroCredentials,
} from "@valtrexia/core/server";
import {
  ChannelNameTakenError,
  createPsaChannel,
  decryptPsaCredentials,
  listPsaMappings,
  loadPsaChannel,
  replacePsaCredentials,
  setPsaMappings,
  updatePsaSettings,
  type PsaChannelConfig,
  type PsaMappingRow,
} from "@valtrexia/db";
import { z } from "zod";
import {
  nameSchema,
  typesSchema,
  type ChannelField,
  type ChannelState,
  type NotificationDeps,
} from "./notifications-core";
import type { TenantSession } from "./session-core";

/**
 * Setting up a PSA channel (Syncro): connecting it, choosing how tickets are
 * filed, and matching clients to the PSA's customers. Owners only: every
 * page here reads the PSA live with the channel's stored token.
 */

const OWNERS_ONLY = "Only workspace owners can manage notification channels.";
const NOT_FOUND = "That channel no longer exists.";
const KEY_SERVICE =
  "The encryption key service could not be reached, so nothing was saved. Try again shortly.";

type Deps = Pick<NotificationDeps, "db" | "keyProvider" | "ip" | "psa">;

function client(deps: Deps, credentials: SyncroCredentials): SyncroClient {
  return new SyncroClient({
    credentials,
    ...(deps.psa?.fetch ? { fetch: deps.psa.fetch } : {}),
    ...(deps.psa?.baseUrl ? { baseUrl: deps.psa.baseUrl } : {}),
  });
}

/**
 * A Syncro subdomain from what people paste: the name itself, the account's
 * address, or a link into it. Null if it is none of those.
 */
export function readSubdomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let text = value.trim().toLowerCase();
  if (text === "" || text.length > 300) return null;
  if (/^[a-z]+:\/\//.test(text)) {
    try {
      text = new URL(text).hostname;
    } catch {
      return null;
    }
  }
  text = text.replace(/\/.*$/, "").replace(/\.syncromsp\.com$/, "");
  return SYNCRO_SUBDOMAIN.test(text) ? text : null;
}

const tokenSchema = z.string().trim().min(8).max(400).regex(/^\S+$/);

/** Says what a failed check of the subdomain and token means, field by field. */
function connectionProblem(error: unknown): {
  message: string;
  fieldErrors?: Partial<Record<ChannelField, string>>;
} {
  if (!(error instanceof PsaError)) throw error;
  if (error.kind === "auth") {
    return {
      message: "Check the highlighted fields.",
      fieldErrors: { apiToken: "Syncro refused this API token." },
    };
  }
  if (error.kind === "permission") {
    return {
      message: "Check the highlighted fields.",
      fieldErrors: {
        apiToken:
          "This token's Syncro user lacks a permission needed here: customers (list) and tickets (list, create, edit, view).",
      },
    };
  }
  if (
    error.kind === "not_found" ||
    (error.kind === "unavailable" && /reached/.test(error.message))
  ) {
    return {
      message: "Check the highlighted fields.",
      fieldErrors: { subdomain: "No Syncro account answered at this address." },
    };
  }
  return { message: `${error.message} Nothing was saved.` };
}

/** The status tickets move to on recovery, by default: "Resolved" if the account has it. */
export function defaultResolvedStatus(statuses: readonly string[]): string {
  return (
    statuses.find((s) => s.toLowerCase() === "resolved") ??
    statuses.find((s) => /resolv|closed|complete/i.test(s)) ??
    "Resolved"
  );
}

/**
 * Connects a Syncro channel. The subdomain and token are tried against
 * Syncro before anything is saved; the token is then stored encrypted and
 * never shown again.
 */
export async function createSyncroChannelFor(
  deps: Deps,
  session: TenantSession,
  input: { name: unknown; subdomain: unknown; apiToken: unknown; incidentTypes: unknown },
): Promise<ChannelState> {
  if (session.role !== "owner") return { status: "error", message: OWNERS_ONLY };
  const fieldErrors: Partial<Record<ChannelField, string>> = {};
  const name = nameSchema.safeParse(input.name);
  if (!name.success) fieldErrors.name = "Give the channel a name of up to 80 characters.";
  const types = typesSchema.safeParse(input.incidentTypes);
  if (!types.success) fieldErrors.incidentTypes = "Choose at least one kind of incident.";
  const subdomain = readSubdomain(input.subdomain);
  if (!subdomain) {
    fieldErrors.subdomain = "Enter your Syncro subdomain: the name before .syncromsp.com.";
  }
  const token = tokenSchema.safeParse(input.apiToken);
  if (!token.success) fieldErrors.apiToken = "Paste the API token from your Syncro user profile.";
  if (!name.success || !types.success || !subdomain || !token.success) {
    return { status: "error", message: "Check the highlighted fields.", fieldErrors };
  }

  const credentials: SyncroCredentials = { subdomain, apiToken: token.data };
  let userName: string | null;
  let resolvedStatus: string;
  try {
    const syncro = client(deps, credentials);
    userName = (await syncro.me()).userName;
    resolvedStatus = defaultResolvedStatus((await syncro.ticketOptions()).statuses);
  } catch (error) {
    return { status: "error", ...connectionProblem(error) };
  }

  try {
    const channel = await deps.db.withTenant(session.tenantId, (context) =>
      createPsaChannel(context, deps.keyProvider, {
        name: name.data,
        credentials: new Secret(credentials),
        problemType: null,
        resolvedStatus,
        incidentTypes: types.data as RaisedIncidentType[],
        actorUserId: session.userId,
        ip: deps.ip ?? null,
      }),
    );
    return {
      status: "ok",
      message: `Connected to Syncro${userName ? ` as ${userName}` : ""}. Next, match your clients to Syncro customers: tickets are opened only for clients that are matched.`,
      channelId: channel.id,
    };
  } catch (error) {
    if (error instanceof ChannelNameTakenError) {
      return {
        status: "error",
        message: "Check the highlighted fields.",
        fieldErrors: { name: "A channel with this name already exists." },
      };
    }
    if (error instanceof KeyServiceUnavailableError)
      return { status: "error", message: KEY_SERVICE };
    throw error;
  }
}

export interface SyncroSetup {
  channel: { id: string; name: string } & PsaChannelConfig;
  mappings: PsaMappingRow[];
  /** Read from Syncro now; null if it could not be read. */
  live: {
    statuses: string[];
    problemTypes: string[];
    customers: PsaCustomer[];
    /** False when Syncro has more customers than were read. */
    complete: boolean;
  } | null;
  /** Why Syncro could not be read. */
  liveError: string | null;
  /** For unmatched clients: a customer with the same name, to offer. */
  suggestions: Record<string, string>;
}

/** Names compared loosely: case, spacing and punctuation aside. */
export function sameName(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  return norm(a) !== "" && norm(a) === norm(b);
}

/** Everything the setup page shows. Null for a channel that is not this tenant's PSA channel. */
export async function getSyncroSetup(
  deps: Deps,
  session: TenantSession,
  channelId: string,
): Promise<SyncroSetup | "forbidden" | null> {
  if (session.role !== "owner") return "forbidden";
  if (!z.uuid().safeParse(channelId).success) return null;
  const loaded = await deps.db.withTenant(session.tenantId, async (context) => {
    const channel = await loadPsaChannel(context, channelId);
    if (!channel) return null;
    return { channel, mappings: await listPsaMappings(context, channelId) };
  });
  if (!loaded) return null;

  let live: SyncroSetup["live"] = null;
  let liveError: string | null = null;
  try {
    const credentials = await decryptPsaCredentials(
      { tenantId: session.tenantId },
      deps.keyProvider,
      loaded.channel,
    );
    const syncro = client(deps, credentials.expose());
    const options = await syncro.ticketOptions();
    const { customers, complete } = await syncro.listCustomers();
    live = { ...options, customers, complete };
  } catch (error) {
    if (error instanceof PsaError) liveError = error.message;
    else if (error instanceof KeyServiceUnavailableError) {
      liveError = "The encryption key service could not be reached, so Syncro could not be read.";
    } else throw error;
  }

  const suggestions: Record<string, string> = {};
  if (live) {
    for (const row of loaded.mappings) {
      if (row.customer) continue;
      const matches = live.customers.filter((c) => sameName(c.name, row.clientName));
      if (matches.length === 1) suggestions[row.clientId] = matches[0]!.id;
    }
  }
  return {
    channel: { id: loaded.channel.id, name: loaded.channel.name, ...loaded.channel.config },
    mappings: loaded.mappings,
    live,
    liveError,
    suggestions,
  };
}

/** Sets the problem type and the status for recovered assets, from the account's own lists. */
export async function saveSyncroSettingsFor(
  deps: Deps,
  session: TenantSession,
  channelId: string,
  input: { problemType: unknown; resolvedStatus: unknown },
): Promise<ChannelState> {
  const setup = await getSyncroSetup(deps, session, channelId);
  if (setup === "forbidden") return { status: "error", message: OWNERS_ONLY };
  if (!setup) return { status: "error", message: NOT_FOUND };
  if (!setup.live) return { status: "error", message: `${setup.liveError} Nothing was saved.` };
  const problemType = typeof input.problemType === "string" ? input.problemType : "";
  const resolvedStatus = typeof input.resolvedStatus === "string" ? input.resolvedStatus : "";
  if (problemType !== "" && !setup.live.problemTypes.includes(problemType)) {
    return { status: "error", message: "Choose a problem type from the list." };
  }
  if (!setup.live.statuses.includes(resolvedStatus)) {
    return { status: "error", message: "Choose a status from the list." };
  }
  await deps.db.withTenant(session.tenantId, (context) =>
    updatePsaSettings(context, {
      channelId,
      problemType: problemType || null,
      resolvedStatus,
      actorUserId: session.userId,
      ip: deps.ip ?? null,
    }),
  );
  return { status: "ok", message: "Ticket settings saved." };
}

/**
 * Saves which Syncro customer each client is. `choices` maps client ids to a
 * customer id, or to "" for none. Every customer chosen must be one Syncro
 * lists now; the name saved with it is Syncro's.
 */
export async function saveSyncroMappingsFor(
  deps: Deps,
  session: TenantSession,
  channelId: string,
  choices: ReadonlyMap<string, string>,
): Promise<ChannelState> {
  const setup = await getSyncroSetup(deps, session, channelId);
  if (setup === "forbidden") return { status: "error", message: OWNERS_ONLY };
  if (!setup) return { status: "error", message: NOT_FOUND };
  if (!setup.live) return { status: "error", message: `${setup.liveError} Nothing was saved.` };
  const byId = new Map(setup.live.customers.map((c) => [c.id, c]));
  const current = new Map(setup.mappings.map((row) => [row.clientId, row.customer?.id ?? ""]));
  const mappings: { clientId: string; customer: PsaCustomer | null }[] = [];
  for (const [clientId, customerId] of choices) {
    // Unchanged: left as it is, even if Syncro no longer lists that customer.
    if (current.get(clientId) === customerId) continue;
    if (customerId === "") {
      mappings.push({ clientId, customer: null });
      continue;
    }
    const customer = byId.get(customerId);
    if (!customer) {
      return {
        status: "error",
        message:
          "One of the chosen Syncro customers is no longer listed in Syncro. Nothing was saved.",
      };
    }
    mappings.push({ clientId, customer });
  }
  const { mapped, unmapped } = await deps.db.withTenant(session.tenantId, (context) =>
    setPsaMappings(context, {
      channelId,
      mappings,
      actorUserId: session.userId,
      ip: deps.ip ?? null,
    }),
  );
  if (mapped + unmapped === 0) return { status: "ok", message: "Nothing changed." };
  const parts = [
    mapped > 0 ? `${mapped} ${mapped === 1 ? "client" : "clients"} matched` : null,
    unmapped > 0 ? `${unmapped} unmatched` : null,
  ].filter(Boolean);
  return { status: "ok", message: `Saved: ${parts.join(", ")}.` };
}

/** Replaces the channel's API token, after trying the new one against Syncro. */
export async function replaceSyncroTokenFor(
  deps: Deps,
  session: TenantSession,
  channelId: string,
  input: { apiToken: unknown },
): Promise<ChannelState> {
  if (session.role !== "owner") return { status: "error", message: OWNERS_ONLY };
  if (!z.uuid().safeParse(channelId).success) return { status: "error", message: NOT_FOUND };
  const token = tokenSchema.safeParse(input.apiToken);
  if (!token.success) {
    return {
      status: "error",
      message: "Check the highlighted fields.",
      fieldErrors: { apiToken: "Paste the API token from your Syncro user profile." },
    };
  }
  const channel = await deps.db.withTenant(session.tenantId, (context) =>
    loadPsaChannel(context, channelId),
  );
  if (!channel) return { status: "error", message: NOT_FOUND };
  try {
    await client(deps, { subdomain: channel.config.subdomain, apiToken: token.data }).me();
  } catch (error) {
    return { status: "error", ...connectionProblem(error) };
  }
  try {
    await deps.db.withTenant(session.tenantId, (context) =>
      replacePsaCredentials(context, deps.keyProvider, {
        channelId,
        apiToken: new Secret(token.data),
        actorUserId: session.userId,
        ip: deps.ip ?? null,
      }),
    );
  } catch (error) {
    if (error instanceof KeyServiceUnavailableError)
      return { status: "error", message: KEY_SERVICE };
    throw error;
  }
  return { status: "ok", message: "API token replaced. Waiting tickets are retried with it." };
}
