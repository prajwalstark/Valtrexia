import { deactivateUser, upsertUser, type Db } from "@valtrexia/db";
import { roleFromOrgRole } from "./session-core";

/**
 * The parts of Clerk's webhook events we act on, reduced to what we read.
 * The route handler verifies the signature before anything reaches here.
 */
export type ClerkEvent =
  | { type: "organization.created" | "organization.updated"; data: { id: string; name: string } }
  | { type: "organization.deleted"; data: { id?: string | undefined } }
  | {
      type: "organizationMembership.created" | "organizationMembership.updated";
      data: {
        organization: { id: string; name: string };
        role: string;
        public_user_data: {
          user_id: string;
          identifier: string;
          first_name?: string | null;
          last_name?: string | null;
        };
      };
    }
  | {
      type: "organizationMembership.deleted";
      data: { organization: { id: string }; public_user_data: { user_id: string } };
    };

export type WebhookOutcome =
  | "tenant-provisioned"
  | "tenant-renamed"
  | "user-synced"
  | "user-deactivated"
  | "noted"
  | "ignored";

const HANDLED = new Set<string>([
  "organization.created",
  "organization.updated",
  "organization.deleted",
  "organizationMembership.created",
  "organizationMembership.updated",
  "organizationMembership.deleted",
]);

export function isHandledEvent(event: { type: string }): event is ClerkEvent {
  return HANDLED.has(event.type);
}

/**
 * Keeps tenants and their members in step with Clerk. Every branch is
 * idempotent, because webhooks are delivered at least once and can arrive
 * out of order or after the user has already signed in.
 */
export async function handleClerkEvent(db: Db, event: ClerkEvent): Promise<WebhookOutcome> {
  switch (event.type) {
    case "organization.created": {
      await db.provisionTenant({ clerkOrgId: event.data.id, name: event.data.name });
      return "tenant-provisioned";
    }

    case "organization.updated": {
      const tenantId = await db.provisionTenant({
        clerkOrgId: event.data.id,
        name: event.data.name,
      });
      const renamed = await db.withTenant(tenantId, async ({ tx }) => {
        const result = await tx.tenant.updateMany({
          where: { id: tenantId, name: { not: event.data.name } },
          data: { name: event.data.name },
        });
        return result.count > 0;
      });
      return renamed ? "tenant-renamed" : "ignored";
    }

    case "organization.deleted":
      // Deliberately not automatic. Removing a tenant destroys its backup
      // history and audit trail, so it is a deliberate operator action.
      return "noted";

    case "organizationMembership.created":
    case "organizationMembership.updated": {
      const { organization, public_user_data: person, role } = event.data;
      const tenantId = await db.provisionTenant({
        clerkOrgId: organization.id,
        name: organization.name,
      });
      const name = [person.first_name, person.last_name].filter(Boolean).join(" ") || null;
      await db.withTenant(tenantId, (context) =>
        upsertUser(
          context,
          {
            clerkUserId: person.user_id,
            email: person.identifier,
            name,
            role: roleFromOrgRole(role),
          },
          { actor: "system" },
        ),
      );
      return "user-synced";
    }

    case "organizationMembership.deleted": {
      const tenantId = await db.resolveTenantId(event.data.organization.id);
      if (!tenantId) return "ignored";
      const changed = await db.withTenant(tenantId, (context) =>
        deactivateUser(context, event.data.public_user_data.user_id),
      );
      return changed ? "user-deactivated" : "ignored";
    }
  }
}
