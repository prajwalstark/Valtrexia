import { z } from "zod";
import { brand } from "../brand";
import type { Logger } from "../logging/logger";

/**
 * Syncro's REST API (https://api-docs.syncromsp.com), as far as tickets need
 * it. Built from Syncro's published OpenAPI document; never yet run against a
 * real account. Everything that depends on Syncro's behaviour is in this file,
 * so what a real account shows differently is fixed here alone.
 *
 * What the reference says, and this relies on:
 *   - one base URL per account, https://{subdomain}.syncromsp.com/api/v1;
 *   - an API token per Syncro user, sent as a bearer token; it carries that
 *     user's permissions;
 *   - paged lists with `meta.total_pages` (pages are described as 25 items
 *     and shown as 100, so the page count is read, never assumed);
 *   - ticket comments with `hidden` and `do_not_email`: every comment written
 *     here sets both, so nothing reaches the MSP's own customer;
 *   - 422 with `{ error }` or `{ message: [...] }` for invalid requests, and
 *     401 for both a bad token and a missing permission;
 *   - 180 requests a minute per IP address. How a refusal for that looks is
 *     not documented; a 429 is assumed, and treated as worth retrying.
 *
 * Unverified, to check on a real account: whether creating a ticket emails the
 * customer under the account's own notification settings; whether a problem
 * type is required; which status counts as closed in the account's workflow.
 */

/** A Syncro subdomain: the account's own name in its URL. */
export const SYNCRO_SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function syncroBaseUrl(subdomain: string): string {
  if (!SYNCRO_SUBDOMAIN.test(subdomain)) throw new Error("Not a Syncro subdomain.");
  return `https://${subdomain}.syncromsp.com/api/v1`;
}

export interface SyncroCredentials {
  subdomain: string;
  apiToken: string;
}

/**
 * Why a call failed, in words for the notifications page. `retryable` says
 * whether trying again later could help: a token can be replaced, a
 * permission granted, an outage ends; an invalid ticket stays invalid.
 */
export class PsaError extends Error {
  constructor(
    readonly kind: "auth" | "permission" | "not_found" | "invalid" | "unavailable",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PsaError";
  }
}

export interface PsaCustomer {
  id: string;
  name: string;
}

export interface PsaTicket {
  id: string;
  number: string;
  subject: string;
  status: string;
  customerId: string;
  createdAt: Date | null;
}

export interface SyncroClientOptions {
  credentials: SyncroCredentials;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Per-request timeout. Default 15 seconds. */
  timeoutMs?: number;
  /** Overrides the account's address. Tests only. */
  baseUrl?: string;
}

/** Largest response read. A page of 100 customers is well under this. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const id = z.union([z.number().int(), z.string().min(1).max(40)]).transform(String);
const text = z
  .string()
  .nullish()
  .transform((v) => v ?? "");

const ticketSchema = z.object({
  id,
  number: z
    .union([z.number(), z.string()])
    .nullish()
    .transform((v) => (v == null ? "" : String(v))),
  subject: text,
  status: text,
  customer_id: id,
  created_at: z.string().nullish(),
});
const ticketEnvelope = z.object({ ticket: ticketSchema });
const ticketList = z.object({
  tickets: z.array(ticketSchema),
  meta: z.object({ total_pages: z.number().int().nonnegative() }).partial().optional(),
});
const customerList = z.object({
  customers: z.array(
    z.object({
      id,
      business_then_name: z.string().nullish(),
      business_name: z.string().nullish(),
      fullname: z.string().nullish(),
      firstname: z.string().nullish(),
      lastname: z.string().nullish(),
      disabled: z.boolean().nullish(),
    }),
  ),
  meta: z.object({ total_pages: z.number().int().nonnegative() }).partial().optional(),
});
const meSchema = z.object({ user_name: z.string().nullish(), subdomain: z.string().nullish() });
const ticketSettings = z.object({ ticket_status_list: z.array(z.string()).optional() });
const accountSettings = z.object({
  ticket: z.object({ problem_types: z.array(z.string()).optional() }).optional(),
});

/** Reads an answer in the shape the reference shows, or fails saying it was not. */
function shape<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new PsaError("invalid", "Syncro's answer was not in the expected shape.", false);
  }
  return parsed.data;
}

function toTicket(row: z.infer<typeof ticketSchema>): PsaTicket {
  const created = row.created_at ? new Date(row.created_at) : null;
  return {
    id: row.id,
    number: row.number,
    subject: row.subject,
    status: row.status,
    customerId: row.customer_id,
    createdAt: created && !Number.isNaN(created.getTime()) ? created : null,
  };
}

/** A customer's name as Syncro shows it: the business, else the person. */
function customerName(row: z.infer<typeof customerList>["customers"][number]): string {
  const name =
    row.business_then_name ??
    row.business_name ??
    row.fullname ??
    [row.firstname, row.lastname].filter(Boolean).join(" ");
  return name?.trim() || `Customer ${row.id}`;
}

/** Syncro's own words about an invalid request, made safe to show: one line, short, printable. */
export function syncroMessage(body: unknown): string | null {
  const parsed = z
    .object({
      error: z.string().optional(),
      message: z.union([z.string(), z.array(z.string())]).optional(),
    })
    .safeParse(body);
  if (!parsed.success) return null;
  const raw = parsed.data.error ?? [parsed.data.message ?? []].flat().join("; ");
  const clean = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean ? clean.slice(0, 200) : null;
}

export class SyncroClient {
  readonly #token: string;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #logger: Logger | undefined;
  readonly #timeoutMs: number;

  constructor(options: SyncroClientOptions) {
    const token = options.credentials.apiToken.trim();
    if (!token) throw new Error("A Syncro API token is required.");
    this.#token = token;
    this.#base = (options.baseUrl ?? syncroBaseUrl(options.credentials.subdomain)).replace(
      /\/+$/,
      "",
    );
    this.#fetch = options.fetch ?? fetch;
    this.#logger = options.logger;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** The user the token belongs to. Proves the subdomain and token work. */
  async me(): Promise<{ userName: string | null }> {
    const body = shape(meSchema, await this.#request("GET", "/me"));
    return { userName: body.user_name ?? null };
  }

  /** The account's ticket statuses and problem types, for choosing from. */
  async ticketOptions(): Promise<{ statuses: string[]; problemTypes: string[] }> {
    const tickets = shape(ticketSettings, await this.#request("GET", "/tickets/settings"));
    const account = shape(accountSettings, await this.#request("GET", "/settings"));
    return {
      statuses: tickets.ticket_status_list ?? [],
      problemTypes: account.ticket?.problem_types ?? [],
    };
  }

  /**
   * Customers, enabled ones only, in Syncro's order. Stops after `maxPages`;
   * `complete` says whether every page was read.
   */
  async listCustomers(options: { maxPages?: number } = {}): Promise<{
    customers: PsaCustomer[];
    complete: boolean;
  }> {
    const maxPages = options.maxPages ?? 40;
    const customers: PsaCustomer[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const body = shape(customerList, await this.#request("GET", "/customers", { page }));
      for (const row of body.customers) {
        if (!row.disabled) customers.push({ id: row.id, name: customerName(row) });
      }
      const total = body.meta?.total_pages ?? 1;
      if (page >= total || body.customers.length === 0) return { customers, complete: true };
    }
    return { customers, complete: false };
  }

  /** Opens a ticket whose first comment is hidden from the customer and not emailed. */
  async createTicket(input: {
    customerId: string;
    subject: string;
    problemType?: string | undefined;
    comment: { subject: string; body: string };
  }): Promise<PsaTicket> {
    const body = await this.#request("POST", "/tickets", undefined, {
      customer_id: Number(input.customerId),
      subject: input.subject,
      ...(input.problemType ? { problem_type: input.problemType } : {}),
      comments_attributes: [{ ...this.#comment(input.comment) }],
    });
    return toTicket(shape(ticketEnvelope, body).ticket);
  }

  /** Adds a comment hidden from the customer and not emailed to them. */
  async addComment(ticketId: string, comment: { subject: string; body: string }): Promise<void> {
    await this.#request(
      "POST",
      `/tickets/${encodeURIComponent(ticketId)}/comment`,
      undefined,
      this.#comment(comment),
    );
  }

  /** A ticket, or null if it no longer exists. */
  async getTicket(ticketId: string): Promise<PsaTicket | null> {
    try {
      return toTicket(
        shape(
          ticketEnvelope,
          await this.#request("GET", `/tickets/${encodeURIComponent(ticketId)}`),
        ).ticket,
      );
    } catch (error) {
      if (error instanceof PsaError && error.kind === "not_found") return null;
      throw error;
    }
  }

  async setStatus(ticketId: string, status: string): Promise<void> {
    await this.#request("PUT", `/tickets/${encodeURIComponent(ticketId)}`, undefined, { status });
  }

  /** A customer's tickets created on or after a day, up to a few pages. */
  async findTickets(input: {
    customerId: string;
    createdAfter: Date;
    maxPages?: number;
  }): Promise<PsaTicket[]> {
    const tickets: PsaTicket[] = [];
    const maxPages = input.maxPages ?? 4;
    for (let page = 1; page <= maxPages; page += 1) {
      const body = shape(
        ticketList,
        await this.#request("GET", "/tickets", {
          customer_id: input.customerId,
          created_after: input.createdAfter.toISOString().slice(0, 10),
          page,
        }),
      );
      tickets.push(...body.tickets.map(toTicket));
      if (page >= (body.meta?.total_pages ?? 1) || body.tickets.length === 0) break;
    }
    return tickets;
  }

  #comment(comment: { subject: string; body: string }) {
    return {
      subject: comment.subject.slice(0, 250),
      body: comment.body,
      hidden: true,
      do_not_email: true,
    };
  }

  async #request(
    method: "GET" | "POST" | "PUT",
    path: string,
    query?: Record<string, string | number>,
    json?: unknown,
  ): Promise<unknown> {
    const url = new URL(`${this.#base}${path}`);
    for (const [key, value] of Object.entries(query ?? {}))
      url.searchParams.set(key, String(value));
    const started = Date.now();
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: "application/json",
          "user-agent": `${brand.name}-PSA/1`,
          ...(json === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      const timedOut =
        cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
      throw new PsaError(
        "unavailable",
        timedOut ? "Syncro did not answer in time." : "Syncro could not be reached.",
        true,
      );
    }
    const raw = await readCapped(response);
    // Method, path without query, status and time. Never headers or bodies.
    this.#logger?.debug(
      {
        method,
        path: path.replace(/\/\d+(?=\/|$)/g, "/:id"),
        status: response.status,
        ms: Date.now() - started,
      },
      "syncro request",
    );
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    if (response.ok) {
      if (body === null)
        throw new PsaError("unavailable", "Syncro sent an answer that could not be read.", true);
      return body;
    }
    throw failureFor(response.status, body);
  }
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new PsaError("unavailable", "Syncro sent more than expected.", true);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** What a refusal means, in words for the notifications page. */
export function failureFor(status: number, body: unknown): PsaError {
  const said = syncroMessage(body);
  if (status === 401 && said && /permission/i.test(said)) {
    return new PsaError(
      "permission",
      "The Syncro user whose API token this is lacks a permission this needs. An owner of the Syncro account can grant it.",
      true,
    );
  }
  if (status === 401) {
    return new PsaError("auth", "Syncro refused the API token. Replace it on the channel.", true);
  }
  if (status === 403) {
    return new PsaError("permission", "Syncro refused this request for lack of permission.", true);
  }
  if (status === 404) return new PsaError("not_found", "Syncro has no such record.", false);
  if (status === 429)
    return new PsaError("unavailable", "Syncro is limiting how fast requests are made.", true);
  if (status >= 500)
    return new PsaError("unavailable", "Syncro had a problem. It will be tried again.", true);
  return new PsaError(
    "invalid",
    said ? `Syncro refused the request: ${said}` : `Syncro refused the request (${status}).`,
    false,
  );
}
