import { randomUUID } from "node:crypto";
import { createDb, type Db } from "@valtrexia/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { handleClerkEvent, isHandledEvent, type ClerkEvent } from "./clerk-webhook";
import { resolveSession } from "./session-core";

const urls = inject("databaseUrls");
let db: Db;
beforeAll(() => {
  db = createDb({ url: urls.app });
});
afterAll(async () => {
  await db.disconnect();
});

const org = () => ({ id: `org_${randomUUID()}`, name: "Northwind IT Services" });

function membership(
  type: "organizationMembership.created" | "organizationMembership.updated",
  organization: { id: string; name: string },
  userId: string,
  role = "org:member",
): ClerkEvent {
  return {
    type,
    data: {
      organization,
      role,
      public_user_data: {
        user_id: userId,
        identifier: "tech@msp.example",
        first_name: "Alex",
        last_name: "Tech",
      },
    },
  };
}

const usersOf = (tenantId: string) => db.withTenant(tenantId, ({ tx }) => tx.user.findMany());
const auditOf = (tenantId: string) =>
  db.withTenant(tenantId, async ({ tx }) =>
    (await tx.auditLog.findMany({ orderBy: { createdAt: "asc" } })).map((e) => e.action),
  );

describe("clerk webhook: which events are handled", () => {
  it("recognizes the organization and membership events and nothing else", () => {
    for (const type of [
      "organization.created",
      "organization.updated",
      "organization.deleted",
      "organizationMembership.created",
      "organizationMembership.updated",
      "organizationMembership.deleted",
    ]) {
      expect(isHandledEvent({ type })).toBe(true);
    }
    for (const type of ["user.created", "session.created", "email.created", ""]) {
      expect(isHandledEvent({ type })).toBe(false);
    }
  });
});

describe("clerk webhook: organizations", () => {
  it("provisions a tenant when an organization is created, once", async () => {
    const o = org();
    expect(await handleClerkEvent(db, { type: "organization.created", data: o })).toBe(
      "tenant-provisioned",
    );
    const tenantId = await db.resolveTenantId(o.id);
    expect(tenantId).not.toBeNull();
    // Redelivery is harmless.
    await handleClerkEvent(db, { type: "organization.created", data: o });
    expect(await db.resolveTenantId(o.id)).toBe(tenantId);
  });

  it("renames the tenant when the organization is renamed", async () => {
    const o = org();
    await handleClerkEvent(db, { type: "organization.created", data: o });
    const renamed = {
      type: "organization.updated",
      data: { ...o, name: "Northwind Group" },
    } as const;
    expect(await handleClerkEvent(db, renamed)).toBe("tenant-renamed");
    expect(await handleClerkEvent(db, renamed)).toBe("ignored");

    const tenantId = (await db.resolveTenantId(o.id))!;
    const tenant = await db.withTenant(tenantId, ({ tx }) =>
      tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    );
    expect(tenant.name).toBe("Northwind Group");
  });

  it("handles an update that arrives before the create", async () => {
    const o = org();
    await handleClerkEvent(db, { type: "organization.updated", data: o });
    expect(await db.resolveTenantId(o.id)).not.toBeNull();
  });

  it("does not delete a tenant's data when its organization is deleted", async () => {
    const o = org();
    await handleClerkEvent(db, membership("organizationMembership.created", o, "user_1"));
    expect(await handleClerkEvent(db, { type: "organization.deleted", data: { id: o.id } })).toBe(
      "noted",
    );
    const tenantId = (await db.resolveTenantId(o.id))!;
    expect(await usersOf(tenantId)).toHaveLength(1);
  });
});

describe("clerk webhook: memberships", () => {
  it("creates the tenant and the user when the membership arrives first", async () => {
    const o = org();
    expect(
      await handleClerkEvent(
        db,
        membership("organizationMembership.created", o, "user_a", "org:admin"),
      ),
    ).toBe("user-synced");
    const tenantId = (await db.resolveTenantId(o.id))!;
    expect(await usersOf(tenantId)).toMatchObject([
      { clerkUserId: "user_a", email: "tech@msp.example", name: "Alex Tech", role: "owner" },
    ]);
    expect(await auditOf(tenantId)).toEqual(["user.joined"]);
  });

  it("is idempotent under redelivery", async () => {
    const o = org();
    const event = membership("organizationMembership.created", o, "user_b");
    await handleClerkEvent(db, event);
    await handleClerkEvent(db, event);
    await handleClerkEvent(db, event);
    const tenantId = (await db.resolveTenantId(o.id))!;
    expect(await usersOf(tenantId)).toHaveLength(1);
    expect(await auditOf(tenantId)).toEqual(["user.joined"]);
  });

  it("follows a role change", async () => {
    const o = org();
    await handleClerkEvent(db, membership("organizationMembership.created", o, "user_c"));
    await handleClerkEvent(
      db,
      membership("organizationMembership.updated", o, "user_c", "org:admin"),
    );
    const tenantId = (await db.resolveTenantId(o.id))!;
    expect((await usersOf(tenantId))[0]).toMatchObject({ role: "owner" });
    expect(await auditOf(tenantId)).toEqual(["user.joined", "user.role_changed"]);
  });

  it("deactivates a removed member but keeps the row, and reactivates on return", async () => {
    const o = org();
    await handleClerkEvent(db, membership("organizationMembership.created", o, "user_d"));
    const removal: ClerkEvent = {
      type: "organizationMembership.deleted",
      data: { organization: { id: o.id }, public_user_data: { user_id: "user_d" } },
    };
    expect(await handleClerkEvent(db, removal)).toBe("user-deactivated");
    expect(await handleClerkEvent(db, removal)).toBe("ignored");

    const tenantId = (await db.resolveTenantId(o.id))!;
    const [removed] = await usersOf(tenantId);
    expect(removed?.deactivatedAt).not.toBeNull();

    await handleClerkEvent(db, membership("organizationMembership.created", o, "user_d"));
    const [back] = await usersOf(tenantId);
    expect(back).toMatchObject({ id: removed!.id, deactivatedAt: null });
    expect(await auditOf(tenantId)).toEqual([
      "user.joined",
      "user.deactivated",
      "user.reactivated",
    ]);
  });

  it("ignores a removal for an organization or user it has never seen", async () => {
    expect(
      await handleClerkEvent(db, {
        type: "organizationMembership.deleted",
        data: { organization: { id: "org_unknown" }, public_user_data: { user_id: "user_x" } },
      }),
    ).toBe("ignored");
  });

  it("agrees with sign-in: webhook then sign-in yields one user, not two", async () => {
    const o = org();
    await handleClerkEvent(
      db,
      membership("organizationMembership.created", o, "user_e", "org:admin"),
    );
    const decision = await resolveSession(
      db,
      {
        clerkUserId: "user_e",
        clerkOrgId: o.id,
        orgRole: "org:admin",
        factorVerificationAge: [1, 1],
      },
      {
        getUser: async () => ({ email: "x@y.example", name: null, twoFactorEnabled: true }),
        getOrganizationName: async () => o.name,
      },
    );
    if (decision.kind !== "ok") throw new Error("expected ok");
    const users = await usersOf(decision.session.tenantId);
    expect(users).toHaveLength(1);
    expect(users[0]!.id).toBe(decision.session.userId);
  });

  it("writes one tenant's members only into that tenant", async () => {
    const one = org();
    const two = org();
    await handleClerkEvent(db, membership("organizationMembership.created", one, "user_f"));
    await handleClerkEvent(db, membership("organizationMembership.created", two, "user_g"));
    const [a, b] = await Promise.all([
      usersOf((await db.resolveTenantId(one.id))!),
      usersOf((await db.resolveTenantId(two.id))!),
    ]);
    expect(a.map((u) => u.clerkUserId)).toEqual(["user_f"]);
    expect(b.map((u) => u.clerkUserId)).toEqual(["user_g"]);
  });
});
