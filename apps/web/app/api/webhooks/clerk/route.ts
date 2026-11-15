import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { createLogger } from "@valtrexia/core/server";
import type { NextRequest } from "next/server";
import { handleClerkEvent, isHandledEvent } from "@/lib/clerk-webhook";
import { getSafeDb } from "@/lib/db";

const log = createLogger({ name: "web.webhook.clerk" });

/**
 * Receives organization and membership events from Clerk.
 *
 * Authenticated by signature (CLERK_WEBHOOK_SIGNING_SECRET), not by session.
 * An unsigned or altered request is rejected before its body is trusted.
 */
export async function POST(request: NextRequest): Promise<Response> {
  let event;
  try {
    event = await verifyWebhook(request);
  } catch {
    // No detail in the response: it would only help someone forging requests.
    return new Response("Invalid signature", { status: 400 });
  }

  if (!isHandledEvent(event)) return new Response(null, { status: 204 });

  try {
    const outcome = await handleClerkEvent(await getSafeDb(), event);
    log.info({ type: event.type, outcome }, "clerk webhook handled");
    return new Response(null, { status: 204 });
  } catch (error) {
    // A 5xx makes Clerk retry, which is right: handling is idempotent.
    log.error({ err: error, type: event.type }, "clerk webhook failed");
    return new Response("Webhook handling failed", { status: 500 });
  }
}
