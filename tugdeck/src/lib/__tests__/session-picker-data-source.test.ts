/**
 * Pure-logic tests for the Sessions picker data source: row
 * computation over a `(projectDir, ledger snapshot, filter query)` triple. No
 * DOM — the rendered treatment (badges, disabled rows) is covered by app-tests.
 */

import { describe, expect, test } from "bun:test";

import { SessionsDataSource } from "@/lib/session-picker-data-source";
import type { WorkspaceSnapshot } from "@/lib/session-ledger-store";
import type { SessionRow } from "@/protocol";

function makeRow(partial: Partial<SessionRow> & { session_id: string }): SessionRow {
  return {
    session_id: partial.session_id,
    line_id: partial.line_id ?? partial.session_id,
    workspace_key: partial.workspace_key ?? "ws-1",
    project_dir: partial.project_dir ?? "/proj",
    created_at: partial.created_at ?? 1,
    last_used_at: partial.last_used_at ?? 1,
    turn_count: partial.turn_count ?? 1,
    last_user_prompt: partial.last_user_prompt ?? "hello",
    state: partial.state ?? "closed",
    card_id: partial.card_id ?? null,
    name: partial.name ?? null,
    name_user_set: partial.name_user_set ?? false,
    tag: partial.tag ?? null,
    synopsis: partial.synopsis ?? null,
    origin: partial.origin ?? "tug",
    terminal_live: partial.terminal_live ?? null,
    file_size: partial.file_size ?? null,
  };
}

function readySnapshot(rows: SessionRow[]): WorkspaceSnapshot {
  return { status: "ready", rows, dirExists: true } as WorkspaceSnapshot;
}

function rowsOf(ds: SessionsDataSource): string[] {
  const out: string[] = [];
  for (let i = 0; i < ds.numberOfItems(); i++) {
    const row = ds.rowAt(i);
    out.push(row.kind === "session-resume" ? row.row.session_id : row.kind);
  }
  return out;
}

describe("SessionsDataSource fuzzy filter", () => {
  const ledger = () =>
    readySnapshot([
      makeRow({ session_id: "a", tag: "azure-heron", turn_count: 1 }),
      makeRow({ session_id: "b", tag: "coral-otter", name: "Parser fix", turn_count: 1 }),
      makeRow({
        session_id: "c",
        tag: "misty-lynx",
        last_user_prompt: "refactor the parser",
        turn_count: 1,
      }),
    ]);

  const filtered = (
    filterQuery: string,
    dropNewRowWhenFiltering = false,
  ): SessionsDataSource =>
    new SessionsDataSource({
      projectDir: "/proj",
      ledger: ledger(),
      filterQuery,
      dropNewRowWhenFiltering,
    });

  test("empty filter keeps session-new + every visible row", () => {
    expect(rowsOf(filtered(""))).toEqual(["session-new", "a", "b", "c"]);
    expect(rowsOf(filtered("   "))).toEqual(["session-new", "a", "b", "c"]);
  });

  test("a tag fragment narrows to the matching row", () => {
    expect(rowsOf(filtered("heron"))).toEqual(["session-new", "a"]);
  });

  test("matching is fuzzy, not substring-only", () => {
    // Subsequence tier: `prsfx` threads through "Parser fix".
    expect(rowsOf(filtered("prsfx"))).toEqual(["session-new", "b"]);
  });

  test("the filter matches name, prompt, and session id", () => {
    expect(rowsOf(filtered("parser fix"))).toEqual(["session-new", "b"]);
    expect(rowsOf(filtered("refactor"))).toEqual(["session-new", "c"]);
    expect(rowsOf(filtered("misty"))).toEqual(["session-new", "c"]);
  });

  test("every term must match, across any of a row's fields", () => {
    // "otter" is b's tag, "parser" its name — both on the same row.
    expect(rowsOf(filtered("otter parser"))).toEqual(["session-new", "b"]);
    // "heron" is a's tag, "parser" is not on a.
    expect(rowsOf(filtered("heron parser"))).toEqual(["session-new"]);
  });

  test("a legacy tagless row is still matchable by its id", () => {
    // Every row carries a real minted callsign after its first scan; a row
    // that predates that is matched by the fields it does have.
    const ds = new SessionsDataSource({
      projectDir: "/proj",
      ledger: readySnapshot([makeRow({ session_id: "untagged", turn_count: 1 })]),
      filterQuery: "untagged",
    });
    expect(rowsOf(ds)).toEqual(["session-new", "untagged"]);
  });

  test("dropNewRowWhenFiltering yields a truly empty list on a non-match", () => {
    expect(rowsOf(filtered("nonexistent", true))).toEqual([]);
    expect(rowsOf(filtered("heron", true))).toEqual(["a"]);
    // …and keeps the row when there is no filter at all.
    expect(rowsOf(filtered("", true))).toEqual(["session-new", "a", "b", "c"]);
  });

  test("the picker keeps session-new under any query", () => {
    expect(rowsOf(filtered("nonexistent"))).toEqual(["session-new"]);
  });

  test("hasVisibleSession answers in filtered coordinates", () => {
    const ds = filtered("heron");
    expect(ds.hasVisibleSession("a")).toBe(true);
    expect(ds.hasVisibleSession("b")).toBe(false);
    expect(filtered("").hasVisibleSession("b")).toBe(true);
  });

  test("firstResumeIndex skips session-new and reports no match as undefined", () => {
    expect(filtered("").firstResumeIndex()).toBe(1);
    expect(filtered("refactor").firstResumeIndex()).toBe(1);
    expect(filtered("nonexistent").firstResumeIndex()).toBeUndefined();
    expect(filtered("heron", true).firstResumeIndex()).toBe(0);
  });

  test("nonLiveCount ignores the filter — the trash sweep is per-path", () => {
    expect(filtered("heron").nonLiveCount()).toBe(3);
    expect(filtered("nonexistent").nonLiveCount()).toBe(3);
  });

  test("a long prompt does not swallow every query", () => {
    // The picker's rows carry whole prompts. Counting a scattered in-order
    // character run through one as a match made the filter a no-op: every row
    // survived every short query.
    const wordy = readySnapshot([
      makeRow({
        session_id: "wordy",
        turn_count: 1,
        last_user_prompt:
          "Please refactor the transcript entry component so the commit receipt block lines up with the rest of the card chrome",
      }),
    ]);
    const query = (q: string): string[] =>
      rowsOf(
        new SessionsDataSource({
          projectDir: "/proj",
          ledger: wordy,
          filterQuery: q,
        }),
      );
    expect(query("scarp")).toEqual(["session-new"]);
    // A word the prompt really contains still finds it.
    expect(query("receipt")).toEqual(["session-new", "wordy"]);
  });

  test("the strongest match leads, and session-new stays pinned at the top", () => {
    const ledgerRows = readySnapshot([
      makeRow({ session_id: "loose", name: "the ledger of record", turn_count: 1 }),
      makeRow({ session_id: "exact", name: "ledger", turn_count: 1 }),
      makeRow({ session_id: "prefix", name: "ledger-store", turn_count: 1 }),
    ]);
    const ds = new SessionsDataSource({
      projectDir: "/proj",
      ledger: ledgerRows,
      filterQuery: "ledger",
    });
    expect(rowsOf(ds)).toEqual(["session-new", "exact", "prefix", "loose"]);
    // The cursor seed skips the pinned affordance and lands on the best match.
    expect(ds.firstResumeIndex()).toBe(1);
  });

  test("clearing the query restores the ledger's newest-first order", () => {
    const ledgerRows = readySnapshot([
      makeRow({ session_id: "newest", name: "the ledger of record", turn_count: 1 }),
      makeRow({ session_id: "older", name: "ledger", turn_count: 1 }),
    ]);
    const ds = new SessionsDataSource({
      projectDir: "/proj",
      ledger: ledgerRows,
      filterQuery: "",
    });
    expect(rowsOf(ds)).toEqual(["session-new", "newest", "older"]);
  });
});

describe("SessionsDataSource with external rows", () => {
  test("external rows list exactly like ledger rows, in snapshot order", () => {
    const ds = new SessionsDataSource({
      projectDir: "/proj",
      ledger: readySnapshot([
        makeRow({ session_id: "ext-1", origin: "external", last_used_at: 9 }),
        makeRow({ session_id: "tug-1", origin: "tug", last_used_at: 5 }),
      ]),
    });
    expect(rowsOf(ds)).toEqual(["session-new", "ext-1", "tug-1"]);
  });

  test("zero-turn external rows are hidden like zero-turn ledger rows", () => {
    const ds = new SessionsDataSource({
      projectDir: "/proj",
      ledger: readySnapshot([
        makeRow({ session_id: "ext-empty", origin: "external", turn_count: 0 }),
        makeRow({ session_id: "ext-real", origin: "external", turn_count: 2 }),
      ]),
    });
    expect(rowsOf(ds)).toEqual(["session-new", "ext-real"]);
  });

  test("content-bearing (file_size > 0) zero-count row is still visible", () => {
    // [P09]/[R06]: visibility is decoupled from the strict turn count. A
    // scanned external row with on-disk bytes but a (correctly) zero count
    // must NOT vanish from the picker.
    const ds = new SessionsDataSource({
      projectDir: "/proj",
      ledger: readySnapshot([
        makeRow({
          session_id: "ext-bytes",
          origin: "external",
          turn_count: 0,
          file_size: 2048,
        }),
        // No bytes, no turns, not live → genuinely empty, stays hidden.
        makeRow({ session_id: "ext-void", origin: "external", turn_count: 0 }),
      ]),
    });
    expect(rowsOf(ds)).toEqual(["session-new", "ext-bytes"]);
  });

  test("a live zero-count row is visible (file_size is null for tug/live rows)", () => {
    const ds = new SessionsDataSource({
      projectDir: "/proj",
      ledger: readySnapshot([
        makeRow({ session_id: "tug-live", state: "live", turn_count: 0 }),
        // Non-live tug row with no turns and no bytes → hidden.
        makeRow({ session_id: "tug-empty", state: "closed", turn_count: 0 }),
      ]),
    });
    expect(rowsOf(ds)).toEqual(["session-new", "tug-live"]);
  });

  test("nonLiveCount tracks content by bytes OR canonical turns", () => {
    const ds = new SessionsDataSource({
      projectDir: "/proj",
      ledger: readySnapshot([
        makeRow({ session_id: "a", state: "closed", turn_count: 3 }),
        makeRow({
          session_id: "b",
          state: "closed",
          turn_count: 0,
          file_size: 1024,
        }),
        makeRow({ session_id: "c", state: "live", turn_count: 0 }), // live, excluded
        makeRow({ session_id: "d", state: "closed", turn_count: 0 }), // empty, excluded
      ]),
    });
    expect(ds.nonLiveCount()).toBe(2);
  });

  test("terminal-live rows are still listed (blocking is via enabledForIndex)", () => {
    const ds = new SessionsDataSource({
      projectDir: "/proj",
      ledger: readySnapshot([
        makeRow({
          session_id: "held",
          origin: "external",
          terminal_live: { status: "busy" },
        }),
      ]),
    });
    expect(rowsOf(ds)).toEqual(["session-new", "held"]);
    const row = ds.rowAt(1);
    if (row.kind !== "session-resume") throw new Error("expected resume row");
    expect(row.row.terminal_live).toEqual({ status: "busy" });
  });
});

describe("SessionsDataSource.enabledForIndex", () => {
  test("live and terminal-live rows are disabled; the rest are enabled", () => {
    const ds = new SessionsDataSource({
      projectDir: "/proj",
      ledger: readySnapshot([
        makeRow({ session_id: "pickable", state: "closed", turn_count: 3 }),
        makeRow({ session_id: "live", state: "live", turn_count: 1 }),
        makeRow({
          session_id: "held",
          origin: "external",
          terminal_live: { status: "idle" },
        }),
      ]),
    });
    // Rows: [session-new, pickable, live, held].
    expect(rowsOf(ds)).toEqual(["session-new", "pickable", "live", "held"]);
    expect(ds.enabledForIndex(0)).toBe(true); // session-new
    expect(ds.enabledForIndex(1)).toBe(true); // closed, has turns
    expect(ds.enabledForIndex(2)).toBe(false); // live in another card
    expect(ds.enabledForIndex(3)).toBe(false); // in use in a terminal
  });

  test("the pending loading row is enabled (sole row, never cursored past)", () => {
    const ds = new SessionsDataSource({
      projectDir: "/proj",
      ledger: { status: "pending", rows: [], dirExists: true } as WorkspaceSnapshot,
    });
    expect(rowsOf(ds)).toEqual(["loading"]);
    expect(ds.enabledForIndex(0)).toBe(true);
  });
});
