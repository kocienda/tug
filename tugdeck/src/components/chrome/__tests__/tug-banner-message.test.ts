/**
 * The connection banner's words. A reconnect under way keeps its reason, so a
 * failure the deck is recovering from — an ingest Worker that died — is named
 * for as long as the banner stands, not just a bare "Reconnecting...".
 */

import { describe, expect, test } from "bun:test";
import { bannerMessage } from "../tug-banner-bridge";
import { INGEST_WORKER_FAILED_REASON } from "@/connection";

describe("bannerMessage", () => {
  test("a failed ingest Worker is named while the deck reconnects", () => {
    expect(
      bannerMessage({ disconnected: true, countdown: 0, reason: INGEST_WORKER_FAILED_REASON, reconnecting: true }),
    ).toBe("Reconnecting (ingest worker failed)...");
  });

  test("a plain reconnect, a reasoned disconnect, and a countdown read as they always did", () => {
    expect(bannerMessage({ disconnected: true, countdown: 0, reason: null, reconnecting: true })).toBe("Reconnecting...");
    expect(bannerMessage({ disconnected: true, countdown: 0, reason: "server closed", reconnecting: false })).toBe(
      "Disconnected (server closed)",
    );
    expect(bannerMessage({ disconnected: true, countdown: 3, reason: null, reconnecting: false })).toBe(
      "Disconnected — reconnecting in 3s...",
    );
    expect(bannerMessage(null)).toBe("Disconnected");
  });
});
