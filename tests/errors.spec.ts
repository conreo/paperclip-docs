import { describe, expect, it } from "vitest";

import { MAX_ERROR_CHARS, REDACTED, sanitizeErrorMessage } from "../src/errors.js";

/**
 * The settings page renders whatever `sanitizeErrorMessage` returns, so these
 * tests pin the two properties the page depends on: a thrown object must never
 * become `[object Object]`, and a raw server query must never reach the screen.
 */

describe("sanitizeErrorMessage — objects, not [object Object]", () => {
  it("reads the message out of a bridge-style envelope", () => {
    const bridgeError = { code: "WORKER_ERROR", message: "No handler registered for corpus-status" };
    expect(sanitizeErrorMessage(bridgeError)).toBe("No handler registered for corpus-status");
    expect(sanitizeErrorMessage(bridgeError)).not.toContain("[object");
  });

  it("unwraps a nested envelope", () => {
    expect(sanitizeErrorMessage({ error: { message: "upstream refused" } })).toBe(
      "upstream refused",
    );
  });

  it("falls back through detail and reason", () => {
    expect(sanitizeErrorMessage({ detail: "corpus missing" })).toBe("corpus missing");
    expect(sanitizeErrorMessage({ reason: "not_indexed" })).toBe("not_indexed");
  });

  it("JSON-stringifies an object with no recognisable field", () => {
    const result = sanitizeErrorMessage({ unexpected: true, count: 3 });
    expect(result).toContain("unexpected");
    expect(result).not.toContain("[object");
  });

  it("does not throw on a circular object", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular["self"] = circular;
    expect(() => sanitizeErrorMessage(circular)).not.toThrow();
  });
});

describe("sanitizeErrorMessage — leaks and length", () => {
  it("drops a raw SQL statement and its bound parameters", () => {
    const leaked =
      'Failed query: insert into "tool_mcp_gateways" ("id") values (default, $1) params: 11111111-aaaa,secretvalue';
    const clean = sanitizeErrorMessage(leaked);
    expect(clean).not.toMatch(/insert into/i);
    expect(clean).not.toMatch(/params:/i);
    expect(clean).toMatch(/server log/i);
  });

  it("redacts a token-shaped run", () => {
    expect(sanitizeErrorMessage("token abcdefghijklmnopqrstuvwxyz012345 rejected")).toBe(
      `token ${REDACTED} rejected`,
    );
  });

  it("does not mangle a UUID or a key", () => {
    expect(sanitizeErrorMessage("no request 5ebdaf48-3f46-447f-b0f1-be65b0c6f189")).toBe(
      "no request 5ebdaf48-3f46-447f-b0f1-be65b0c6f189",
    );
    expect(sanitizeErrorMessage('"docs-read" not found')).toBe('"docs-read" not found');
  });

  it("collapses whitespace and truncates a wall of text", () => {
    expect(sanitizeErrorMessage("a\n\n\tb")).toBe("a b");
    const clean = sanitizeErrorMessage("word ".repeat(300));
    expect(clean.length).toBeLessThanOrEqual(MAX_ERROR_CHARS);
    expect(clean.endsWith("…")).toBe(true);
  });

  it("handles the plain cases", () => {
    expect(sanitizeErrorMessage(new Error("boom"))).toBe("boom");
    expect(sanitizeErrorMessage("plain")).toBe("plain");
    expect(sanitizeErrorMessage(42)).toBe("42");
    expect(sanitizeErrorMessage(undefined)).toBe("undefined");
  });
});
