/**
 * A stand-in for the parts of Syncro's API that tickets use, for tests,
 * built from Syncro's OpenAPI document and its examples: bearer tokens,
 * `meta.total_pages` paging, `{ ticket }` and `{ comment }` envelopes, 422
 * with `{ error }` or `{ success: false, message: [...] }`, and 401 with
 * `{ error }` for a missing permission. Not Syncro: where the reference is
 * silent (rate limiting, which fields an account requires), this is a guess
 * made explicit in options.
 */
export const FAKE_SYNCRO_TOKEN = "T0kenFake-0123456789abcdef";
export const FAKE_SYNCRO_BASE = "https://northwind.syncromsp.com/api/v1";

export interface FakeTicket {
  id: number;
  number: number;
  subject: string;
  status: string;
  customer_id: number;
  problem_type: string | null;
  created_at: string;
  comments: { subject: string; body: string; hidden: boolean; do_not_email: boolean }[];
}

export interface FakeSyncro {
  fetch: typeof fetch;
  customers: {
    id: number;
    business_name: string | null;
    firstname: string;
    lastname: string;
    disabled: boolean;
  }[];
  tickets: FakeTicket[];
  requests: {
    method: string;
    path: string;
    query: URLSearchParams;
    headers: Headers;
    body: unknown;
  }[];
  /**
   * Makes the next requests fail. `afterApplying` fails after doing the work,
   * as when Syncro creates a ticket but the answer is lost on the way back.
   */
  failNext(...failures: { status: number; body?: unknown; afterApplying?: boolean }[]): void;
  /** What the account lacks permission for, by "METHOD /path-prefix". */
  deny: Set<string>;
  /** The time tickets are stamped with. */
  now: () => Date;
}

export function fakeSyncro(
  options: {
    token?: string;
    base?: string;
    perPage?: number;
    customers?: number;
    requireProblemType?: boolean;
    problemTypes?: string[];
    statuses?: string[];
  } = {},
): FakeSyncro {
  const token = options.token ?? FAKE_SYNCRO_TOKEN;
  const base = options.base ?? FAKE_SYNCRO_BASE;
  const perPage = options.perPage ?? 25;
  const problemTypes = options.problemTypes ?? ["Virus", "TuneUp", "Hardware", "Software", "Other"];
  const statuses = options.statuses ?? [
    "New",
    "In Progress",
    "Resolved",
    "Invoiced",
    "Waiting for Parts",
    "Waiting on Customer",
    "Scheduled",
    "Customer Reply",
  ];
  const customers: FakeSyncro["customers"] = Array.from(
    { length: options.customers ?? 3 },
    (_, i) => ({
      id: 100 + i,
      business_name: i === 0 ? "Acme Dental" : i === 1 ? null : `Customer ${i}`,
      firstname: i === 1 ? "Jo" : "",
      lastname: i === 1 ? "Bloggs" : "",
      disabled: false,
    }),
  );
  const tickets: FakeTicket[] = [];
  const requests: FakeSyncro["requests"] = [];
  const failures: { status: number; body?: unknown; afterApplying?: boolean }[] = [];
  const deny = new Set<string>();
  const state = { now: () => new Date() };

  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const page = <T>(items: T[], query: URLSearchParams) => {
    const n = Math.max(1, Number(query.get("page") ?? "1"));
    return {
      items: items.slice((n - 1) * perPage, n * perPage),
      meta: {
        total_pages: Math.max(1, Math.ceil(items.length / perPage)),
        total_entries: items.length,
        per_page: perPage,
        page: n,
      },
    };
  };
  // Comments are not part of a ticket's JSON in these answers.
  const ticketJson = (t: FakeTicket) => ({
    id: t.id,
    number: t.number,
    subject: t.subject,
    status: t.status,
    customer_id: t.customer_id,
    problem_type: t.problem_type,
    created_at: t.created_at,
  });

  const handle = (
    method: string,
    path: string,
    query: URLSearchParams,
    body: Record<string, unknown>,
  ): Response => {
    if (method === "GET" && path === "/me") {
      return json({
        user_email: "tech@example.com",
        user_name: "Joe Doe",
        user_id: 1,
        subdomain: "northwind",
      });
    }
    if (method === "GET" && path === "/tickets/settings")
      return json({ ticket_status_list: statuses });
    if (method === "GET" && path === "/settings") {
      return json({ ticket: { problem_types: problemTypes, priorities: ["", "0 Urgent"] } });
    }
    if (method === "GET" && path === "/customers") {
      const { items, meta } = page(
        customers.filter((c) => !c.disabled || query.get("include_disabled") === "true"),
        query,
      );
      return json({
        customers: items.map((c) => ({
          ...c,
          fullname: `${c.firstname} ${c.lastname}`.trim(),
          business_then_name: c.business_name ?? `${c.firstname} ${c.lastname}`.trim(),
        })),
        meta,
      });
    }
    if (method === "POST" && path === "/tickets") {
      const customer = customers.find((c) => c.id === body.customer_id);
      if (!customer) return json({ error: "Customer required field" }, 422);
      if (typeof body.subject !== "string" || body.subject.trim() === "") {
        return json({ success: false, message: ["Subject can't be blank"] }, 422);
      }
      const problem = typeof body.problem_type === "string" ? body.problem_type : null;
      if (options.requireProblemType && !problem) {
        return json({ success: false, message: ["Problem type can't be blank"] }, 422);
      }
      const comments = Array.isArray(body.comments_attributes)
        ? (body.comments_attributes as FakeTicket["comments"])
        : [];
      const ticket: FakeTicket = {
        id: tickets.length + 1,
        number: 1000 + tickets.length + 1,
        subject: body.subject,
        status: typeof body.status === "string" ? body.status : "New",
        customer_id: customer.id,
        problem_type: problem,
        created_at: state.now().toISOString(),
        comments: comments.map((c) => ({ ...c })),
      };
      tickets.push(ticket);
      return json({ ticket: ticketJson(ticket) });
    }
    const one = /^\/tickets\/(\d+)(\/comment)?$/.exec(path);
    if (one) {
      const ticket = tickets.find((t) => t.id === Number(one[1]));
      if (!ticket) return json({ error: "Not found" }, 404);
      if (one[2] && method === "POST") {
        if (!body.subject || !body.body) {
          return json(
            { success: false, message: ["Body can't be blank", "Subject can't be blank"] },
            422,
          );
        }
        ticket.comments.push({
          subject: String(body.subject),
          body: String(body.body),
          hidden: body.hidden === true,
          do_not_email: body.do_not_email === true,
        });
        return json({
          comment: {
            id: ticket.comments.length,
            ticket_id: ticket.id,
            subject: body.subject,
            body: body.body,
            hidden: body.hidden,
          },
        });
      }
      if (!one[2] && method === "GET") return json({ ticket: ticketJson(ticket) });
      if (!one[2] && method === "PUT") {
        if (typeof body.status === "string") ticket.status = body.status;
        return json({ ticket: ticketJson(ticket) });
      }
    }
    if (method === "GET" && path === "/tickets") {
      const after = query.get("created_after");
      const found = tickets
        .filter(
          (t) => !query.get("customer_id") || t.customer_id === Number(query.get("customer_id")),
        )
        .filter((t) => !after || t.created_at.slice(0, 10) >= after)
        .reverse();
      const { items, meta } = page(found, query);
      return json({ tickets: items.map(ticketJson), meta });
    }
    return json({ error: "Not found" }, 404);
  };

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    let body: Record<string, unknown> = {};
    try {
      body =
        typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    if (!url.href.startsWith(`${base}/`)) throw new TypeError("fetch failed");
    const path = url.pathname.slice(new URL(base).pathname.length);
    requests.push({ method, path, query: url.searchParams, headers, body });

    if (headers.get("authorization") !== `Bearer ${token}`) {
      return json({ error: "Invalid API key" }, 401);
    }
    for (const rule of deny) {
      const [m, prefix] = rule.split(" ");
      if (m === method && path.startsWith(prefix!)) {
        return json(
          { error: "Not authorized. Please ask account admin to update your group permissions." },
          401,
        );
      }
    }
    const failure = failures.shift();
    if (failure && !failure.afterApplying) {
      if (failure.status === 0) throw new TypeError("fetch failed");
      return json(failure.body ?? { error: "Failure" }, failure.status);
    }
    const response = handle(method, path, url.searchParams, body);
    if (failure?.afterApplying) {
      if (failure.status === 0) throw new TypeError("fetch failed");
      return json(failure.body ?? { error: "Failure" }, failure.status);
    }
    return response;
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    customers,
    tickets,
    requests,
    deny,
    failNext: (...more) => failures.push(...more),
    get now() {
      return state.now;
    },
    set now(value) {
      state.now = value;
    },
  };
}
