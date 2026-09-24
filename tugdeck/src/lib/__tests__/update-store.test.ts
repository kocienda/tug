/**
 * update-store — the host's update state, folded, and the one message back.
 *
 * The claims pinned here are the ones the pill and the wizard rest on. A
 * bridge payload lands on the snapshot whole. An identical payload replaces
 * nothing and notifies nobody, which is what makes the host's replay on
 * frontend-ready free rather than a re-render on every mount. A payload this
 * build cannot draw reads as `idle` — nothing to show — rather than as a pill
 * claiming a stage it does not understand. `percent` comes back as `null`
 * rather than `0` when the total is unknown, because a bar at 0% says
 * something false. And an action posts the bare name the host's
 * `UpdateAction` parses, with no envelope around it.
 *
 * The store is a module singleton, so every test applies the state it needs
 * rather than assuming a fresh one.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import {
  updateStore,
  updateFromPayload,
  installUpdateBridge,
  postUpdateAction,
  IDLE_UPDATE,
  type UpdateAction,
  type UpdateStage,
} from "../update-store";

/** A full payload in the shape `UpdateSnapshot.jsonObject` emits. */
function available(overrides: Record<string, unknown> = {}) {
  return {
    stage: "available",
    version: "0.9.0",
    build: "412",
    currentVersion: "0.8.10",
    releaseNotes: "# 0.9.0",
    releaseNotesFailed: false,
    userInitiated: true,
    percent: null,
    message: "",
    cancellable: false,
    revealCount: 0,
    ...overrides,
  };
}

describe("update-store: a host snapshot lands whole", () => {
  it("carries every field the host sent", () => {
    updateStore.apply(updateFromPayload(available()));
    expect(updateStore.getSnapshot()).toEqual({
      stage: "available",
      version: "0.9.0",
      build: "412",
      currentVersion: "0.8.10",
      releaseNotes: "# 0.9.0",
      releaseNotesFailed: false,
      userInitiated: true,
      percent: null,
      message: "",
      cancellable: false,
      revealCount: 0,
    });
  });

  it("records each stage the host can report", () => {
    const stages: readonly UpdateStage[] = [
      "checking",
      "available",
      "downloading",
      "extracting",
      "readyToInstall",
      "installing",
      "upToDate",
      "error",
    ];
    for (const stage of stages) {
      updateStore.apply(updateFromPayload(available({ stage })));
      expect(updateStore.getSnapshot().stage).toBe(stage);
    }
  });

  it("carries an error's message and a download's progress", () => {
    updateStore.apply(
      updateFromPayload(
        available({ stage: "error", message: "the feed did not answer" }),
      ),
    );
    expect(updateStore.getSnapshot().message).toBe("the feed did not answer");

    updateStore.apply(
      updateFromPayload(
        available({ stage: "downloading", percent: 42, cancellable: true }),
      ),
    );
    expect(updateStore.getSnapshot().percent).toBe(42);
    expect(updateStore.getSnapshot().cancellable).toBe(true);
  });
});

describe("update-store: an unchanged snapshot is not a change", () => {
  it("notifies nobody when the same snapshot arrives twice", () => {
    updateStore.apply(updateFromPayload(available()));

    let notifications = 0;
    const unsubscribe = updateStore.subscribe(() => {
      notifications += 1;
    });

    // The host's replay on frontend-ready sends what is already standing.
    updateStore.apply(updateFromPayload(available()));
    expect(notifications).toBe(0);

    updateStore.apply(updateFromPayload(available({ percent: 7 })));
    expect(notifications).toBe(1);

    unsubscribe();
  });

  it("keeps the snapshot reference stable across an identical apply", () => {
    updateStore.apply(updateFromPayload(available()));
    const first = updateStore.getSnapshot();
    updateStore.apply(updateFromPayload(available()));
    expect(updateStore.getSnapshot()).toBe(first);
  });

  it("stops notifying an unsubscribed listener", () => {
    let notifications = 0;
    const unsubscribe = updateStore.subscribe(() => {
      notifications += 1;
    });
    unsubscribe();
    updateStore.apply(updateFromPayload(available({ version: "9.9.9" })));
    expect(notifications).toBe(0);
  });
});

describe("update-store: the idle case", () => {
  it("reads an unrecognized stage as nothing to show", () => {
    // A host build ahead of this deck. "I cannot draw that" is the same
    // answer as "there is nothing to draw" — never a pill in a stage this
    // build has no controls for. The running version still crosses: which Tug
    // is on disk is true whatever stage the host thinks it is in.
    updateStore.apply(updateFromPayload(available({ stage: "sideways" })));
    expect(updateStore.getSnapshot()).toEqual({
      ...IDLE_UPDATE,
      currentVersion: "0.8.10",
    });
  });

  it("reads an empty payload as idle", () => {
    updateStore.apply(updateFromPayload({}));
    expect(updateStore.getSnapshot()).toEqual(IDLE_UPDATE);
  });

  it("drops the version when the host goes idle", () => {
    updateStore.apply(updateFromPayload(available()));
    updateStore.apply(updateFromPayload({ stage: "idle", version: "0.9.0" }));
    expect(updateStore.getSnapshot().version).toBe("");
  });

  it("still carries the reveal count at idle", () => {
    // The one field `idle` does not flatten, and it has to be: the Tug-menu
    // item is enabled in every stage and does nothing but bump this number, so
    // an idle snapshot that dropped the bump would make the item dead in the
    // state a user most often reaches for it from — no flow yet, and a wizard
    // that should open on its Check row.
    updateStore.apply(updateFromPayload({ stage: "idle", revealCount: 4 }));
    const snap = updateStore.getSnapshot();
    expect(snap.stage).toBe("idle");
    expect(snap.revealCount).toBe(4);
    expect(snap.version).toBe("");
  });
});

describe("update-store: a partial payload cannot invent a pill", () => {
  it("falls back to the idle value for every missing field", () => {
    updateStore.apply(updateFromPayload({ stage: "available" }));
    const snap = updateStore.getSnapshot();
    expect(snap.stage).toBe("available");
    expect(snap.version).toBe("");
    expect(snap.build).toBe("");
    expect(snap.releaseNotes).toBeNull();
    expect(snap.userInitiated).toBe(false);
    expect(snap.message).toBe("");
  });

  it("reads a null percent as unknown rather than as zero", () => {
    // A bar sitting at 0% because nobody has said how long the file is says
    // something false. `null` is the only honest answer.
    updateStore.apply(
      updateFromPayload(available({ stage: "downloading", percent: null })),
    );
    expect(updateStore.getSnapshot().percent).toBeNull();
  });

  it("clamps and rounds a percent the host somehow overshot", () => {
    for (const [sent, expected] of [
      [-5, 0],
      [41.6, 42],
      [140, 100],
    ] as const) {
      updateStore.apply(
        updateFromPayload(available({ stage: "downloading", percent: sent })),
      );
      expect(updateStore.getSnapshot().percent).toBe(expected);
    }
  });

  it("reads a non-numeric percent as unknown", () => {
    updateStore.apply(
      updateFromPayload(available({ stage: "downloading", percent: "42" })),
    );
    expect(updateStore.getSnapshot().percent).toBeNull();
  });
});

describe("update-store: progress never reaches React [L06]", () => {
  it("holds the render snapshot's reference across a percent-only change", () => {
    updateStore.apply(
      updateFromPayload(available({ stage: "downloading", percent: 0 })),
    );
    const first = updateStore.getRenderSnapshot();

    for (let percent = 1; percent <= 100; percent += 1) {
      updateStore.apply(
        updateFromPayload(available({ stage: "downloading", percent })),
      );
    }

    // Same reference throughout, which is exactly what makes
    // `useSyncExternalStore` bail out of the re-render. A hundred whole
    // percents cost React nothing.
    expect(updateStore.getRenderSnapshot()).toBe(first);
    // And the progress itself is still there for whoever paints it.
    expect(updateStore.getSnapshot().percent).toBe(100);
  });

  it("carries no percent on the render surface at all", () => {
    updateStore.apply(
      updateFromPayload(available({ stage: "downloading", percent: 42 })),
    );
    expect("percent" in updateStore.getRenderSnapshot()).toBe(false);
  });

  it("moves the render snapshot when anything else changes", () => {
    updateStore.apply(
      updateFromPayload(available({ stage: "downloading", percent: 10 })),
    );
    const before = updateStore.getRenderSnapshot();
    updateStore.apply(
      updateFromPayload(available({ stage: "extracting", percent: 10 })),
    );
    expect(updateStore.getRenderSnapshot()).not.toBe(before);
    expect(updateStore.getRenderSnapshot().stage).toBe("extracting");
  });

  it("still notifies on a percent-only change, for the painter", () => {
    updateStore.apply(
      updateFromPayload(available({ stage: "downloading", percent: 5 })),
    );
    let notifications = 0;
    const unsubscribe = updateStore.subscribe(() => {
      notifications += 1;
    });
    updateStore.apply(
      updateFromPayload(available({ stage: "downloading", percent: 6 })),
    );
    expect(notifications).toBe(1);
    unsubscribe();
  });
});

describe("update-store: reveal is a count, not an event", () => {
  it("carries the host's reveal count", () => {
    updateStore.apply(updateFromPayload(available({ revealCount: 3 })));
    expect(updateStore.getSnapshot().revealCount).toBe(3);
    expect(updateStore.getRenderSnapshot().revealCount).toBe(3);
  });

  it("reads a payload with no count at all as zero", () => {
    const { revealCount: _omitted, ...withoutCount } = available();
    updateStore.apply(updateFromPayload(withoutCount));
    expect(updateStore.getSnapshot().revealCount).toBe(0);
  });

  it("moves the render snapshot when the count is the only thing that moved", () => {
    updateStore.apply(updateFromPayload(available({ revealCount: 1 })));
    const before = updateStore.getRenderSnapshot();
    updateStore.apply(updateFromPayload(available({ revealCount: 2 })));
    // A reveal moves nothing else in the snapshot, so a render surface that
    // elided the count would swallow it and the surface would never open.
    expect(updateStore.getRenderSnapshot()).not.toBe(before);
    expect(updateStore.getRenderSnapshot().revealCount).toBe(2);
  });

  it("is idempotent under the replay a reload gets", () => {
    updateStore.apply(updateFromPayload(available({ revealCount: 7 })));
    const first = updateStore.getRenderSnapshot();
    let notifications = 0;
    const unsubscribe = updateStore.subscribe(() => {
      notifications += 1;
    });
    updateStore.apply(updateFromPayload(available({ revealCount: 7 })));
    expect(notifications).toBe(0);
    expect(updateStore.getRenderSnapshot()).toBe(first);
    unsubscribe();
  });
});

describe("update-store: the bridge and the action", () => {
  const w = globalThis as unknown as {
    __tugBridge?: Record<string, unknown>;
    webkit?: unknown;
  };
  let savedBridge: unknown;
  let savedWebkit: unknown;

  beforeEach(() => {
    savedBridge = w.__tugBridge;
    savedWebkit = w.webkit;
    delete w.__tugBridge;
    delete w.webkit;
  });

  afterEach(() => {
    if (savedBridge === undefined) delete w.__tugBridge;
    else w.__tugBridge = savedBridge as Record<string, unknown>;
    if (savedWebkit === undefined) delete w.webkit;
    else w.webkit = savedWebkit;
  });

  it("installs the receiver and feeds the store from it", () => {
    installUpdateBridge();
    (w.__tugBridge as { onUpdateState: (p: unknown) => void }).onUpdateState(
      available({ version: "1.2.3" }),
    );
    expect(updateStore.getSnapshot().version).toBe("1.2.3");
  });

  it("merges into a shared bridge rather than replacing it", () => {
    const other = () => {};
    w.__tugBridge = { onNetworkPath: other };
    installUpdateBridge();
    expect(w.__tugBridge.onNetworkPath).toBe(other);
    expect(typeof w.__tugBridge.onUpdateState).toBe("function");
  });

  it("does not replace a receiver that is already installed", () => {
    const existing = () => {};
    w.__tugBridge = { onUpdateState: existing };
    installUpdateBridge();
    expect(w.__tugBridge.onUpdateState).toBe(existing);
  });

  it("posts the bare action name the host parses", () => {
    const posted: unknown[] = [];
    w.webkit = {
      messageHandlers: {
        updateAction: { postMessage: (v: unknown) => posted.push(v) },
      },
    };
    const actions: readonly UpdateAction[] = [
      "install",
      "later",
      "skip",
      "cancel",
      "retry",
      "dismiss",
      "check",
    ];
    for (const action of actions) postUpdateAction(action);
    expect(posted).toEqual([...actions]);
  });

  it("is a no-op outside Tug.app", () => {
    // A browser tab has no host to ask. Nothing throws, and nothing happens.
    expect(() => postUpdateAction("check")).not.toThrow();
  });
});
