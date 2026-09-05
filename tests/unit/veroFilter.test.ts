/**
 * Unit tests for src/ebay/veroFilter.ts
 *
 * The VeRO filter is a pre-publish safety gate — a false negative means a
 * restricted brand gets listed on eBay (policy violation + potential account
 * suspension). These tests verify both blocking and the word-boundary logic
 * that prevents false positives.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { checkVero, clearBlocklistCache } from "../../src/ebay/veroFilter";
import path from "path";

// Use the real blocklist from config/ — it contains "nike", "adidas", etc.
const BLOCKLIST = path.join(process.cwd(), "config", "vero-blocklist.txt");

beforeEach(() => {
  // Each test gets a fresh cache so order doesn't matter
  clearBlocklistCache();
});

describe("checkVero — blocking", () => {
  it("blocks a title containing a blocked keyword", () => {
    const result = checkVero("Nike Air Max Sneakers", undefined, BLOCKLIST);
    expect(result.isBlocked).toBe(true);
    expect(result.matchedKeywords).toContain("nike");
  });

  it("is case-insensitive", () => {
    const result = checkVero("NIKE Air Max", undefined, BLOCKLIST);
    expect(result.isBlocked).toBe(true);
  });

  it("matches keyword in description when title is clean", () => {
    const result = checkVero(
      "Sports Sneakers",
      "Inspired by the Nike design",
      BLOCKLIST
    );
    expect(result.isBlocked).toBe(true);
    expect(result.matchedKeywords).toContain("nike");
  });

  it("returns all matched keywords when multiple brands present", () => {
    const result = checkVero("Nike Adidas Crossover Shoe", undefined, BLOCKLIST);
    expect(result.isBlocked).toBe(true);
    expect(result.matchedKeywords.length).toBeGreaterThanOrEqual(2);
  });
});

describe("checkVero — word boundary (no false positives)", () => {
  it("does not block 'unikey' when 'nike' is on blocklist", () => {
    const result = checkVero("Unikey Wireless Keyboard", undefined, BLOCKLIST);
    expect(result.isBlocked).toBe(false);
  });

  it("does not block 'Snikell' for 'nike'", () => {
    const result = checkVero("Snikell Brand Boots", undefined, BLOCKLIST);
    expect(result.isBlocked).toBe(false);
  });
});

describe("checkVero — clean items", () => {
  it("does not block a generic unbranded title", () => {
    const result = checkVero("Wireless Earbuds Bluetooth 5.0", undefined, BLOCKLIST);
    expect(result.isBlocked).toBe(false);
    expect(result.matchedKeywords).toHaveLength(0);
  });

  it("returns isBlocked:false and empty array for empty title and description", () => {
    const result = checkVero("", "", BLOCKLIST);
    expect(result.isBlocked).toBe(false);
    expect(result.matchedKeywords).toHaveLength(0);
  });
});
