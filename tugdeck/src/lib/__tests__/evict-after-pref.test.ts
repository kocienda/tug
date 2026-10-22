/**
 * evict-after-pref — how long a hidden body keeps its process: what a stored
 * value reads as, what nothing stored reads as, and how the delay is labelled.
 *
 * @covers tugdeck/src/lib/evict-after-pref.ts
 */

import { describe, expect, test } from "bun:test";
import type { TaggedValue } from "../tugbank-client";
import { DORMANT_AFTER_DOMAIN, DEFAULT_DORMANT_AFTER_MS, parseBodyDelayMs } from "../dormant-after-pref";
import {
  DEFAULT_EVICT_AFTER_MS,
  EVICT_AFTER_CHOICES,
  EVICT_AFTER_DOMAIN,
  EVICT_AFTER_KEY,
  evictAfterLabel,
  readEvictAfterMs,
  resolveEvictAfterMs,
} from "../evict-after-pref";

describe("evict-after pref", () => {
  test("lives beside dormantAfterMs, in the same domain", () => {
    expect(EVICT_AFTER_DOMAIN).toBe(DORMANT_AFTER_DOMAIN);
    expect(EVICT_AFTER_KEY).toBe("evictAfterMs");
  });

  test("a stored value is a positive whole number of ms, or nothing", () => {
    expect(parseBodyDelayMs({ kind: "i64", value: 2000 })).toBe(2000);
    expect(parseBodyDelayMs(undefined)).toBeNull();
    expect(parseBodyDelayMs({ kind: "i64", value: 0 })).toBeNull();
    expect(parseBodyDelayMs({ kind: "i64", value: -5 })).toBeNull();
    expect(parseBodyDelayMs({ kind: "f64", value: 1.5 })).toBeNull();
    expect(parseBodyDelayMs({ kind: "string", value: "900000" })).toBeNull();
  });

  test("nothing stored reads as fifteen minutes, past the dormant minute", () => {
    expect(DEFAULT_EVICT_AFTER_MS).toBe(900_000);
    expect(resolveEvictAfterMs(null)).toBe(DEFAULT_EVICT_AFTER_MS);
    expect(resolveEvictAfterMs(1500)).toBe(1500);
    expect(DEFAULT_EVICT_AFTER_MS).toBeGreaterThan(DEFAULT_DORMANT_AFTER_MS);
  });

  test("the choices include the default, every one past the dormant minute", () => {
    expect(EVICT_AFTER_CHOICES).toContain(DEFAULT_EVICT_AFTER_MS);
    for (const ms of EVICT_AFTER_CHOICES) expect(ms).toBeGreaterThan(DEFAULT_DORMANT_AFTER_MS);
  });

  test("reads the delay a tugbank client holds", () => {
    const held = new Map<string, TaggedValue>([[`${EVICT_AFTER_DOMAIN}/${EVICT_AFTER_KEY}`, { kind: "i64", value: 1200 }]]);
    expect(readEvictAfterMs((domain, key) => held.get(`${domain}/${key}`))).toBe(1200);
    expect(readEvictAfterMs(() => undefined)).toBe(DEFAULT_EVICT_AFTER_MS);
  });

  test("labels a delay in its largest whole unit", () => {
    expect(evictAfterLabel(300_000)).toBe("5m");
    expect(evictAfterLabel(900_000)).toBe("15m");
    expect(evictAfterLabel(3_600_000)).toBe("1h");
    expect(evictAfterLabel(30_000)).toBe("30s");
    expect(evictAfterLabel(2_500)).toBe("2.5s");
  });
});
