import { describe, expect, it } from "vitest";
import {
  dattoMessage,
  localVerificationOutcome,
  normalizeDattoStatus,
  screenshotOutcome,
  verificationOutcome,
} from "./normalize";
import { dattoBackupSchema, parseDattoTimestamp } from "./schema";

const T = 1_794_000_000;
const screenshot = (status: unknown) => ({
  advancedVerification: { screenshotVerification: { status } },
});
const local = (status: unknown, errors: unknown[] = []) => ({
  localVerification: { status, errors },
});
const entry = (status: unknown, extra: Record<string, unknown> = {}) => ({
  timestamp: T,
  backup: { status },
  ...extra,
});

describe("normalizeDattoStatus: the backup itself", () => {
  it.each([
    ["success", "success"],
    ["Success", "success"],
    ["  SUCCESS  ", "success"],
    ["successful", "success"],
    ["completed", "success"],
    ["failure", "failed"],
    ["FAILURE", "failed"],
    ["failed", "failed"],
    ["error", "failed"],
    ["running", "running"],
    ["in_progress", "running"],
    ["inProgress", "running"],
    ["pending", "running"],
    ["warning", "warning"],
    ["partial", "warning"],
    ["verifying", "unknown"],
    ["skipped", "unknown"],
    ["", "unknown"],
  ] as const)("backup status %j is %s", (status, expected) => {
    expect(normalizeDattoStatus(entry(status))).toBe(expected);
  });

  it("is unknown when the backup status is missing, null or not a string", () => {
    expect(normalizeDattoStatus({ timestamp: T })).toBe("unknown");
    expect(normalizeDattoStatus({ timestamp: T, backup: null })).toBe("unknown");
    expect(normalizeDattoStatus({ timestamp: T, backup: {} })).toBe("unknown");
    expect(normalizeDattoStatus(entry(null))).toBe("unknown");
    expect(normalizeDattoStatus(entry(1))).toBe("unknown");
  });
});

describe("normalizeDattoStatus: verification turns a success into a warning", () => {
  it("is success when screenshot and local verification both passed", () => {
    expect(
      normalizeDattoStatus(entry("success", { ...screenshot("success"), ...local("success") })),
    ).toBe("success");
  });

  it("is success when no verification was attempted", () => {
    expect(normalizeDattoStatus(entry("success"))).toBe("success");
    expect(
      normalizeDattoStatus(
        entry("success", { localVerification: null, advancedVerification: null }),
      ),
    ).toBe("success");
    expect(normalizeDattoStatus(entry("success", screenshot(null)))).toBe("success");
    expect(normalizeDattoStatus(entry("success", screenshot("not_attempted")))).toBe("success");
    expect(normalizeDattoStatus(entry("success", { advancedVerification: {} }))).toBe("success");
  });

  it.each(["failure", "failed", "FAILED", "error", false])(
    "is warning when screenshot verification is %j",
    (status) => {
      expect(normalizeDattoStatus(entry("success", screenshot(status)))).toBe("warning");
    },
  );

  it("is warning when local verification failed or reported any error", () => {
    expect(normalizeDattoStatus(entry("success", local("failure")))).toBe("warning");
    expect(
      normalizeDattoStatus(entry("success", local("success", [{ errorMessage: "bad sector" }]))),
    ).toBe("warning");
  });

  it("is warning when screenshot passed but local verification failed, and the reverse", () => {
    expect(
      normalizeDattoStatus(entry("success", { ...screenshot("success"), ...local("failure") })),
    ).toBe("warning");
    expect(
      normalizeDattoStatus(entry("success", { ...screenshot("failure"), ...local("success") })),
    ).toBe("warning");
  });

  it("a failed backup stays failed whatever verification says", () => {
    expect(normalizeDattoStatus(entry("failure", screenshot("success")))).toBe("failed");
    expect(normalizeDattoStatus(entry("failure", screenshot("failure")))).toBe("failed");
  });

  it("a running backup stays running whatever verification says", () => {
    expect(normalizeDattoStatus(entry("running", screenshot("failure")))).toBe("running");
  });

  it("never reports missed: that status is derived by the rule, not by a vendor", () => {
    for (const status of ["missed", "missing", "no backup", "overdue"]) {
      expect(normalizeDattoStatus(entry(status))).not.toBe("missed");
    }
  });
});

describe("normalizeDattoStatus: hostile and malformed input", () => {
  it.each([
    null,
    undefined,
    0,
    42,
    "success",
    true,
    [],
    {},
    { backup: { status: "success" } }, // no timestamp
    { timestamp: T, backup: "success" },
    { timestamp: T, backup: { status: { nested: "success" } } },
    { timestamp: T, backup: { status: "success" }, localVerification: "oops" },
    { timestamp: T, backup: { status: "success" }, advancedVerification: [] },
  ])("returns unknown, without throwing, for %j", (raw) => {
    expect(normalizeDattoStatus(raw)).toBe("unknown");
  });

  it("ignores fields it does not know about", () => {
    expect(
      normalizeDattoStatus(entry("success", { somethingNew: { a: 1 }, ...screenshot("success") })),
    ).toBe("success");
  });

  it("does not modify what it is given", () => {
    const raw = entry("success", screenshot("failure"));
    const before = JSON.stringify(raw);
    normalizeDattoStatus(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });
});

describe("verification helpers", () => {
  it("reads a status in whatever form it comes", () => {
    for (const passed of ["success", "Successful", "passed", "ok", true]) {
      expect(verificationOutcome(passed)).toBe("passed");
    }
    for (const failed of ["failure", "Failed", "error", false]) {
      expect(verificationOutcome(failed)).toBe("failed");
    }
    for (const none of [null, undefined, "", "none", "skipped", 0, {}]) {
      expect(verificationOutcome(none)).toBe("not_attempted");
    }
  });

  it("exposes screenshot and local verification separately", () => {
    const parsed = dattoBackupSchema.parse(
      entry("success", { ...screenshot("failure"), ...local("success") }),
    );
    expect(screenshotOutcome(parsed)).toBe("failed");
    expect(localVerificationOutcome(parsed)).toBe("passed");
    expect(screenshotOutcome(dattoBackupSchema.parse(entry("success")))).toBe("not_attempted");
    expect(localVerificationOutcome(dattoBackupSchema.parse(entry("success")))).toBe(
      "not_attempted",
    );
  });
});

describe("dattoMessage", () => {
  const message = (raw: unknown) => dattoMessage(dattoBackupSchema.parse(raw));

  it("prefers Datto's own error message", () => {
    expect(
      message({
        timestamp: T,
        backup: { status: "failure", errorMessage: "  Disk full  " },
        ...screenshot("failure"),
      }),
    ).toBe("Disk full");
  });

  it("falls back to the first local verification error, then to a plain statement", () => {
    expect(
      message(
        entry("success", local("failure", [{ errorMessage: "" }, { errorMessage: "Bad sector" }])),
      ),
    ).toBe("Local verification: Bad sector");
    expect(message(entry("success", local("failure")))).toBe("Local verification failed.");
    expect(message(entry("success", screenshot("failure")))).toBe(
      "Screenshot verification failed.",
    );
  });

  it("says nothing about a clean backup", () => {
    expect(message(entry("success", { ...screenshot("success"), ...local("success") }))).toBeNull();
    expect(message(entry("success"))).toBeNull();
  });
});

describe("parseDattoTimestamp", () => {
  const expected = new Date("2026-11-12T12:00:00Z");

  it("reads epoch seconds, epoch milliseconds, numeric strings and ISO strings", () => {
    const seconds = expected.getTime() / 1000;
    expect(parseDattoTimestamp(seconds)).toEqual(expected);
    expect(parseDattoTimestamp(seconds * 1000)).toEqual(expected);
    expect(parseDattoTimestamp(String(seconds))).toEqual(expected);
    expect(parseDattoTimestamp("2026-11-12T12:00:00Z")).toEqual(expected);
    expect(parseDattoTimestamp("2026-11-12T07:00:00-05:00")).toEqual(expected);
  });

  it.each([
    null,
    undefined,
    0,
    -5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "",
    "  ",
    "yesterday",
    {},
    [],
  ])("returns null for %j", (value) => {
    expect(parseDattoTimestamp(value)).toBeNull();
  });
});
