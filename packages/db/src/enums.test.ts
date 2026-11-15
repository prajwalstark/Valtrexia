import { BACKUP_STATUSES, VENDOR_IDS } from "@valtrexia/core";
import { describe, expect, it } from "vitest";
import { BackupStatus, Vendor } from "./generated/prisma/enums";

// The database enums and the lists in core are written separately. These
// tests fail if one is changed without the other.
describe("database enums", () => {
  it("vendor enum matches the vendor catalog in core", () => {
    expect(Object.values(Vendor).sort()).toEqual([...VENDOR_IDS].sort());
  });

  it("backup status enum matches the normalized statuses in core", () => {
    expect(Object.values(BackupStatus).sort()).toEqual([...BACKUP_STATUSES].sort());
  });
});
