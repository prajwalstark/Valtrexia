import { MAX_EMAIL_RECIPIENTS } from "@valtrexia/core/server";
import { describe, expect, it } from "vitest";
import { MAX_EMAIL_RECIPIENTS_CLIENT } from "../components/notifications/limits";

describe("notification form limits", () => {
  it("offer what the server enforces", () => {
    expect(MAX_EMAIL_RECIPIENTS_CLIENT).toBe(MAX_EMAIL_RECIPIENTS);
  });
});
