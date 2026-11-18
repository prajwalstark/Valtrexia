import { describe, expect, it } from "vitest";
import { clerkPublishableKey } from "./clerk-keys";

describe("Clerk publishable key", () => {
  it("prefers CLERK_PUBLISHABLE_KEY, and accepts the name Clerk's docs use", () => {
    expect(
      clerkPublishableKey({
        CLERK_PUBLISHABLE_KEY: "pk_a",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_b",
      }),
    ).toBe("pk_a");
    expect(clerkPublishableKey({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: " pk_b " })).toBe("pk_b");
  });

  it("is absent when neither is set, or both are blank", () => {
    expect(clerkPublishableKey({})).toBeUndefined();
    expect(
      clerkPublishableKey({ CLERK_PUBLISHABLE_KEY: " ", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "" }),
    ).toBeUndefined();
  });
});
