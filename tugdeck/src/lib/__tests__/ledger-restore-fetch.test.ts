/**
 * LedgerRestoreFetch — the CONTROL restore read that keeps asking ([P07]).
 *
 * Drives the real driver against a connection double whose socket can be
 * opened and closed, which is the cold-boot shape the one-shot fetch lost a
 * `/commit` row to: the card's stores construct, the frame finds no OPEN
 * socket, and nothing ever asks again. The give-up warning is read back out
 * of the real `tugDevLogStore` rather than a double — it is the surface a
 * person actually reads in the Log tab.
 */
import { describe, expect, mock, test } from "bun:test";

let sent: Array<string> = [];
let socketOpen = true;
// The full connection shape the sibling store tests mock, so this double is
// harmless to any file that happens to resolve it.
mock.module("../connection-singleton", () => ({
  getConnection: () => ({
    send: (_feedId: number, payload: Uint8Array) => {
      if (socketOpen) sent.push(new TextDecoder().decode(payload));
    },
    trySend: (_feedId: number, payload: Uint8Array) => {
      if (!socketOpen) return false;
      sent.push(new TextDecoder().decode(payload));
      return true;
    },
    onFrame: () => () => {},
  }),
}));

import { LedgerRestoreFetch } from "../ledger-restore-fetch";
import { tugDevLogStore } from "../tug-dev-log-store/tug-dev-log-store";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Give-up warnings this driver logged for one session id. */
function warningsFor(tugSessionId: string): ReadonlyArray<{ message: string; data?: unknown }> {
  return tugDevLogStore
    .getSnapshot()
    .entries.filter(
      (e) =>
        e.level === "warn" &&
        e.message === "ledger restore not yet answered" &&
        (e.data as { tugSessionId?: string } | undefined)?.tugSessionId === tugSessionId,
    );
}

/** Fast timings so a test pins the retry behaviour, not its wall-clock. */
const FAST = { answerTimeoutMs: 10, backoffMs: [5], warnAfterAttempts: 4 } as const;

describe("LedgerRestoreFetch", () => {
  test("a frame dropped by a closed socket is asked again once it opens", async () => {
    sent = [];
    socketOpen = false;
    const fetch = new LedgerRestoreFetch({
      action: "list_shell_exchanges",
      tugSessionId: "sess-1",
      logSource: "shell-restore",
      ...FAST,
    });
    fetch.start();
    expect(sent).toEqual([]);

    socketOpen = true;
    await sleep(20);
    fetch.dispose();

    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(sent[0]!)).toEqual({
      action: "list_shell_exchanges",
      tug_session_id: "sess-1",
    });
  });

  test("a send that reached the socket but went unanswered is re-asked", async () => {
    sent = [];
    socketOpen = true;
    const fetch = new LedgerRestoreFetch({
      action: "list_refs",
      tugSessionId: "sess-2",
      logSource: "refs-restore",
      ...FAST,
    });
    fetch.start();
    expect(sent.length).toBe(1);

    await sleep(25);
    fetch.dispose();
    expect(sent.length).toBeGreaterThan(1);
  });

  test("settle stops the retries and leaves no warning", async () => {
    sent = [];
    socketOpen = true;
    const fetch = new LedgerRestoreFetch({
      action: "list_shell_exchanges",
      tugSessionId: "sess-3",
      logSource: "shell-restore",
      ...FAST,
    });
    fetch.start();
    fetch.settle();
    const afterSettle = sent.length;

    await sleep(30);
    fetch.dispose();
    expect(sent.length).toBe(afterSettle);
    expect(warningsFor("sess-3")).toEqual([]);
  });

  test("a stuck restore warns once and keeps asking anyway", async () => {
    sent = [];
    socketOpen = true;
    const fetch = new LedgerRestoreFetch({
      action: "list_shell_exchanges",
      tugSessionId: "sess-4",
      logSource: "shell-restore",
      ...FAST,
    });
    fetch.start();

    await sleep(80);
    const atWarn = sent.length;
    expect(atWarn).toBeGreaterThanOrEqual(4);

    // The warning is for the Log tab, not a stop signal: the give-up is what
    // stranded 49 ledgered rows, so asking must outlive the complaint.
    const warnings = warningsFor("sess-4");
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.data).toMatchObject({
      action: "list_shell_exchanges",
      tugSessionId: "sess-4",
    });

    await sleep(60);
    fetch.dispose();
    expect(sent.length).toBeGreaterThan(atWarn);
    expect(warningsFor("sess-4").length).toBe(1);
  });

  test("refresh re-asks a fetch a previous answer had settled", async () => {
    sent = [];
    socketOpen = true;
    const fetch = new LedgerRestoreFetch({
      action: "list_shell_exchanges",
      tugSessionId: "sess-5",
      logSource: "shell-restore",
      ...FAST,
      params: () => ({ since_ms: 4242 }),
    });
    fetch.start();
    fetch.settle();
    const afterSettle = sent.length;

    await sleep(30);
    expect(sent.length).toBe(afterSettle);

    // The window moved, so the settled answer answered a different question.
    fetch.refresh();
    fetch.settle();
    fetch.dispose();
    expect(sent.length).toBe(afterSettle + 1);
    expect(JSON.parse(sent[sent.length - 1]!).since_ms).toBe(4242);
  });
});
