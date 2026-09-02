/**
 * One landing, one transcript turn — the identity the live append and the
 * ledger restore have to agree on.
 *
 * A landing leaves its receipt twice over: the initiating deck paints it live
 * off the verb store's `done` edge, and the shell ledger replays the same row
 * whenever the restore's window widens (a "load previous" page re-asks for a
 * span it has not read). Both land in the transcript through
 * `ingestShellExchange`, and `buildShellTurnEntry` derives a turn's `turnKey`
 * from the exchange id — so if the two paths spell that id differently, one
 * landing seats two receipts.
 *
 * These run the real store, the real reducer, and the real restore applier
 * over the real derivation. No DOM: the identity is data, and this is where it
 * is decided.
 */
import { describe, it, expect } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import type { TugConnection } from "@/connection";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { applyRestoredShellExchanges } from "@/lib/shell-session-store";
import { landingExchangeId } from "@/components/tugways/cards/use-landing-receipts";

const SUMMARY = [
  "joined 63de5762a · join-parity → main · 3 round(s)",
  "",
  "Make the join land a durable commit message",
].join("\n");

/** The shell-ledger row the server wrote for this landing. */
const LEDGER_ROW = {
  id: 4207,
  command: "/arc-join",
  output: SUMMARY,
  exit_code: 0,
  cwd: "/p",
  cwd_after: null,
  started_at_ms: 1_700_000_000_000,
  settled_at_ms: 1_700_000_000_000,
};

function makeStore(): CodeSessionStore {
  return new CodeSessionStore({
    conn: new TestFrameChannel() as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: FIXTURE_IDS.TUG_SESSION_ID,
    sessionMode: "new",
  });
}

/** The live append `useLandingReceipts` performs on the verb store's edge. */
function appendLive(store: CodeSessionStore, receiptId: number | null): void {
  const now = 1_700_000_000_500;
  store.ingestShellExchange({
    phase: "complete",
    exchangeId: landingExchangeId(receiptId),
    command: "/arc-join",
    output: SUMMARY,
    exitCode: 0,
    cwd: "/p",
    cwdAfter: null,
    startedAtMs: now,
    settledAtMs: now,
  });
}

function shellTurns(store: CodeSessionStore) {
  return store.getSnapshot().transcript.filter((t) => t.origin === "shell");
}

describe("a landing's receipt is one turn on both delivery paths", () => {
  it("a restore after the live append settles the row instead of adding one", () => {
    const store = makeStore();
    appendLive(store, LEDGER_ROW.id);
    expect(shellTurns(store)).toHaveLength(1);

    // The window widened and the restore replayed the span this landing is in.
    applyRestoredShellExchanges(store, [LEDGER_ROW]);

    const turns = shellTurns(store);
    expect(turns).toHaveLength(1);
    expect(turns[0].messages[0]).toMatchObject({
      kind: "shell_exchange",
      command: "/arc-join",
      output: SUMMARY,
    });
  });

  it("the live append arriving after a restore settles that row too", () => {
    const store = makeStore();
    applyRestoredShellExchanges(store, [LEDGER_ROW]);
    appendLive(store, LEDGER_ROW.id);
    expect(shellTurns(store)).toHaveLength(1);
  });

  it("a landing the server never persisted keeps a local identity per row", () => {
    // No receipt id means no ledger row, so nothing will restore to collide
    // with — and two such landings must stay two rows rather than collapsing.
    const store = makeStore();
    appendLive(store, null);
    appendLive(store, null);
    expect(shellTurns(store)).toHaveLength(2);
    expect(landingExchangeId(null)).not.toBe(landingExchangeId(null));
  });

  it("a persisted landing is keyed exactly as the restore keys its row", () => {
    expect(landingExchangeId(LEDGER_ROW.id)).toBe(`restored-${LEDGER_ROW.id}`);
  });
});
