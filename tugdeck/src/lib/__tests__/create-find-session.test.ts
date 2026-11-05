/**
 * create-find-session.test — the one session factory's seeding: options come
 * from the deck-wide find preference, a replace-capable surface starts from
 * the remembered replacement, a find-only one does not, and a deck with no
 * client starts from the session's own defaults.
 *
 * The client is a cache read through `get(domain, key)`, so a fake over a
 * map is the real shape of what the factory reads.
 */

import { describe, expect, test } from "bun:test";

import { createFindSession } from "../create-find-session";
import { DEFAULT_FIND_OPTIONS } from "../find-session";
import type { TugbankClient } from "../tugbank-client";

function fakeClient(entries: Record<string, { kind: string; value: unknown }>): TugbankClient {
  return {
    get: (domain: string, key: string) => entries[`${domain}/${key}`],
  } as unknown as TugbankClient;
}

const SEEDED = fakeClient({
  "dev.tugapp.find/options": {
    kind: "json",
    value: { caseSensitive: true, wholeWord: false, grep: true },
  },
  "dev.tugapp.find/replacement": { kind: "string", value: "blue" },
});

describe("createFindSession", () => {
  test("a replace-capable surface seeds the options and the remembered replacement", () => {
    const snap = createFindSession({ replace: true, client: SEEDED }).getSnapshot();
    expect(snap.options).toEqual({ caseSensitive: true, wholeWord: false, grep: true });
    expect(snap.replacement).toBe("blue");
  });

  test("a find-only surface seeds the options and never the replacement", () => {
    const snap = createFindSession({ replace: false, client: SEEDED }).getSnapshot();
    expect(snap.options).toEqual({ caseSensitive: true, wholeWord: false, grep: true });
    expect(snap.replacement).toBe("");
  });

  test("no client starts from the session's defaults", () => {
    const snap = createFindSession({ replace: true, client: null }).getSnapshot();
    expect(snap.options).toEqual(DEFAULT_FIND_OPTIONS);
    expect(snap.replacement).toBe("");
  });

  test("an unset preference falls back to the defaults", () => {
    const snap = createFindSession({ replace: true, client: fakeClient({}) }).getSnapshot();
    expect(snap.options).toEqual(DEFAULT_FIND_OPTIONS);
    expect(snap.replacement).toBe("");
  });
});
