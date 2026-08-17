/**
 * prompt-history-api unit tests.
 *
 * The outbox is the piece of this feature that has to be right when the
 * network isn't, so these drive the real module against a `fetch` (and
 * `XMLHttpRequest`) stub that can be made to fail on demand.
 *
 * Tests cover:
 * - An append that fails is retried, not dropped, and lands with its original
 *   client entry id.
 * - Ordering: a failing append holds every later append for the same session
 *   behind it, so ledger ids can't invert; other sessions drain independently.
 * - A retry ladder that outlives its fast rungs publishes a visible failure.
 * - flushPromptHistorySync drains the queue with blocking requests.
 * - fetchPromptHistoryPage maps the wire row shape onto HistoryEntry.
 */

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import {
  appendPromptHistory,
  fetchPromptHistoryPage,
  flushPromptHistorySync,
  pendingAppendCount,
  subscribeAppendFailures,
  patchPromptAtomPath,
  __resetPromptHistoryOutbox,
  __setRetryLadderForTest,
} from "../lib/prompt-history-api";
import type { HistoryEntry } from "../lib/prompt-history-store";

const realFetch = globalThis.fetch;
const realXhr = globalThis.XMLHttpRequest;

let posted: { body: Record<string, unknown> }[] = [];
/** Number of POSTs still to reject before the stub starts succeeding. */
let failuresRemaining = 0;
let nextId = 1;

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

function installFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input.toString();
    const url = new URL(raw, "http://localhost");
    if (url.pathname === "/api/prompt-history" && (init?.method ?? "GET") === "POST") {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("connection refused");
      }
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      posted.push({ body });
      const id = nextId;
      nextId += 1;
      return jsonResponse(200, { id });
    }
    return jsonResponse(404, {});
  }) as unknown as typeof fetch;
}

function entry(sessionId: string, text: string, id: string): HistoryEntry {
  return {
    id,
    sessionId,
    projectPath: "/p",
    route: ">",
    text,
    atoms: [],
    timestamp: 1_700_000_000_000,
  };
}

beforeEach(() => {
  posted = [];
  failuresRemaining = 0;
  nextId = 1;
  installFetch();
  // The real ladder is 1s/5s/30s then per-minute. Same rung count, same
  // shape, milliseconds instead of seconds.
  __setRetryLadderForTest([1, 2, 3], 4);
});

afterEach(() => {
  __resetPromptHistoryOutbox();
  globalThis.fetch = realFetch;
  globalThis.XMLHttpRequest = realXhr;
});

// ---------------------------------------------------------------------------
// appendPromptHistory
// ---------------------------------------------------------------------------

describe("appendPromptHistory", () => {
  test("POSTs the entry in the wire's snake_case shape and resolves the row id", async () => {
    const id = await appendPromptHistory(entry("s1", "hello", "c1"));

    expect(id).toBe(1);
    expect(posted.length).toBe(1);
    expect(posted[0].body).toEqual({
      session_id: "s1",
      route: ">",
      text: "hello",
      atoms: [],
      project_path: "/p",
      submitted_at_ms: 1_700_000_000_000,
      client_entry_id: "c1",
    });
  });

  test("a failed append is retried rather than dropped", async () => {
    failuresRemaining = 1;
    const landed = appendPromptHistory(entry("s1", "survives", "c1"));

    // The first attempt failed; the entry is still in the outbox.
    await new Promise((r) => setTimeout(r, 0));
    expect(posted.length).toBe(0);
    expect(pendingAppendCount()).toBe(1);

    expect(await landed).toBe(1);
    expect(posted.length).toBe(1);
    expect(posted[0].body.client_entry_id).toBe("c1");
    expect(pendingAppendCount()).toBe(0);
  });

  test("a failing append holds later same-session appends behind it", async () => {
    failuresRemaining = 1;
    const first = appendPromptHistory(entry("s1", "one", "c1"));
    const second = appendPromptHistory(entry("s1", "two", "c2"));

    const [firstId, secondId] = await Promise.all([first, second]);

    // Submit order is id order — the retry did not let "two" overtake "one".
    expect(firstId).toBe(1);
    expect(secondId).toBe(2);
    expect(posted.map((p) => p.body.text)).toEqual(["one", "two"]);
  });

  test("a stalled session does not block a different session", async () => {
    // Fail enough times that session A is still retrying when B is asked.
    failuresRemaining = 1;
    const a = appendPromptHistory(entry("sA", "from A", "cA"));
    const b = appendPromptHistory(entry("sB", "from B", "cB"));

    // B has no failed head of its own, so it lands on the first pass — before
    // A's retry timer has even fired.
    expect(await b).toBe(1);
    expect(await a).toBe(2);
  });

  test("outliving the fast retry rungs publishes a visible failure", async () => {
    const notices: string[] = [];
    subscribeAppendFailures((n) => notices.push(n.text));

    // Three failures spends the fast ladder (1s, 5s, 30s).
    failuresRemaining = 3;
    const landed = appendPromptHistory(entry("s1", "unlucky prompt", "c1"));
    await landed;

    expect(notices).toEqual(["unlucky prompt"]);
    // And it still landed — the notice is about visibility, not surrender.
    expect(posted.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// flushPromptHistorySync
// ---------------------------------------------------------------------------

describe("flushPromptHistorySync", () => {
  test("drains queued appends with blocking requests, in submit order", async () => {
    const sent: string[] = [];
    globalThis.XMLHttpRequest = class {
      status = 0;
      responseText = "";
      private _body = "";
      open(): void {}
      setRequestHeader(): void {}
      send(body: string): void {
        this._body = body;
        sent.push((JSON.parse(this._body) as { text: string }).text);
        this.status = 200;
        this.responseText = JSON.stringify({ id: sent.length });
      }
    } as unknown as typeof XMLHttpRequest;

    // Wedge the queue: the first append fails and parks, so both entries are
    // still pending when the page goes away.
    failuresRemaining = 1;
    void appendPromptHistory(entry("s1", "one", "c1"));
    void appendPromptHistory(entry("s1", "two", "c2"));
    await new Promise((r) => setTimeout(r, 0));
    expect(pendingAppendCount()).toBe(2);

    flushPromptHistorySync();

    expect(sent).toEqual(["one", "two"]);
    expect(pendingAppendCount()).toBe(0);
  });

  test("a rejected sync write leaves the entry queued rather than losing it", async () => {
    globalThis.XMLHttpRequest = class {
      status = 0;
      responseText = "";
      open(): void {}
      setRequestHeader(): void {}
      send(): void {
        this.status = 503;
      }
    } as unknown as typeof XMLHttpRequest;

    failuresRemaining = 1;
    void appendPromptHistory(entry("s1", "one", "c1"));
    await new Promise((r) => setTimeout(r, 0));

    flushPromptHistorySync();

    expect(pendingAppendCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("fetchPromptHistoryPage", () => {
  test("maps wire rows onto HistoryEntry and carries the cursor fields", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://localhost");
      expect(url.searchParams.get("session")).toBe("s1");
      expect(url.searchParams.get("before")).toBe("42");
      expect(url.searchParams.get("limit")).toBe("10");
      return jsonResponse(200, {
        entries: [
          {
            id: 7,
            session_id: "s1",
            route: "$",
            text: "ls",
            atoms: [],
            project_path: "/p",
            submitted_at_ms: 99,
            client_entry_id: "c7",
          },
        ],
        has_more: true,
        before: 42,
      });
    }) as unknown as typeof fetch;

    const page = await fetchPromptHistoryPage("s1", 42, 10);

    expect(page.hasMore).toBe(true);
    expect(page.before).toBe(42);
    expect(page.entries).toEqual([
      {
        id: "c7",
        ledgerId: 7,
        sessionId: "s1",
        projectPath: "/p",
        route: "$",
        text: "ls",
        atoms: [],
        timestamp: 99,
      },
    ]);
  });

  test("a non-2xx page response rejects rather than reporting an empty corpus", async () => {
    globalThis.fetch = (async () => jsonResponse(500, {})) as unknown as typeof fetch;
    await expect(fetchPromptHistoryPage("s1")).rejects.toThrow();
  });
});

describe("patchPromptAtomPath", () => {
  test("reports the route's ok flag", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, { ok: false })) as unknown as typeof fetch;
    expect(await patchPromptAtomPath("c1", "a1", "/x.png")).toBe(false);

    globalThis.fetch = (async () =>
      jsonResponse(200, { ok: true })) as unknown as typeof fetch;
    expect(await patchPromptAtomPath("c1", "a1", "/x.png")).toBe(true);
  });

  test("a transport failure resolves false instead of throwing", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await patchPromptAtomPath("c1", "a1", "/x.png")).toBe(false);
  });
});
