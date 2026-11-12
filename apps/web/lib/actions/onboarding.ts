"use server";

import { isMockAllowed } from "@valtrexia/connectors";
import { getVendor } from "@valtrexia/core";
import { Secret } from "@valtrexia/core/server";
import { createIntegration } from "@valtrexia/db";
import { headers } from "next/headers";
import { ForbiddenError, requireOwner } from "@/lib/auth";
import { getSafeDb } from "@/lib/db";
import { getKeyProvider } from "@/lib/keys";

export type ActionResult = { ok: true } | { ok: false; message: string };

/**
 * Connects the built-in demo vendor to the caller's workspace, so the
 * product can be explored without real vendor credentials. Owners only, and
 * only where demo data is switched on.
 */
export async function connectDemoData(): Promise<ActionResult> {
  let session;
  try {
    session = await requireOwner();
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, message: error.message };
    throw error; // Redirects (sign-in, MFA, onboarding) must propagate.
  }

  if (!isMockAllowed(process.env)) {
    return { ok: false, message: "Demo data is switched off in this environment." };
  }

  const name = getVendor("mock").name;
  const forwarded = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const db = await getSafeDb();
  await db.withTenant(session.tenantId, async (context) => {
    const existing = await context.tx.integration.findFirst({
      where: { vendor: "mock", name },
      select: { id: true },
    });
    if (existing) return;
    await createIntegration(context, getKeyProvider(), {
      vendor: "mock",
      name,
      // Not a secret: it only selects which generated fleet to show.
      credentials: new Secret({ seed: "demo" }),
      actorUserId: session.userId,
      ip: forwarded,
    });
  });
  return { ok: true };
}
