/**
 * update-tug-rows — the wizard's four rows, crossed against a live deck.
 *
 * `at0612` pins what the wizard draws on a deck with nothing running, which is
 * the common case and the only one an app-test can reach: the harness deck has
 * no session mid-turn, so the with-turns branch is unreachable there ([B08]).
 * It is reachable here, because the derivation takes the deck's answer as an
 * argument.
 *
 * The claims: the Stop-work row is pending until the download has landed and
 * derived from the deck thereafter; the install button is absent while any turn
 * exists and returns when the last one ends, with nothing latched either way;
 * the host's failure sweeps never speak for the deck's row; and none of the
 * rows the previous three-row wizard drew have moved.
 */

import { describe, it, expect } from "bun:test";

import {
  deriveUpdateRows,
  STOP_WORK,
  type RowKey,
  type RowModel,
} from "../update-tug-rows";
import { NO_LIVE_TURNS, type LiveTurnsSnapshot } from "@/lib/live-turns-store";
import type { UpdateRenderSnapshot, UpdateStage } from "@/lib/update-store";
import type { TugStepRowStatus } from "../tug-step-row";

/** Every stage the host can report, so a crossing can be exhaustive. */
const STAGES: UpdateStage[] = [
  "idle",
  "checking",
  "available",
  "downloading",
  "extracting",
  "readyToInstall",
  "installing",
  "upToDate",
  "error",
];

/** The two stages at which the Stop-work row reads the deck at all ([B03]). */
const AFTER_DOWNLOAD: UpdateStage[] = ["readyToInstall", "installing"];

function snapshot(
  stage: UpdateStage,
  over: Partial<UpdateRenderSnapshot> = {},
): UpdateRenderSnapshot {
  return {
    stage,
    version: "0.9.0",
    build: "900",
    releaseNotes: null,
    releaseNotesFailed: false,
    userInitiated: false,
    message: "",
    cancellable: false,
    revealCount: 0,
    ...over,
  };
}

function turns(...titles: string[]): LiveTurnsSnapshot {
  if (titles.length === 0) return NO_LIVE_TURNS;
  return { count: titles.length, titles };
}

/** The rows a call produced, keyed, so a test can name the one it means. */
function rowsBy(
  stage: UpdateStage,
  liveTurns: LiveTurnsSnapshot = NO_LIVE_TURNS,
  over: {
    waitingRow?: RowKey;
    stalled?: boolean;
    interrupting?: boolean;
    snapshot?: Partial<UpdateRenderSnapshot>;
  } = {},
): Record<RowKey, RowModel> {
  const model = deriveUpdateRows(
    snapshot(stage, over.snapshot),
    liveTurns,
    over.waitingRow ?? "check",
    over.stalled ?? false,
    over.interrupting ?? false,
  );
  const byKey = {} as Record<RowKey, RowModel>;
  for (const row of model) byKey[row.key] = row;
  return byKey;
}

describe("update-tug-rows: four rows, in one order, always", () => {
  it("returns the same four keys in the same order at every stage", () => {
    for (const stage of STAGES) {
      for (const live of [turns(), turns("alpha")]) {
        const keys = deriveUpdateRows(
          snapshot(stage, { message: "the feed did not answer" }),
          live,
          "check",
          false,
          false,
        ).map((row) => row.key);
        expect(keys).toEqual(["check", "download", "stop-work", "relaunch"]);
      }
    }
  });

  it("labels the rows the same way at every stage, carrying no version", () => {
    for (const stage of STAGES) {
      const labels = deriveUpdateRows(
        snapshot(stage),
        turns("alpha"),
        "check",
        false,
        false,
      ).map((row) => row.label);
      expect(labels).toEqual([
        "Check for an update",
        "Download the update",
        "Stop work in flight",
        "Install and relaunch",
      ]);
    }
  });
});

describe("update-tug-rows: the Stop-work row is the deck's ([B03])", () => {
  it("is pending at every stage before the download has landed, live turns or not", () => {
    for (const stage of STAGES) {
      if (AFTER_DOWNLOAD.includes(stage)) continue;
      for (const live of [turns(), turns("alpha", "beta")]) {
        const row = rowsBy(stage, live)["stop-work"];
        expect(row.status).toBe("pending");
        expect(row.cta).toBeUndefined();
        expect(row.detail).toBeUndefined();
      }
    }
  });

  it("is done with nothing running once the download has landed", () => {
    for (const stage of AFTER_DOWNLOAD) {
      const row = rowsBy(stage)["stop-work"];
      expect(row.status).toBe("done");
      expect(row.detail).toBe("Nothing is running.");
      expect(row.cta).toBeUndefined();
    }
  });

  it("is active with the sessions named and a Stop Work button when turns are live", () => {
    for (const stage of AFTER_DOWNLOAD) {
      const row = rowsBy(stage, turns("tugtool — odd-kiln"))["stop-work"];
      expect(row.status).toBe("active");
      expect(row.detail).toBe(
        "tugtool — odd-kiln is mid-turn and will be interrupted.",
      );
      expect(row.cta).toEqual({ label: "Stop Work", action: STOP_WORK });
    }
  });

  it("is busy while the bounded interrupt runs, with the count still standing", () => {
    // The press has gone out and nothing has acknowledged yet, so the count is
    // exactly where it was — which is why `interrupting` is an argument and not
    // something the row could read off the deck.
    const row = rowsBy("readyToInstall", turns("alpha"), { interrupting: true })[
      "stop-work"
    ];
    expect(row.status).toBe("busy");
    expect(row.detail).toBe("Stopping work in flight…");
    expect(row.cta).toEqual({ label: "Stop Work", action: STOP_WORK });
  });

  it("settles with no press when the user stops the turns in their cards", () => {
    // Nothing latches: the same arguments minus the turns give the done row,
    // with no memory of a Stop Work press that never happened.
    expect(rowsBy("readyToInstall", turns("alpha"))["stop-work"].status).toBe(
      "active",
    );
    expect(rowsBy("readyToInstall", turns())["stop-work"].status).toBe("done");
  });

  it("goes back to active when a turn starts after the row had settled", () => {
    expect(rowsBy("readyToInstall", turns())["stop-work"].status).toBe("done");
    expect(rowsBy("readyToInstall", turns("late"))["stop-work"].status).toBe(
      "active",
    );
  });
});

describe("update-tug-rows: the install is never offered while a turn exists ([B04])", () => {
  it("offers Install and Relaunch with nothing running", () => {
    const row = rowsBy("readyToInstall", turns(), { waitingRow: "relaunch" })[
      "relaunch"
    ];
    expect(row.status).toBe("active");
    expect(row.detail).toBe("Tug quits and reopens on the new version.");
    expect(row.cta).toEqual({ label: "Install and Relaunch", action: "install" });
  });

  it("withholds it — pending, not disabled — while any turn is live", () => {
    for (const live of [turns("alpha"), turns("alpha", "beta", "gamma", "delta")]) {
      const row = rowsBy("readyToInstall", live, { waitingRow: "relaunch" })[
        "relaunch"
      ];
      expect(row.status).toBe("pending");
      expect(row.cta).toBeUndefined();
      expect(row.detail).toBeUndefined();
    }
  });

  it("withholds it while the interrupt is still running", () => {
    const row = rowsBy("readyToInstall", turns("alpha"), {
      waitingRow: "relaunch",
      interrupting: true,
    })["relaunch"];
    expect(row.status).toBe("pending");
    expect(row.cta).toBeUndefined();
  });

  it("gives it back when the last turn ends", () => {
    expect(
      rowsBy("readyToInstall", turns("alpha"))["relaunch"].cta,
    ).toBeUndefined();
    expect(rowsBy("readyToInstall", turns())["relaunch"].cta).toEqual({
      label: "Install and Relaunch",
      action: "install",
    });
  });

  it("offers no install press at any other stage, with or without turns", () => {
    for (const stage of STAGES) {
      if (stage === "readyToInstall") continue;
      for (const live of [turns(), turns("alpha")]) {
        const relaunch = rowsBy(stage, live, { waitingRow: "relaunch" })[
          "relaunch"
        ];
        expect(relaunch.cta?.label).not.toBe("Install and Relaunch");
      }
    }
  });
});

describe("update-tug-rows: the host's rows are unmoved", () => {
  it("walks Check and Download through the stages as before", () => {
    const expected: Array<
      [UpdateStage, TugStepRowStatus, TugStepRowStatus]
    > = [
      ["idle", "active", "pending"],
      ["checking", "busy", "pending"],
      ["available", "done", "active"],
      ["downloading", "done", "busy"],
      ["extracting", "done", "busy"],
      ["readyToInstall", "done", "done"],
      ["installing", "done", "done"],
      ["upToDate", "done", "pending"],
    ];
    for (const [stage, check, download] of expected) {
      const rows = rowsBy(stage);
      expect(rows.check.status).toBe(check);
      expect(rows.download.status).toBe(download);
    }
  });

  it("lands a host failure on the row that was waiting, and not on the deck's", () => {
    const rows = rowsBy("error", turns("alpha"), {
      waitingRow: "download",
      snapshot: { message: "the feed did not answer" },
    });
    expect(rows.check.status).toBe("done");
    expect(rows.download.status).toBe("error");
    expect(rows.download.detail).toBe("the feed did not answer");
    expect(rows.download.cta).toEqual({ label: "Retry", action: "retry" });
    // The sweep marks every row before the failure done. The deck's row is not
    // the host's to mark, and at `error` there is nothing to stop *for*.
    expect(rows["stop-work"].status).toBe("pending");
    expect(rows.relaunch.status).toBe("pending");
  });

  it("turns a stalled wait into a failed row with Retry ([L33])", () => {
    const rows = rowsBy("downloading", turns("alpha"), {
      waitingRow: "download",
      stalled: true,
    });
    expect(rows.download.status).toBe("error");
    expect(rows.download.detail).toBe("Tug has heard nothing back for a while.");
    expect(rows.download.cta).toEqual({ label: "Retry", action: "retry" });
    expect(rows["stop-work"].status).toBe("pending");
  });

  it("keeps Download's Cancel at the two cancellable stages", () => {
    for (const stage of ["checking", "downloading"] as UpdateStage[]) {
      const rows = rowsBy(stage, turns("alpha"), {
        snapshot: { cancellable: true },
      });
      const row = stage === "checking" ? rows.check : rows.download;
      expect(row.cta).toEqual({ label: "Cancel", action: "cancel" });
    }
  });

  it("keeps Download as the press at `available`, which ends no turns", () => {
    const row = rowsBy("available", turns("alpha")).download;
    expect(row.status).toBe("active");
    expect(row.detail).toBe("Downloading won't interrupt your work.");
    expect(row.cta).toEqual({ label: "Download", action: "install" });
  });
});
