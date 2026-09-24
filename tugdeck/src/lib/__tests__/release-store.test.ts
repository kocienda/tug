/**
 * release-store — the three release round trips and the watcher's frames.
 *
 * The sequence a real release walks is `release_check_ok` → `release_dispatch_ok`
 * → a run of `release_run_state` frames, so that is what these drive, in order,
 * through the real store's own `_onControl` over a fake `TugConnection` — the
 * frame handler the store registers is captured and invoked with encoded
 * CONTROL payloads rather than stood in for.
 *
 * Two shapes are worth more than the happy path. A frame for a `project_dir`
 * this store never sent a verb for is **kept**, because the server watches a
 * run whoever asked for it and a second window should find it already there.
 * And the watcher's own two statuses — `unreachable` and `abandoned` — arrive
 * with no url and no steps, so the store carries the last real frame's forward:
 * taking them literally would blank the step rows every time `gh` hiccups.
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { ReleaseStore } from "../release-store";

const PROJECT = "/proj";

interface Sent {
  action: string;
  body: Record<string, unknown>;
}

function harness(): {
  store: ReleaseStore;
  sent: Sent[];
  reply: (body: Record<string, unknown>) => void;
} {
  let handler: ((payload: Uint8Array) => void) | null = null;
  const sent: Sent[] = [];
  const conn = {
    onFrame: (_feed: number, cb: (payload: Uint8Array) => void) => {
      handler = cb;
      return () => {};
    },
    sendControlFrame: (action: string, body: Record<string, unknown>) => {
      sent.push({ action, body });
    },
  } as never;
  const store = new ReleaseStore(conn);
  const reply = (body: Record<string, unknown>): void => {
    if (handler === null) throw new Error("no CONTROL handler registered");
    handler(new TextEncoder().encode(JSON.stringify(body)));
  };
  return { store, sent, reply };
}

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});

describe("release round trips", () => {
  test("check → dispatch → two run frames reduce to the expected snapshot", () => {
    h.store.check(PROJECT);
    expect(h.sent).toEqual([
      { action: "release_check", body: { project_dir: PROJECT } },
    ]);
    expect(h.store.getSnapshot(PROJECT).check.phase).toBe("running");

    h.reply({
      action: "release_check_ok",
      project_dir: PROJECT,
      rows: [
        { mark: "ok", text: "version 0.0.1 reads the same in all four files" },
        { mark: "note", text: "the tag is not on origin yet" },
      ],
      passed: true,
      exit_code: 0,
      raw: "  ok  version…\nnote  the tag…\n\nBlessed:\n",
    });
    const checked = h.store.getSnapshot(PROJECT);
    expect(checked.check.phase).toBe("done");
    expect(checked.check.passed).toBe(true);
    expect(checked.check.exitCode).toBe(0);
    expect(checked.check.rows.map((row) => row.mark)).toEqual(["ok", "note"]);
    expect(checked.check.raw).toContain("Blessed:");

    h.store.dispatch(PROJECT, false);
    expect(h.sent[1]).toEqual({
      action: "release_dispatch",
      body: { project_dir: PROJECT, force: false },
    });
    expect(h.store.getSnapshot(PROJECT).dispatch.phase).toBe("pending");

    h.reply({
      action: "release_dispatch_ok",
      project_dir: PROJECT,
      run_id: "42",
      url: "https://github.test/run/42",
    });
    expect(h.store.getSnapshot(PROJECT).dispatch).toEqual({
      phase: "done",
      runId: "42",
      url: "https://github.test/run/42",
      error: null,
      rows: [],
    });

    h.reply({
      action: "release_run_state",
      project_dir: PROJECT,
      run_id: "42",
      url: "https://github.test/run/42",
      status: "in_progress",
      conclusion: "",
      steps: [
        {
          name: "Build signed DMG and update archive",
          status: "in_progress",
          conclusion: "",
          started_at_ms: 1_000,
          completed_at_ms: null,
        },
      ],
      watched_since_ms: 500,
    });
    expect(h.store.getSnapshot(PROJECT).run?.status).toBe("in_progress");
    expect(h.store.getSnapshot(PROJECT).run?.steps[0]?.startedAtMs).toBe(1_000);
    expect(h.store.getSnapshot(PROJECT).run?.steps[0]?.completedAtMs).toBeNull();

    h.reply({
      action: "release_run_state",
      project_dir: PROJECT,
      run_id: "42",
      url: "https://github.test/run/42",
      status: "completed",
      conclusion: "success",
      steps: [
        {
          name: "Build signed DMG and update archive",
          status: "completed",
          conclusion: "success",
          started_at_ms: 1_000,
          completed_at_ms: 91_000,
        },
      ],
      watched_since_ms: 500,
    });
    const done = h.store.getSnapshot(PROJECT).run;
    expect(done?.status).toBe("completed");
    expect(done?.conclusion).toBe("success");
    expect(done?.steps[0]?.completedAtMs).toBe(91_000);
    expect(done?.watchedSinceMs).toBe(500);
    expect(done?.failedLog).toBeNull();
  });

  test("a refused dispatch carries the re-check's rows", () => {
    h.store.dispatch(PROJECT, false);
    h.reply({
      action: "release_dispatch_err",
      project_dir: PROJECT,
      detail: "the release check did not pass",
      rows: [{ mark: "fail", text: "release-notes/0.0.1.md is still the seed" }],
    });
    const state = h.store.getSnapshot(PROJECT).dispatch;
    expect(state.phase).toBe("error");
    expect(state.error).toBe("the release check did not pass");
    expect(state.rows).toEqual([
      { mark: "fail", text: "release-notes/0.0.1.md is still the seed" },
    ]);
  });

  test("force rides the dispatch payload", () => {
    h.store.dispatch(PROJECT, true);
    expect(h.sent).toEqual([
      {
        action: "release_dispatch",
        body: { project_dir: PROJECT, force: true },
      },
    ]);
  });

  test("a check failure is an error phase, not a failed check", () => {
    h.store.check(PROJECT);
    h.reply({
      action: "release_check_err",
      project_dir: PROJECT,
      detail: "this project declares no [tugtool.release] table",
    });
    const state = h.store.getSnapshot(PROJECT).check;
    expect(state.phase).toBe("error");
    expect(state.error).toBe(
      "this project declares no [tugtool.release] table",
    );
    expect(state.rows).toEqual([]);
    expect(state.passed).toBe(false);
  });

  test("a run frame for an unasked project is kept, not dropped", () => {
    h.reply({
      action: "release_run_state",
      project_dir: "/elsewhere",
      run_id: "7",
      url: "https://github.test/run/7",
      status: "queued",
      conclusion: "",
      steps: [],
      watched_since_ms: 9,
    });
    expect(h.store.getSnapshot("/elsewhere").run?.runId).toBe("7");
    // And it stays scoped to the project it named.
    expect(h.store.getSnapshot(PROJECT).run).toBeNull();
  });

  test("unreachable keeps the last real frame's url and steps", () => {
    h.reply({
      action: "release_run_state",
      project_dir: PROJECT,
      run_id: "42",
      url: "https://github.test/run/42",
      status: "in_progress",
      conclusion: "",
      steps: [
        {
          name: "Generate the appcast",
          status: "in_progress",
          conclusion: "",
          started_at_ms: 1_000,
          completed_at_ms: null,
        },
      ],
      watched_since_ms: 500,
    });
    h.reply({
      action: "release_run_state",
      project_dir: PROJECT,
      run_id: "42",
      url: "",
      status: "unreachable",
      conclusion: "",
      steps: [],
      watched_since_ms: 500,
    });
    const state = h.store.getSnapshot(PROJECT).run;
    expect(state?.status).toBe("unreachable");
    expect(state?.url).toBe("https://github.test/run/42");
    expect(state?.steps.map((step) => step.name)).toEqual([
      "Generate the appcast",
    ]);
  });

  test("a malformed row or step is dropped rather than rendered blank", () => {
    h.reply({
      action: "release_check_ok",
      project_dir: PROJECT,
      rows: [
        { mark: "ok", text: "kept" },
        { mark: "shrug", text: "no such mark" },
        "not a row",
      ],
      passed: false,
      exit_code: 1,
      raw: "",
    });
    expect(h.store.getSnapshot(PROJECT).check.rows).toEqual([
      { mark: "ok", text: "kept" },
    ]);
    // `passed` is the exit code's verdict, never the rows' — one `ok` row and
    // a non-zero exit is not blessed.
    expect(h.store.getSnapshot(PROJECT).check.passed).toBe(false);
  });

  test("watch names the run and never composes a poll of its own", () => {
    h.store.watch(PROJECT, "42");
    expect(h.sent).toEqual([
      {
        action: "release_watch",
        body: { project_dir: PROJECT, run_id: "42" },
      },
    ]);
  });
});
