import { describe, expect, it } from "vitest";
import { brand } from "../brand";
import { FAKE_SYNCRO_BASE, FAKE_SYNCRO_TOKEN, fakeSyncro } from "./syncro-fixtures";
import { failureFor, SYNCRO_SUBDOMAIN, SyncroClient, syncroBaseUrl, syncroMessage } from "./syncro";

const credentials = { subdomain: "northwind", apiToken: FAKE_SYNCRO_TOKEN };
const client = (fake = fakeSyncro()) => ({
  fake,
  syncro: new SyncroClient({ credentials, fetch: fake.fetch, baseUrl: FAKE_SYNCRO_BASE }),
});

describe("Syncro addresses", () => {
  it("accepts account names only, so the host cannot be steered elsewhere", () => {
    expect(syncroBaseUrl("northwind")).toBe("https://northwind.syncromsp.com/api/v1");
    for (const ok of ["acme", "acme-it", "a1"]) expect(SYNCRO_SUBDOMAIN.test(ok)).toBe(true);
    for (const bad of [
      "",
      "-acme",
      "acme-",
      "Acme",
      "acme.evil.com",
      "evil.com#",
      "acme/..",
      "a b",
      "x".repeat(64),
    ]) {
      expect(SYNCRO_SUBDOMAIN.test(bad), bad).toBe(false);
      expect(() => syncroBaseUrl(bad)).toThrow();
    }
  });
});

describe("SyncroClient", () => {
  it("sends the token as a bearer token, with a User-Agent, and reads the user", async () => {
    const { fake, syncro } = client();
    expect(await syncro.me()).toEqual({ userName: "Joe Doe" });
    const [request] = fake.requests;
    expect(request!.headers.get("authorization")).toBe(`Bearer ${FAKE_SYNCRO_TOKEN}`);
    expect(request!.headers.get("user-agent")).toBe(`${brand.name}-PSA/1`);
  });

  it("reads statuses and problem types", async () => {
    const { syncro } = client();
    const options = await syncro.ticketOptions();
    expect(options.statuses).toContain("Resolved");
    expect(options.problemTypes).toEqual(["Virus", "TuneUp", "Hardware", "Software", "Other"]);
  });

  it("lists customers across pages by meta.total_pages, names people as well as businesses, and skips disabled ones", async () => {
    const fake = fakeSyncro({ customers: 60, perPage: 25 });
    fake.customers[5]!.disabled = true;
    const { syncro } = client(fake);
    const { customers, complete } = await syncro.listCustomers();
    expect(complete).toBe(true);
    expect(customers).toHaveLength(59);
    expect(customers[0]).toEqual({ id: "100", name: "Acme Dental" });
    expect(customers[1]).toEqual({ id: "101", name: "Jo Bloggs" });
    expect(fake.requests.map((r) => r.query.get("page"))).toEqual(["1", "2", "3"]);
  });

  it("stops at a page limit and says the list is incomplete", async () => {
    const { syncro } = client(fakeSyncro({ customers: 60, perPage: 25 }));
    const { customers, complete } = await syncro.listCustomers({ maxPages: 2 });
    expect(customers).toHaveLength(50);
    expect(complete).toBe(false);
  });

  it("creates a ticket whose first comment is hidden and not emailed, then comments and resolves it the same way", async () => {
    const { fake, syncro } = client();
    const ticket = await syncro.createTicket({
      customerId: "100",
      subject: "Backup failed: SRV01",
      problemType: "Other",
      comment: { subject: "Backup failed", body: "Details" },
    });
    expect(ticket).toMatchObject({ id: "1", number: "1001", status: "New", customerId: "100" });
    await syncro.addComment(ticket.id, { subject: "Resolved", body: "A backup completed." });
    await syncro.setStatus(ticket.id, "Resolved");
    const stored = fake.tickets[0]!;
    expect(stored.problem_type).toBe("Other");
    expect(stored.status).toBe("Resolved");
    expect(stored.comments).toEqual([
      { subject: "Backup failed", body: "Details", hidden: true, do_not_email: true },
      { subject: "Resolved", body: "A backup completed.", hidden: true, do_not_email: true },
    ]);
    expect((await syncro.getTicket(ticket.id))!.status).toBe("Resolved");
    expect(await syncro.getTicket("999")).toBeNull();
  });

  it("finds a customer's recent tickets", async () => {
    const fake = fakeSyncro();
    fake.now = () => new Date("2026-11-20T10:00:00Z");
    const { syncro } = client(fake);
    await syncro.createTicket({
      customerId: "100",
      subject: "A",
      comment: { subject: "s", body: "b" },
    });
    await syncro.createTicket({
      customerId: "101",
      subject: "B",
      comment: { subject: "s", body: "b" },
    });
    const found = await syncro.findTickets({
      customerId: "100",
      createdAfter: new Date("2026-11-19T00:00:00Z"),
    });
    expect(found.map((t) => t.subject)).toEqual(["A"]);
    expect(fake.requests.at(-1)!.query.get("created_after")).toBe("2026-11-19");
  });

  it("names each kind of failure, and says whether trying again can help", async () => {
    const wrongToken = new SyncroClient({
      credentials: { subdomain: "northwind", apiToken: "wrong" },
      fetch: fakeSyncro().fetch,
      baseUrl: FAKE_SYNCRO_BASE,
    });
    await expect(wrongToken.me()).rejects.toMatchObject({ kind: "auth", retryable: true });

    const fake = fakeSyncro();
    fake.deny.add("POST /tickets");
    const { syncro } = client(fake);
    await expect(
      syncro.createTicket({
        customerId: "100",
        subject: "x",
        comment: { subject: "s", body: "b" },
      }),
    ).rejects.toMatchObject({ kind: "permission", retryable: true });

    const { syncro: strict } = client(fakeSyncro({ requireProblemType: true }));
    const invalid = strict.createTicket({
      customerId: "100",
      subject: "x",
      comment: { subject: "s", body: "b" },
    });
    await expect(invalid).rejects.toMatchObject({
      kind: "invalid",
      retryable: false,
      message: "Syncro refused the request: Problem type can't be blank",
    });

    const flaky = fakeSyncro();
    flaky.failNext({ status: 429 }, { status: 503 }, { status: 0 });
    const { syncro: busy } = client(flaky);
    for (let i = 0; i < 3; i += 1) {
      await expect(busy.me()).rejects.toMatchObject({ kind: "unavailable", retryable: true });
    }
    expect(await busy.me()).toEqual({ userName: "Joe Doe" });
  });

  it("refuses an answer in an unexpected shape, and a redirect", async () => {
    const odd = new SyncroClient({
      credentials,
      baseUrl: FAKE_SYNCRO_BASE,
      fetch: (async () => Response.json({ tickets: "nope" })) as typeof fetch,
    });
    await expect(
      odd.findTickets({ customerId: "1", createdAfter: new Date() }),
    ).rejects.toMatchObject({
      kind: "invalid",
    });
    let redirect: RequestInit["redirect"];
    const spy = new SyncroClient({
      credentials,
      baseUrl: FAKE_SYNCRO_BASE,
      fetch: (async (_url: unknown, init?: RequestInit) => {
        redirect = init?.redirect;
        return Response.json({ user_name: "x" });
      }) as typeof fetch,
    });
    await spy.me();
    expect(redirect).toBe("error");
  });

  it("shows Syncro's own words on one line", async () => {
    const fake = fakeSyncro();
    fake.failNext({ status: 422, body: { error: "Subject\ncan't be blank" } });
    const { syncro } = client(fake);
    await expect(syncro.me()).rejects.toMatchObject({
      message: "Syncro refused the request: Subject can't be blank",
    });
  });
});

describe("failureFor and syncroMessage", () => {
  it("reads both 422 shapes from the reference, and nothing else", () => {
    expect(syncroMessage({ error: "Customer required field" })).toBe("Customer required field");
    expect(
      syncroMessage({ success: false, message: ["Body can't be blank", "Subject can't be blank"] }),
    ).toBe("Body can't be blank; Subject can't be blank");
    expect(syncroMessage("<html>")).toBeNull();
    expect(syncroMessage({ error: "x".repeat(500) })).toHaveLength(200);
    expect(failureFor(404, null)).toMatchObject({ kind: "not_found", retryable: false });
    expect(failureFor(502, null)).toMatchObject({ kind: "unavailable", retryable: true });
    expect(failureFor(400, null).message).toBe("Syncro refused the request (400).");
  });
});
