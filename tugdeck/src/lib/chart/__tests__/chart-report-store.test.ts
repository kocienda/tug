/**
 * `chart-report-store` — the narrowing of the endpoint's answer, the page
 * reducer, what the next read asks for, and the report's words.
 */

import { describe, expect, test } from "bun:test";

import {
  applyReportPage,
  driftNote,
  dropReport,
  footText,
  groupBreaks,
  narrowReport,
  nextRequest,
  receiveReportPage,
  registerReport,
  reportState,
  reportTitle,
  type ReportDescriptor,
  type ReportPage,
} from "../chart-report-store";

const SHA = "63de5762a9c1f0e4b7d2a8c5e3f1b6d9a0c4e7f2";

function commitRow(sha: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "commit",
    ref: `commit:${sha}`,
    found: true,
    measure: null,
    measure_text: null,
    group: null,
    commit: {
      sha,
      subject: "Fix the thing",
      body: "Why it was broken.",
      author: "A. Author",
      date: "2026-10-23",
      committer: "A. Author",
      committer_email: "a@example.com",
      committer_date: "2026-10-23T09:14:02-08:00",
      tug_arc: "tugarc/demo onto main",
      files: ["src/app.ts", 7],
    },
    ...extra,
  };
}

function okBody(rows: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: "ok", total: rows.length, moved: false, sum: null, sum_text: null, measure: null, rows, ...extra };
}

function page(rows: unknown[], extra: Record<string, unknown> = {}): ReportPage {
  return narrowReport(okBody(rows, extra));
}

function membersDescriptor(id: string, slotCount = 57): ReportDescriptor {
  return {
    id,
    projectDir: "/repo",
    kind: "commit",
    rowLabel: "2026-10-23",
    seriesName: null,
    slotCount,
    source: { recipe: "commits", args: { since: "2026-10-18", until: "2026-11-16T09:14:02-08:00", by: "day" } },
    address: { row: 5, label: "2026-10-23", col: null, series: null, item: null, whole_row: false },
  };
}

describe("narrowReport", () => {
  test("keeps a well-formed commit row with its record", () => {
    const narrowed = page([commitRow(SHA)]);
    if (!narrowed.ok) throw new Error("expected a page");
    expect(narrowed.total).toBe(1);
    expect(narrowed.received).toBe(1);
    const row = narrowed.rows[0]!;
    expect(row.kind).toBe("commit");
    expect(row.ref).toBe(`commit:${SHA}`);
    expect(row.found).toBe(true);
    expect(row.commit?.sha).toBe(SHA);
    expect(row.commit?.body).toBe("Why it was broken.");
    expect(row.commit?.tug_arc).toBe("tugarc/demo onto main");
    expect(row.commit?.files, "a path that is not a string is dropped").toEqual(["src/app.ts"]);
  });

  test("drops a row of a kind it does not know, and still says how far the read got", () => {
    const narrowed = page([commitRow(SHA), { kind: "galaxy", ref: "galaxy:m31", found: true }, 7]);
    if (!narrowed.ok) throw new Error("expected a page");
    expect(narrowed.rows.map((r) => r.kind)).toEqual(["commit"]);
    expect(narrowed.received).toBe(3);
  });

  test("a found commit whose record does not read is an unfound row", () => {
    const narrowed = page([commitRow(SHA, { commit: { sha: SHA } }), { kind: "file", ref: "file:a.ts", found: false }]);
    if (!narrowed.ok) throw new Error("expected a page");
    expect(narrowed.rows[0]!.found).toBe(false);
    expect(narrowed.rows[0]!.commit).toBeUndefined();
    expect(narrowed.rows[1]).toEqual({
      kind: "file",
      ref: "file:a.ts",
      found: false,
      measure: null,
      measureText: null,
      group: null,
    });
  });

  test("reads the measure, the sum and each row's text", () => {
    const narrowed = page([commitRow(SHA, { measure: 120, measure_text: "120", group: "feat" })], {
      total: 57,
      sum: 1840,
      sum_text: "1.8k",
      measure: { unit: "lines", format: "count" },
    });
    if (!narrowed.ok) throw new Error("expected a page");
    expect(narrowed.total).toBe(57);
    expect(narrowed.sum).toBe(1840);
    expect(narrowed.sumText).toBe("1.8k");
    expect(narrowed.measure).toEqual({ unit: "lines", format: "count" });
    expect(narrowed.rows[0]!.measure).toBe(120);
    expect(narrowed.rows[0]!.measureText).toBe("120");
    expect(narrowed.rows[0]!.group).toBe("feat");
  });

  test("a text that is not a string is dropped, and the number beside it stands", () => {
    const narrowed = page([commitRow(SHA, { measure: 120, measure_text: 120 })], {
      sum: 1840,
      sum_text: { text: "1.8k" },
      measure: { unit: "lines", format: "count" },
    });
    if (!narrowed.ok) throw new Error("expected an ok page");
    expect(narrowed.sum).toBe(1840);
    expect(narrowed.sumText).toBeNull();
    expect(narrowed.rows[0]!.measure).toBe(120);
    expect(narrowed.rows[0]!.measureText).toBeNull();
  });

  test("keeps a session row's record, and an unfound or unreadable one is plain", () => {
    const record = {
      id: "048e4155-f644-46f7-a839-d22ac02a564f",
      callsign: "mighty-cabin",
      project_dir: "/u/src/demo",
      project_leaf: "demo",
      title: null,
      updated_at_ms: 1_763_000_000_000,
    };
    const row = { kind: "session", ref: "session:048e4155", measure: 12, measure_text: "12", group: null };
    const narrowed = page([
      { ...row, found: true, session: record },
      { ...row, found: false },
      { ...row, found: true, session: { ...record, id: "" } },
    ]);
    if (!narrowed.ok) throw new Error("expected a page");
    expect(narrowed.rows[0]!.session).toEqual({
      id: record.id,
      callsign: "mighty-cabin",
      projectDir: "/u/src/demo",
      projectLeaf: "demo",
      title: null,
      updatedAtMs: 1_763_000_000_000,
    });
    expect(narrowed.rows[0]!.measureText).toBe("12");
    expect(narrowed.rows[1]).toMatchObject({ kind: "session", found: false, ref: "session:048e4155" });
    expect(narrowed.rows[1]!.session).toBeUndefined();
    expect(narrowed.rows[2]!.found).toBe(false);
  });

  test("keeps an arc row's record, and an unfound one or one of no known fate is plain", () => {
    const record = {
      name: "chart-ref-reports",
      fate: "joined",
      join_sha: "7d16f2ac6",
      started_at_ms: 1_763_000_000_000,
      ended_at_ms: 1_763_000_600_000,
      step_commits: 11,
    };
    const row = { kind: "arc", ref: "arc:chart-ref-reports", measure: null, measure_text: null, group: null };
    const narrowed = page([
      { ...row, found: true, arc: record },
      { ...row, found: false },
      { ...row, found: true, arc: { ...record, fate: "paused" } },
      { ...row, found: true, arc: { name: "bare", fate: "live" } },
    ]);
    if (!narrowed.ok) throw new Error("expected a page");
    expect(narrowed.rows[0]!.arc).toEqual({
      name: "chart-ref-reports",
      fate: "joined",
      joinSha: "7d16f2ac6",
      startedAtMs: 1_763_000_000_000,
      endedAtMs: 1_763_000_600_000,
      stepCommits: 11,
    });
    expect(narrowed.rows[1]).toMatchObject({ kind: "arc", found: false });
    expect(narrowed.rows[2]!.found).toBe(false);
    expect(narrowed.rows[3]!.arc).toEqual({
      name: "bare",
      fate: "live",
      joinSha: null,
      startedAtMs: null,
      endedAtMs: null,
      stepCommits: 0,
    });
  });

  test("keeps a file's, a directory's, a command's and a url's record", () => {
    const bare = { found: true, measure: null, measure_text: null, group: null };
    const read = page([
      { ...bare, kind: "file", ref: "file:src/app.ts", path: { path: "src/app.ts", exists: true, commits: 12 } },
      { ...bare, kind: "dir", ref: "dir:/tmp/out", path: { path: "/tmp/out", exists: false, commits: null } },
      { ...bare, kind: "command", ref: "command:cargo build", command: { head: "cargo build", count: 2, total_ms: 75_000 } },
      { ...bare, kind: "command", ref: "command:ls", command: { head: "ls", count: null, total_ms: null } },
      { ...bare, kind: "url", ref: "url:https://example.com/a?q=1", url: { host: "example.com", path: "/a?q=1" } },
      { ...bare, kind: "url", ref: "url:https://example.com", url: { host: "example.com" } },
    ]);
    if (!read.ok) throw new Error("expected a page");
    expect(read.rows.map((row) => row.found)).toEqual([true, true, true, true, true, true]);
    expect(read.rows[0].path).toEqual({ path: "src/app.ts", exists: true, commits: 12 });
    expect(read.rows[1].path).toEqual({ path: "/tmp/out", exists: false, commits: null });
    expect(read.rows[2].command).toEqual({ head: "cargo build", count: 2, totalMs: 75_000 });
    expect(read.rows[3].command).toEqual({ head: "ls", count: null, totalMs: null });
    expect(read.rows[4].url).toEqual({ host: "example.com", path: "/a?q=1" });
    expect(read.rows[5].url).toEqual({ host: "example.com", path: "" });
  });

  test("a path, a command or a url whose record does not read is plain", () => {
    const bare = { found: true, measure: null, measure_text: null, group: null };
    const read = page([
      { ...bare, kind: "file", ref: "file:src/app.ts", path: { exists: true } },
      { ...bare, kind: "command", ref: "command:ls", command: {} },
      { ...bare, kind: "url", ref: "url:https://example.com" },
      { ...bare, kind: "file", ref: "file:gone.ts", found: false },
    ]);
    if (!read.ok) throw new Error("expected a page");
    expect(read.rows.map((row) => row.found)).toEqual([false, false, false, false]);
    expect(read.rows.every((row) => row.path === undefined && row.command === undefined && row.url === undefined)).toBe(
      true,
    );
  });

  test("keeps a run's and a span's record, with what each stands on", () => {
    const bare = { found: true, measure: null, measure_text: null, group: null };
    const read = page([
      {
        ...bare,
        kind: "run",
        ref: `commit:${SHA.slice(0, 8)}`,
        run: { status: "FAIL", ended_at: 1_700_000_000, secs: 7, passed: 2, total: 3, head_sha: SHA, commit: commitRow(SHA).commit },
      },
      { ...bare, kind: "run", ref: null, run: { status: "PASS", ended_at: 1, secs: 4, passed: 3, total: 3, head_sha: "unknown" } },
      {
        ...bare,
        kind: "span",
        ref: "session:048e4155",
        span: { label: "Implement", start_ms: 1_000, end_ms: 4_000, status: null },
        session: { id: "048e4155-f644-46f7-a839-d22ac02a564f", callsign: "mighty-cabin", updated_at_ms: 5 },
      },
      { ...bare, kind: "span", ref: `commit:${SHA.slice(0, 8)}`, span: { label: "1/3 First", start_ms: 2, end_ms: 9, status: "good" }, commit: commitRow(SHA).commit },
      { ...bare, kind: "span", ref: null, span: { label: "Audit", start_ms: 2, end_ms: 9 } },
      { ...bare, kind: "run", ref: null, run: { ended_at: 1 } },
    ]);
    if (!read.ok) throw new Error("expected a page");
    expect(read.rows.map((row) => row.found)).toEqual([true, true, true, true, true, false]);
    expect(read.rows[0].run).toMatchObject({
      status: "FAIL",
      endedAtMs: 1_700_000_000_000,
      durationMs: 7_000,
      passed: 2,
      total: 3,
      headSha: SHA,
    });
    expect(read.rows[0].run?.commit?.sha).toBe(SHA);
    expect(read.rows[0].commit, "the commit is the run's, not the row's").toBeUndefined();
    expect(read.rows[1].run?.commit).toBeUndefined();
    expect(read.rows[2].span).toEqual({ label: "Implement", startMs: 1_000, endMs: 4_000, status: null });
    expect(read.rows[2].session?.callsign).toBe("mighty-cabin");
    expect(read.rows[3].commit?.sha).toBe(SHA);
    expect(read.rows[4].span?.status).toBeNull();
    expect(read.rows[4].session === undefined && read.rows[4].commit === undefined).toBe(true);
  });

  test("a body that is not ok is an error with its message", () => {
    expect(narrowReport({ status: "error", message: "unknown recipe" })).toEqual({
      ok: false,
      message: "unknown recipe",
    });
    expect(narrowReport({ status: "error" })).toEqual({ ok: false, message: "the read failed" });
    expect(narrowReport({ status: "ok", rows: [] })).toEqual({ ok: false, message: "the answer was malformed" });
    expect(narrowReport({ status: "ok", total: 3 })).toEqual({ ok: false, message: "the answer was malformed" });
    expect(narrowReport("nope")).toEqual({ ok: false, message: "the answer was not an object" });
  });
});

describe("the page reducer", () => {
  test("a page appends, sets the total and moves the read on", () => {
    registerReport(membersDescriptor("t-append"));
    const before = reportState("t-append");
    expect(before.phase).toBe("loading");
    expect(before.total).toBeNull();

    receiveReportPage("t-append", page([commitRow(SHA)], { total: 57 }));
    const first = reportState("t-append");
    expect(first.phase).toBe("ready");
    expect(first.rows).toHaveLength(1);
    expect(first.total).toBe(57);
    expect(first.fetched).toBe(1);

    receiveReportPage("t-append", page([commitRow("a".repeat(40)), commitRow("b".repeat(40))], { total: 57 }));
    const second = reportState("t-append");
    expect(second.rows.map((r) => r.ref)).toEqual([
      `commit:${SHA}`,
      `commit:${"a".repeat(40)}`,
      `commit:${"b".repeat(40)}`,
    ]);
    expect(second.fetched).toBe(3);
    dropReport("t-append");
  });

  test("the sum and the measure come with the first page and stand across the second", () => {
    registerReport(membersDescriptor("t-measure"));
    const measured = { total: 3, sum: 1840, sum_text: "1.8k", measure: { unit: "lines", format: "count" } };
    receiveReportPage("t-measure", page([commitRow(SHA, { measure: 120, measure_text: "120" })], measured));
    const first = reportState("t-measure");
    expect(first.sum).toBe(1840);
    expect(first.sumText).toBe("1.8k");
    expect(first.measure).toEqual({ unit: "lines", format: "count" });

    receiveReportPage(
      "t-measure",
      page([commitRow("a".repeat(40), { measure: 1720, measure_text: "1.7k" })], measured),
    );
    const second = reportState("t-measure");
    expect(second.sum).toBe(1840);
    expect(second.sumText).toBe("1.8k");
    expect(second.measure).toEqual({ unit: "lines", format: "count" });
    expect(second.rows.map((r) => r.measureText)).toEqual(["120", "1.7k"]);
    dropReport("t-measure");
  });

  test("an answer for a dropped report is discarded", () => {
    registerReport(membersDescriptor("t-dropped"));
    dropReport("t-dropped");
    receiveReportPage("t-dropped", page([commitRow(SHA)]));
    const state = reportState("t-dropped");
    expect(state.descriptor).toBeNull();
    expect(state.rows).toHaveLength(0);
  });

  test("an error leaves the rows read so far alone", () => {
    registerReport(membersDescriptor("t-error"));
    receiveReportPage("t-error", page([commitRow(SHA)], { total: 57 }));
    receiveReportPage("t-error", { ok: false, message: "the read took too long" });
    const state = reportState("t-error");
    expect(state.phase).toBe("error");
    expect(state.error).toBe("the read took too long");
    expect(state.rows).toHaveLength(1);
    expect(state.total).toBe(57);
    expect(state.fetched).toBe(1);
    // The next good page clears the error and appends.
    const healed = applyReportPage(state, page([commitRow("a".repeat(40))], { total: 57 }));
    expect(healed.phase).toBe("ready");
    expect(healed.error).toBeNull();
    expect(healed.rows).toHaveLength(2);
    dropReport("t-error");
  });

  test("a describe report's total is its member list, whatever one page says", () => {
    const refs = Array.from({ length: 30 }, (_, i) => `commit:${String(i).padStart(8, "0")}`);
    registerReport({
      id: "t-describe",
      projectDir: "/repo",
      kind: "commit",
      rowLabel: null,
      seriesName: null,
      slotCount: 30,
      refs,
    });
    expect(nextRequest(reportState("t-describe"))).toEqual({ project: "/repo", refs: refs.slice(0, 25) });
    receiveReportPage(
      "t-describe",
      page(refs.slice(0, 25).map((ref) => ({ kind: "commit", ref, found: false }))),
    );
    const state = reportState("t-describe");
    expect(state.total).toBe(30);
    expect(state.fetched).toBe(25);
    expect(nextRequest(state)).toEqual({ project: "/repo", refs: refs.slice(25) });
    dropReport("t-describe");
  });

  test("a members report asks by offset, with the source and the address", () => {
    const descriptor = membersDescriptor("t-members");
    registerReport(descriptor);
    receiveReportPage("t-members", page([commitRow(SHA)], { total: 57 }));
    expect(nextRequest(reportState("t-members"))).toEqual({
      project: "/repo",
      source: descriptor.source,
      address: descriptor.address,
      offset: 1,
      limit: 25,
    });
    dropReport("t-members");
    expect(nextRequest(reportState("t-members"))).toBeNull();
  });

  test("a path report asks for the path by offset, with the source when one rides along", () => {
    const of = "file:tugdeck/src/app.ts";
    registerReport({ id: "t-path", projectDir: "/repo", kind: "commit", rowLabel: null, seriesName: null, slotCount: 30, of });
    expect(nextRequest(reportState("t-path"))).toEqual({ project: "/repo", of, offset: 0, limit: 25 });
    receiveReportPage("t-path", page([commitRow(SHA)], { total: 30 }));
    expect(nextRequest(reportState("t-path"))).toEqual({ project: "/repo", of, offset: 1, limit: 25 });
    expect(driftNote(reportState("t-path")), "a path's list is not a mark that can drift").toBeNull();
    dropReport("t-path");

    const source = membersDescriptor("unused").source;
    registerReport({
      id: "t-path-window",
      projectDir: "/repo",
      kind: "commit",
      rowLabel: null,
      seriesName: null,
      slotCount: 3,
      of,
      source,
    });
    expect(nextRequest(reportState("t-path-window"))).toEqual({ project: "/repo", of, source, offset: 0, limit: 25 });
    receiveReportPage("t-path-window", page([commitRow(SHA)], { total: 9 }));
    expect(driftNote(reportState("t-path-window"))).toBeNull();
    dropReport("t-path-window");
  });
});

describe("the report's words", () => {
  test("a title names the row, the series for a cell, and the count", () => {
    expect(reportTitle("2026-10-23", null, 57, "commit")).toBe("2026-10-23 · 57 commits");
    expect(reportTitle("2026-10-23", "feat", 12, "commit")).toBe("2026-10-23 · feat · 12 commits");
    expect(reportTitle("2026-10-23", null, 1, "commit")).toBe("2026-10-23 · 1 commit");
    expect(reportTitle(null, null, 3, "file")).toBe("3 files");
  });

  test("a single report's title is the mark's label alone", () => {
    expect(reportTitle("at0312-focus-order", null, 1, "run", true)).toBe("at0312-focus-order");
    expect(reportTitle("Implement", null, 1, "span", true)).toBe("Implement");
    expect(reportTitle(null, null, 1, "run", true), "with no label the count still names it").toBe("1 run");
    expect(reportTitle("at0312-focus-order", null, 20, "run")).toBe("at0312-focus-order · 20 runs");
  });

  test("a group heading goes before each row whose group changes", () => {
    const row = (group: string | null): unknown => ({ ...commitRow(SHA), group });
    const read = page([row("feat"), row("feat"), row("fix"), row(null), row("fix"), row("fix")]);
    if (!read.ok) throw new Error("expected a page");
    expect(groupBreaks(read.rows)).toEqual([0, 2, 4]);
    const plain = page([row(null), row(null)]);
    if (!plain.ok) throw new Error("expected a page");
    expect(groupBreaks(plain.rows)).toEqual([]);
  });

  test("the foot counts what is shown and what the next press brings", () => {
    expect(footText(25, 57)).toBe("25 of 57 · show 25 more");
    expect(footText(50, 57)).toBe("50 of 57 · show 7 more");
  });

  test("the note speaks only when the source disagrees with the chart", () => {
    registerReport(membersDescriptor("t-note", 57));
    expect(driftNote(reportState("t-note")), "nothing before a page lands").toBeNull();
    receiveReportPage("t-note", page([commitRow(SHA)], { total: 57 }));
    expect(driftNote(reportState("t-note"))).toBeNull();
    dropReport("t-note");

    registerReport(membersDescriptor("t-note-more", 57));
    receiveReportPage("t-note-more", page([commitRow(SHA)], { total: 59 }));
    expect(driftNote(reportState("t-note-more"))).toBe(
      "Drawn from an earlier reading; the source now holds 59.",
    );
    dropReport("t-note-more");

    registerReport(membersDescriptor("t-note-moved", 57));
    receiveReportPage("t-note-moved", page([], { total: 0, moved: true }));
    expect(driftNote(reportState("t-note-moved"))).toBe(
      "Drawn from an earlier reading; the source no longer has this mark.",
    );
    dropReport("t-note-moved");
  });
});
