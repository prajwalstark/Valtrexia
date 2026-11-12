import { VENDOR_IDS } from "@valtrexia/core";
import { describe, expect, it } from "vitest";
import { Vendor } from "./generated/prisma/enums";

describe("database enums", () => {
  it("vendor enum matches the vendor catalog in core", () => {
    expect(Object.values(Vendor).sort()).toEqual([...VENDOR_IDS].sort());
  });
});
