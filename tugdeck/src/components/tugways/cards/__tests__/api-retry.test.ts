/**
 * Unit tests for the pure `api-retry` classifier — `classifyApiRetry`
 * (category + nullable HTTP status → label + severity + category taxonomy).
 *
 * The `category` assertions are not decoration. It is the machine-readable
 * discriminator the lifecycle matrix's `stalled` overlay keys off, chosen
 * precisely so that nothing branches on `label` — which is display copy, and
 * which a copy edit would otherwise be free to change out from under a
 * behaviour with no test to notice. That is what the last describe block
 * below pins.
 */

import { describe, it, expect } from "bun:test";

import {
  classifyApiRetry,
  type ApiRetryCategory,
} from "@/components/tugways/cards/api-retry";

describe("classifyApiRetry — category taxonomy", () => {
  it("maps transient categories to caution-grade severity", () => {
    expect(classifyApiRetry("rate_limit", 429)).toEqual({
      label: "Rate limited",
      severity: "transient",
      category: "rate",
    });
    expect(classifyApiRetry("overloaded", 529)).toEqual({
      label: "Servers overloaded",
      severity: "transient",
      category: "server",
    });
    expect(classifyApiRetry("timeout", null)).toEqual({
      label: "Request timed out",
      severity: "transient",
      category: "timeout",
    });
    expect(classifyApiRetry("api_error", 500)).toEqual({
      label: "Server error",
      severity: "transient",
      category: "server",
    });
  });

  it("maps likely-fatal categories to fatal severity", () => {
    expect(classifyApiRetry("authentication_failed", 401)).toEqual({
      label: "Authentication failed",
      severity: "likely-fatal",
      category: "auth",
    });
    expect(classifyApiRetry("billing_error", 402)).toEqual({
      label: "Billing problem",
      severity: "likely-fatal",
      category: "billing",
    });
    expect(classifyApiRetry("permission_error", 403)).toEqual({
      label: "Permission denied",
      severity: "likely-fatal",
      category: "permission",
    });
  });

  it("falls back to Server error/transient for an unknown 5xx", () => {
    expect(classifyApiRetry("something_new", 503)).toEqual({
      label: "Server error",
      severity: "transient",
      category: "server",
    });
  });

  it("names a no-status network failure rather than the bare generic", () => {
    // Real shapes lifted from the on-disk JSONL audit — all arrive with no
    // HTTP status and previously rendered the alarming bare "API error".
    for (const error of [
      "ECONNRESET",
      "FailedToOpenSocket",
      "Connection error.",
      "Request timed out.",
      "socket hang up",
    ]) {
      expect(classifyApiRetry(error, null)).toEqual({
        label: "Connection lost",
        severity: "transient",
        category: "connection",
      });
    }
  });

  it("does not mistake a status-bearing failure for a network error", () => {
    // A 5xx wins even if its category string mentions a connection.
    expect(classifyApiRetry("connection reset upstream", 503)).toEqual({
      label: "Server error",
      severity: "transient",
      category: "server",
    });
  });

  it("falls back to API error/transient for a non-network unknown", () => {
    expect(classifyApiRetry("mystery", null)).toEqual({
      label: "API error",
      severity: "transient",
      category: "other",
    });
    expect(classifyApiRetry("mystery", 418)).toEqual({
      label: "API error",
      severity: "transient",
      category: "other",
    });
  });

  it("never throws on an empty or odd error string", () => {
    expect(() => classifyApiRetry("", null)).not.toThrow();
    expect(classifyApiRetry("", null).label).toBe("API error");
  });
});

describe("classifyApiRetry — the category is the discriminator", () => {
  it("gives every arm a category", () => {
    // Every arm of the switch, including both fall-throughs and the bare
    // default. A new arm added with no category cannot pass this.
    const arms: ReadonlyArray<readonly [string, number | null]> = [
      ["rate_limit", 429],
      ["overloaded", 529],
      ["timeout", null],
      ["api_error", 500],
      ["authentication_failed", 401],
      ["billing_error", 402],
      ["permission_error", 403],
      ["something_new", 503],
      ["ECONNRESET", null],
      ["mystery", null],
    ];
    const known: ReadonlySet<ApiRetryCategory> = new Set([
      "connection",
      "rate",
      "server",
      "auth",
      "billing",
      "permission",
      "timeout",
      "other",
    ]);
    for (const [error, status] of arms) {
      expect(known.has(classifyApiRetry(error, status).category)).toBe(true);
    }
  });

  it("classifies every network token as connection", () => {
    // The pin the `stalled` overlay rests on. These are the tokens
    // `NETWORK_ERROR_TOKENS` matches — module-private by design, which is
    // exactly why the overlay reads `category` and not the private list or
    // the public label.
    for (const error of [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EPIPE",
      "socket hang up",
      "Connection error.",
      "network unreachable",
      "peer disconnected",
      "stream reset",
      "Request timed out.",
      "fetch failed",
    ]) {
      expect(classifyApiRetry(error, null).category).toBe("connection");
    }
  });

  it("classifies nothing else as connection", () => {
    // The other half of the pin: the overlay must not fire on a rate limit
    // or a billing failure, which are claude's problems rather than the
    // network's and have their own readings.
    for (const [error, status] of [
      ["rate_limit", 429],
      ["overloaded", 529],
      ["api_error", 500],
      ["authentication_failed", 401],
      ["billing_error", 402],
      ["permission_error", 403],
      ["mystery", null],
      // A status-bearing failure is the server's, whatever its words say.
      ["connection reset upstream", 503],
    ] as ReadonlyArray<readonly [string, number | null]>) {
      expect(classifyApiRetry(error, status).category).not.toBe("connection");
    }
  });
});
