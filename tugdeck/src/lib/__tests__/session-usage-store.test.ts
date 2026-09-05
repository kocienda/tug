/**
 * Pin the segment-keyed usage store and the two paths that fill it — the
 * numbers an arc receipt's stage row shows in place of the claude session id
 * it used to print.
 *
 * The rules under test are the ones the row's rendering depends on: usage is
 * the SEGMENT's fact and never the line's, a segment the ledger says nothing
 * about is indistinguishable from one nobody asked about (both empty, never a
 * zero), a `resolve_sessions_ok` answer fills the cell for the ids the receipt
 * parsed, and a `removed` push forgets the segment.
 *
 * The rendering half is a hook on a real receipt and is exercised on the
 * running app (`at0521`) rather than in a render test.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { sessionCitationStore } from "@/lib/session-citation-store";
import { sessionUsageStore } from "@/lib/session-usage-store";
import {
  decodeResolveSessionsOk,
  decodeSessionUpdated,
  normalizeSessionRow,
  type SessionRow,
} from "@/protocol";

/** The two stage ids of one arc — two segments of a single line ([F08]). */
const IMPLEMENT = "557d7058-8076-4c1d-9f7e-2b3a4c5d6e7f";
const AUDIT = "0431f0dd-cb36-4a2b-8c1d-9e0f1a2b3c4d";
const LINE = "12287084-3775-49b8-9ddf-43852320601b";

function row(sessionId: string): SessionRow {
  return normalizeSessionRow({
    session_id: sessionId,
    workspace_key: "ws-1",
    project_dir: "/Users/dev/src/tug",
    created_at: 1,
    last_used_at: 2,
    turn_count: 3,
    last_user_prompt: null,
    state: "closed",
    card_id: null,
    name: null,
    line_id: LINE,
  } as Parameters<typeof normalizeSessionRow>[0]);
}

/** The answer to the ask a three-field receipt makes for its parsed stage ids. */
function resolved(entries: { id: string; usage?: Record<string, number> }[]) {
  return decodeResolveSessionsOk({
    action: "resolve_sessions_ok",
    sessions: entries.map((e) => ({
      queried: e.id,
      session: {
        session_id: e.id,
        workspace_key: "ws-1",
        project_dir: "/Users/dev/src/tug",
        created_at: 1,
        last_used_at: 2,
        turn_count: 3,
        last_user_prompt: null,
        state: "closed",
        card_id: null,
        name: null,
        line_id: LINE,
      },
      usage: e.usage,
    })),
    unknown: [],
  });
}

beforeEach(() => {
  sessionUsageStore.forgetAll();
  sessionCitationStore.forgetAll();
});

describe("what a segment cost", () => {
  test("a segment nobody has asked about reads as nothing, never as zero", () => {
    // The empty state and the answered-empty state are the same rendering on
    // purpose: a stage that recorded no turn has nothing to say, and a `0
    // tokens` in the cell would be a claim the app cannot make.
    expect(sessionUsageStore.getUsage(IMPLEMENT)).toBeUndefined();
  });

  test("the key is the segment, so two stages of one line differ", () => {
    // The whole point of the figure. Keyed by line — the way the name, the
    // callsign and the synopsis are keyed — these two would overwrite each
    // other and every stage row of an arc would read the same number.
    sessionUsageStore.set(IMPLEMENT, { turns: 10, tokens: 1_885_093, activeMs: 1_391_000 });
    sessionUsageStore.set(AUDIT, { turns: 1, tokens: 121_868, activeMs: 415_000 });
    expect(sessionUsageStore.getUsage(IMPLEMENT)?.tokens).toBe(1_885_093);
    expect(sessionUsageStore.getUsage(AUDIT)?.tokens).toBe(121_868);
  });

  test("an answer with no usage clears the entry rather than holding a stale one", () => {
    sessionUsageStore.set(IMPLEMENT, { turns: 1, tokens: 10, activeMs: 20 });
    sessionUsageStore.set(IMPLEMENT, undefined);
    expect(sessionUsageStore.getUsage(IMPLEMENT)).toBeUndefined();
  });

  test("an unchanged write notifies nobody", () => {
    let notifications = 0;
    const stop = sessionUsageStore.subscribe(() => {
      notifications += 1;
    });
    sessionUsageStore.set(IMPLEMENT, { turns: 1, tokens: 10, activeMs: 20 });
    sessionUsageStore.set(IMPLEMENT, { turns: 1, tokens: 10, activeMs: 20 });
    stop();
    expect(notifications).toBe(1);
  });

  test("a forgotten segment is forgotten", () => {
    sessionUsageStore.set(IMPLEMENT, { turns: 1, tokens: 10, activeMs: 20 });
    sessionUsageStore.forget(IMPLEMENT);
    expect(sessionUsageStore.getUsage(IMPLEMENT)).toBeUndefined();
  });
});

describe("the receipt's ask, answered", () => {
  test("an answer fills the cell for the id the receipt parsed", () => {
    // The restore path in full: a receipt already in the shell ledger mounts,
    // the row asks the citation store for the two ids its text carries, and
    // the ledger's answer carries each segment's sums beside its row.
    const response = resolved([
      { id: IMPLEMENT, usage: { turns: 10, tokens: 1_885_093, active_ms: 1_391_000 } },
      { id: AUDIT },
    ]);
    expect(response).not.toBeNull();
    sessionCitationStore.applyResolved(response!);

    expect(sessionUsageStore.getUsage(IMPLEMENT)).toEqual({
      turns: 10,
      tokens: 1_885_093,
      activeMs: 1_391_000,
    });
    // The stage the ledger holds but has no telemetry for: its row still
    // resolves — stage and model stand — and only the figure is absent.
    expect(sessionCitationStore.getAnswer(AUDIT).status).toBe("found");
    expect(sessionUsageStore.getUsage(AUDIT)).toBeUndefined();
  });

  test("an id the ledger does not hold leaves no entry behind", () => {
    const response = decodeResolveSessionsOk({
      action: "resolve_sessions_ok",
      sessions: [],
      unknown: [IMPLEMENT],
    });
    sessionCitationStore.applyResolved(response!);
    expect(sessionCitationStore.getAnswer(IMPLEMENT).status).toBe("unknown");
    expect(sessionUsageStore.getUsage(IMPLEMENT)).toBeUndefined();
  });

  test("a wire that came back new forgets the figures with the answers", () => {
    // The citation store drops its answers on reconnect because a bounce may
    // have crossed a trash. The sums it seeded have to go with them: nothing
    // in the deck re-derives usage, so a kept entry would keep printing a
    // figure for a segment the ledger no longer holds.
    sessionUsageStore.set(IMPLEMENT, { turns: 10, tokens: 1_885_093, activeMs: 1_391_000 });
    sessionCitationStore.forgetAll();
    expect(sessionUsageStore.getUsage(IMPLEMENT)).toBeUndefined();
  });
});

describe("the wire shapes", () => {
  test("a push carries the usage beside the row", () => {
    const push = decodeSessionUpdated({
      action: "session_updated",
      session_id: IMPLEMENT,
      fields: { ...row(IMPLEMENT) },
      usage: { turns: 10, tokens: 1_885_093, active_ms: 1_391_000 },
    });
    expect(push?.usage).toEqual({
      turns: 10,
      tokens: 1_885_093,
      activeMs: 1_391_000,
    });
  });

  test("a push with no usage carries none, and a malformed one is not a zero", () => {
    const bare = decodeSessionUpdated({
      action: "session_updated",
      session_id: IMPLEMENT,
      fields: { ...row(IMPLEMENT) },
    });
    expect(bare?.usage).toBeUndefined();
    const junk = decodeSessionUpdated({
      action: "session_updated",
      session_id: IMPLEMENT,
      fields: { ...row(IMPLEMENT) },
      usage: { turns: 3 },
    });
    expect(junk?.usage).toBeUndefined();
  });
});
