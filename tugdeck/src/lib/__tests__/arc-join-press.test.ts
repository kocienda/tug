/**
 * `arc-join-press` — a row's Join is the composer's `changeset_join`, sent for
 * the arc's bound session with the arc's own draft ([B05]).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { JOIN_ALREADY_IN_FLIGHT, pressArcJoin, sessionEntryKey } from "@/lib/arc-join-press";
import { arcPressStore } from "@/lib/arc-press-store";
import { CHANGES_SERVICE_DISCONNECTED } from "@/lib/landing-mode";
import {
  _resetChangesetVerbStoreForTest,
  attachChangesetVerbStore,
  getChangesetVerbStore,
} from "@/lib/changeset-verb-store";

interface Sent {
  action: string;
  body: Record<string, unknown>;
}

const sent: Sent[] = [];

function fakeConnection(): never {
  return {
    onFrame: () => () => {},
    sendControlFrame: (action: string, body: Record<string, unknown>) => {
      sent.push({ action, body });
    },
  } as never;
}

const PRESS = {
  workspaceKey: "ws-key",
  arc: "demo",
  boundSession: "sess-bound",
  message: "Land the demo\n\nWhat it does.",
};

beforeEach(() => {
  sent.length = 0;
  _resetChangesetVerbStoreForTest();
  attachChangesetVerbStore(fakeConnection());
});

afterEach(() => {
  _resetChangesetVerbStoreForTest();
});

describe("pressArcJoin", () => {
  it("sends the composer's changeset_join for the bound session with the draft", () => {
    expect(pressArcJoin(PRESS)).toBe(true);
    expect(sent).toEqual([
      {
        action: "changeset_join",
        body: {
          project_dir: "ws-key",
          arc: "demo",
          preview: false,
          message: PRESS.message,
          session_id: "sess-bound",
        },
      },
    ]);
  });

  it("records the round trip under the bound card's entry key", () => {
    pressArcJoin(PRESS);
    expect(
      getChangesetVerbStore()?.joinState(sessionEntryKey("sess-bound")).phase,
    ).toBe("pending");
  });

  it("sends no candidate: a ready arc's join is a squash and a land", () => {
    pressArcJoin(PRESS);
    expect(sent[0]?.body.candidate).toBeUndefined();
  });

  it("sends nothing while a join is already in flight on that card", () => {
    pressArcJoin(PRESS);
    expect(pressArcJoin(PRESS)).toBe(false);
    expect(sent.length).toBe(1);
  });

  it("sends nothing with no verb store, and says why on the bound card", () => {
    _resetChangesetVerbStoreForTest();
    expect(pressArcJoin(PRESS)).toBe(false);
    expect(sent.length).toBe(0);
    const refusal = arcPressStore.refusalFor("sess-bound");
    expect(refusal?.verb).toBe("join");
    expect(refusal?.arc).toBe("demo");
    expect(refusal?.reason).toBe(CHANGES_SERVICE_DISCONNECTED);
    arcPressStore.clearRefusal("sess-bound");
  });

  it("a second press speaks on the voice it was given", () => {
    pressArcJoin(PRESS);
    expect(pressArcJoin({ ...PRESS, voice: "sess-followed" })).toBe(false);
    expect(arcPressStore.refusalFor("sess-followed")?.reason).toBe(JOIN_ALREADY_IN_FLIGHT);
    expect(arcPressStore.refusalFor("sess-bound")).toBeNull();
    arcPressStore.clearRefusal("sess-followed");
  });
});
