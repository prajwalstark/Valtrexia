import { randomUUID } from "node:crypto";
import { createDb, type Db } from "@valtrexia/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  resolveSession,
  roleFromOrgRole,
  secondFactorVerified,
  type AuthSnapshot,
  type IdentityLookup,
} from "./session-core";

const urls = inject("databaseUrls");
let db: Db;
beforeAll(() => {
  db = createDb({ url: urls.app });
});
afterAll(async () => {
  await db.disconnect();
});

/** A signed-in admin who passed a second factor one minute ago. */
function snapshot(overrides: Partial<AuthSnapshot> = {}): AuthSnapshot {
  return {
    clerkUserId: `user_${randomUUID()}`,
    clerkOrgId: `org_${randomUUID()}`,
    orgRole: "org:admin",
    factorVerificationAge: [5, 1],
    ...overrides,
  };
}

function lookup(overrides: Partial<Awaited<ReturnType<IdentityLookup["getUser"]>>> = {}) {
  const calls = { getUser: 0, getOrganizationName: 0 };
  const api: IdentityLookup = {
    async getUser() {
      calls.getUser += 1;
      return {
        email: "owner@msp.example",
        name: "Sam Owner",
        twoFactorEnabled: true,
        ...overrides,
      };
    },
    async getOrganizationName() {
      calls.getOrganizationName += 1;
      return "Northwind IT Services";
    },
  };
  return { api, calls };
}

const auditActions = (tenantId: string) =>
  db.withTenant(tenantId, async ({ tx }) =>
    (await tx.auditLog.findMany({ orderBy: { createdAt: "asc" } })).map((entry) => entry.action),
  );

describe("role mapping", () => {
  it("makes organization admins owners and everyone else a technician", () => {
    expect(roleFromOrgRole("org:admin")).toBe("owner");
    expect(roleFromOrgRole("org:member")).toBe("technician");
    expect(roleFromOrgRole("org:billing")).toBe("technician");
    expect(roleFromOrgRole("admin")).toBe("technician");
    expect(roleFromOrgRole("")).toBe("technician");
    expect(roleFromOrgRole(null)).toBe("technician");
  });
});

describe("second factor from the session token", () => {
  it("is verified only when the second age is zero or more", () => {
    expect(secondFactorVerified([10, 0])).toBe(true);
    expect(secondFactorVerified([10, 3])).toBe(true);
    expect(secondFactorVerified([10, -1])).toBe(false);
    expect(secondFactorVerified([-1, -1])).toBe(false);
    expect(secondFactorVerified(null)).toBe(false);
    expect(secondFactorVerified([10, Number.NaN])).toBe(false);
  });
});

describe("resolveSession: gates, in order", () => {
  it("is signed-out with no user, and touches nothing", async () => {
    const { api, calls } = lookup();
    const decision = await resolveSession(db, snapshot({ clerkUserId: null }), api);
    expect(decision).toEqual({ kind: "signed-out" });
    expect(calls).toEqual({ getUser: 0, getOrganizationName: 0 });
  });

  it("requires MFA when no second factor was used and none is enrolled", async () => {
    const auth = snapshot({ factorVerificationAge: [5, -1] });
    const { api } = lookup({ twoFactorEnabled: false });
    expect(await resolveSession(db, auth, api)).toEqual({ kind: "mfa-required" });
    // Nothing was provisioned for someone who has not passed MFA.
    expect(await db.resolveTenantId(auth.clerkOrgId!)).toBeNull();
  });

  it("requires MFA when the token carries no factor information and none is enrolled", async () => {
    const { api } = lookup({ twoFactorEnabled: false });
    const decision = await resolveSession(db, snapshot({ factorVerificationAge: null }), api);
    expect(decision).toEqual({ kind: "mfa-required" });
  });

  it("checks MFA before anything else, even with no organization selected", async () => {
    const { api } = lookup({ twoFactorEnabled: false });
    const auth = snapshot({ clerkOrgId: null, factorVerificationAge: [5, -1] });
    expect(await resolveSession(db, auth, api)).toEqual({ kind: "mfa-required" });
  });

  it("accepts a second factor proven by the token without asking the identity provider", async () => {
    const auth = snapshot();
    const first = lookup();
    await resolveSession(db, auth, first.api); // creates tenant and user
    const second = lookup();
    const decision = await resolveSession(db, auth, second.api);
    expect(decision.kind).toBe("ok");
    expect(second.calls).toEqual({ getUser: 0, getOrganizationName: 0 });
  });

  it("accepts an enrolled second factor when the token does not prove one", async () => {
    const { api } = lookup({ twoFactorEnabled: true });
    const decision = await resolveSession(db, snapshot({ factorVerificationAge: [5, -1] }), api);
    expect(decision.kind).toBe("ok");
  });

  it("sends someone with no organization to onboarding", async () => {
    const { api } = lookup();
    expect(await resolveSession(db, snapshot({ clerkOrgId: null }), api)).toEqual({
      kind: "no-organization",
    });
  });
});

describe("resolveSession: tenants and users", () => {
  it("creates the tenant and the first user on first sign-in, and audits both", async () => {
    const auth = snapshot();
    const { api, calls } = lookup();
    const decision = await resolveSession(db, auth, api, { ip: "203.0.113.7" });

    expect(decision.kind).toBe("ok");
    if (decision.kind !== "ok") return;
    const { tenantId, userId } = decision.session;
    expect(decision.session).toMatchObject({ clerkUserId: auth.clerkUserId, role: "owner" });
    expect(await db.resolveTenantId(auth.clerkOrgId!)).toBe(tenantId);
    expect(calls).toEqual({ getUser: 1, getOrganizationName: 1 });

    const { tenant, user, audit } = await db.withTenant(tenantId, async ({ tx }) => ({
      tenant: await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
      user: await tx.user.findUniqueOrThrow({ where: { id: userId } }),
      audit: await tx.auditLog.findMany({ orderBy: { createdAt: "asc" } }),
    }));
    expect(tenant.name).toBe("Northwind IT Services");
    expect(user).toMatchObject({ email: "owner@msp.example", name: "Sam Owner", role: "owner" });
    expect(audit.map((entry) => entry.action).sort()).toEqual([
      "tenant.provisioned",
      "user.joined",
    ]);
    for (const entry of audit) {
      expect(entry).toMatchObject({ actorType: "user", actorUserId: userId, ip: "203.0.113.7" });
    }
  });

  it("is stable: the same person gets the same tenant and user every time", async () => {
    const auth = snapshot();
    const first = await resolveSession(db, auth, lookup().api);
    const second = await resolveSession(db, auth, lookup().api);
    const third = await resolveSession(db, auth, lookup().api);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    if (first.kind !== "ok") throw new Error("expected ok");
    expect(await auditActions(first.session.tenantId)).toHaveLength(2);
  });

  it("adds a second member to an existing tenant as a technician", async () => {
    const owner = snapshot();
    const first = await resolveSession(db, owner, lookup().api);
    const member = snapshot({ clerkOrgId: owner.clerkOrgId, orgRole: "org:member" });
    const { api, calls } = lookup({ email: "tech@msp.example", name: null });
    const second = await resolveSession(db, member, api);

    if (first.kind !== "ok" || second.kind !== "ok") throw new Error("expected ok");
    expect(second.session.tenantId).toBe(first.session.tenantId);
    expect(second.session.userId).not.toBe(first.session.userId);
    expect(second.session.role).toBe("technician");
    // The tenant already existed, so the organization was not looked up again.
    expect(calls.getOrganizationName).toBe(0);
  });

  it("follows a role change made in the identity provider, and audits it", async () => {
    const auth = snapshot({ orgRole: "org:member" });
    const before = await resolveSession(db, auth, lookup().api);
    const after = await resolveSession(db, { ...auth, orgRole: "org:admin" }, lookup().api);

    if (before.kind !== "ok" || after.kind !== "ok") throw new Error("expected ok");
    expect(before.session.role).toBe("technician");
    expect(after.session).toMatchObject({ userId: before.session.userId, role: "owner" });
    expect(await auditActions(after.session.tenantId)).toContain("user.role_changed");

    const demoted = await resolveSession(db, { ...auth, orgRole: "org:member" }, lookup().api);
    expect(demoted).toMatchObject({ session: { role: "technician" } });
  });

  it("keeps two organizations as two tenants, even for the same person", async () => {
    const person = `user_${randomUUID()}`;
    const one = await resolveSession(db, snapshot({ clerkUserId: person }), lookup().api);
    const two = await resolveSession(db, snapshot({ clerkUserId: person }), lookup().api);
    if (one.kind !== "ok" || two.kind !== "ok") throw new Error("expected ok");
    expect(two.session.tenantId).not.toBe(one.session.tenantId);
    expect(two.session.userId).not.toBe(one.session.userId);

    // Each tenant sees exactly one user: its own row for this person.
    for (const { session } of [one, two]) {
      const users = await db.withTenant(session.tenantId, ({ tx }) => tx.user.findMany());
      expect(users.map((u) => u.id)).toEqual([session.userId]);
    }
  });

  it("derives the tenant only from the session's organization", async () => {
    const victim = await resolveSession(db, snapshot(), lookup().api);
    const attacker = snapshot();
    const decision = await resolveSession(db, attacker, lookup().api);
    if (victim.kind !== "ok" || decision.kind !== "ok") throw new Error("expected ok");
    // There is no input through which the attacker could have named the victim's tenant.
    expect(decision.session.tenantId).not.toBe(victim.session.tenantId);
    expect(Object.keys(attacker).sort()).toEqual(
      ["clerkOrgId", "clerkUserId", "factorVerificationAge", "orgRole"].sort(),
    );
  });

  it("concurrent first requests all succeed and agree", async () => {
    const auth = snapshot();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => resolveSession(db, auth, lookup().api)),
    );
    expect(results.map((r) => r.status)).toEqual(Array(8).fill("fulfilled"));
    const sessions = results.map((r) => (r.status === "fulfilled" ? r.value : null));
    expect(new Set(sessions.map((s) => JSON.stringify(s))).size).toBe(1);
    const settled = await resolveSession(db, auth, lookup().api);
    if (settled.kind !== "ok") throw new Error("expected ok");
    const users = await db.withTenant(settled.session.tenantId, ({ tx }) => tx.user.findMany());
    expect(users).toHaveLength(1);
  });
});

describe("resolveSession: losing the race to create the user", () => {
  // Whether two real transactions collide depends on timing, so the collision
  // is staged: a database handle whose second transaction (the one that
  // writes the user) fails as a unique-constraint violation would, optionally
  // after another request has already created the row.
  function losingDb(beforeFailing: () => Promise<void>): Db {
    let transactions = 0;
    return {
      ...db,
      withTenant: async (tenantId, fn, options) => {
        transactions += 1;
        if (transactions === 2) {
          await beforeFailing();
          throw new Error("Unique constraint failed on users_tenant_id_clerk_user_id_key");
        }
        return db.withTenant(tenantId, fn, options);
      },
    };
  }

  it("reads the winner's row instead of failing", async () => {
    const auth = snapshot();
    let winner: Awaited<ReturnType<typeof resolveSession>> | undefined;
    const racing = losingDb(async () => {
      winner = await resolveSession(db, auth, lookup().api);
    });

    const loser = await resolveSession(racing, auth, lookup().api);
    expect(loser.kind).toBe("ok");
    expect(loser).toEqual(winner);
  });

  it("still fails when the write failed and no row exists", async () => {
    const racing = losingDb(async () => undefined);
    await expect(resolveSession(racing, snapshot(), lookup().api)).rejects.toThrow(
      /Unique constraint/,
    );
  });

  it("still fails when the existing row does not match the session's role", async () => {
    const auth = snapshot({ orgRole: "org:admin" });
    const racing = losingDb(async () => {
      // The row that exists was written for a different role.
      await resolveSession(db, { ...auth, orgRole: "org:member" }, lookup().api);
    });
    await expect(resolveSession(racing, auth, lookup().api)).rejects.toThrow(/Unique constraint/);
  });
});
