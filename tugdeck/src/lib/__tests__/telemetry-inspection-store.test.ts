/**
 * The telemetry inspector's one source, in the page that does not hold the
 * card: a relayed inspection replaces the last, `null` empties it, and the
 * store answers only for the card the relay names.
 *
 * The in-document path — the card's own services — is real-app coverage: the
 * devtools kind check reads a followed Session body's inspection through the
 * relay, and the in-document inspector through its services.
 */

import { afterEach, describe, expect, test } from "bun:test";

import type { TugConnection } from "@/connection";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import { CodeSessionStore } from "@/lib/code-session-store";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import {
  INSPECTION_STATE_KEYS,
  isTelemetryInspection,
  pickInspectionState,
  relayableInspection,
  telemetryInspectionStore,
  type TelemetryInspection,
} from "@/lib/telemetry-inspection-store";

function makeStore(tugSessionId: string, displayLabel: string): CodeSessionStore {
  return new CodeSessionStore({
    conn: new TestFrameChannel() as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId,
    displayLabel,
    sessionMode: "new",
  });
}

function inspection(cardId: string, phase: TelemetryInspection["fields"]["phase"] = "idle"): TelemetryInspection {
  return {
    cardId,
    fields: { phase, transcript: [], tugSessionId: "s-1", displayLabel: "One", transportState: "online" },
    state: pickInspectionState(makeStore("s-1", "One")._getInternalStateForDevPanel()),
  };
}

afterEach(() => {
  telemetryInspectionStore._resetForTest();
});

describe("telemetryInspectionStore", () => {
  test("a relayed inspection answers for the card it names, and for no other", () => {
    telemetryInspectionStore.relay(inspection("c1"));
    expect(telemetryInspectionStore.read("c1")?.cardId).toBe("c1");
    expect(telemetryInspectionStore.read("c2")).toBeNull();
  });

  test("a relayed inspection replaces the last", () => {
    telemetryInspectionStore.relay(inspection("c1", "idle"));
    telemetryInspectionStore.relay(inspection("c1", "submitting"));
    expect(telemetryInspectionStore.read("c1")?.fields.phase).toBe("submitting");
    telemetryInspectionStore.relay(inspection("c2"));
    expect(telemetryInspectionStore.read("c1")).toBeNull();
    expect(telemetryInspectionStore.read("c2")?.cardId).toBe("c2");
  });

  test("`null` empties it", () => {
    telemetryInspectionStore.relay(inspection("c1"));
    telemetryInspectionStore.relay(null);
    expect(telemetryInspectionStore.read("c1")).toBeNull();
    expect(telemetryInspectionStore.relayed()).toBeNull();
  });

  test("a subscriber hears each relay", () => {
    let heard = 0;
    const release = telemetryInspectionStore.subscribe("c1", () => {
      heard += 1;
    });
    telemetryInspectionStore.relay(inspection("c1"));
    telemetryInspectionStore.relay(null);
    release();
    telemetryInspectionStore.relay(inspection("c1"));
    expect(heard).toBe(2);
  });

  test("the relayable inspection is plain data: the state slice, and turns without their messages", () => {
    const store = makeStore("s-9", "Nine");
    const relayed = relayableInspection("c9", store);
    expect(relayed.cardId).toBe("c9");
    expect(Object.keys(relayed.state).sort()).toEqual([...INSPECTION_STATE_KEYS].sort());
    expect(JSON.parse(JSON.stringify(relayed))).toEqual(relayed);
    expect(isTelemetryInspection(relayed)).toBe(true);
    expect(isTelemetryInspection({ cardId: "c9" })).toBe(false);
    expect(isTelemetryInspection(null)).toBe(false);
  });
});
