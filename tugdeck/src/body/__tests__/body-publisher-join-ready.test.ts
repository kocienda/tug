/**
 * A body reports its card's phase with the arc's join offer folded in.
 *
 * Every page but a card's own reads its phase from what its body reported
 * (`reportedPhaseOf`): the shell's masthead dot, the Workspaces and Layout
 * rows. A finished arc's standing join offer is what turns the session's idle
 * into Ready ([B01] of the join register), and it is a fact of the card's arc
 * and the changes feed, not of the session store — so a body that reported
 * `sessionPhaseFromSnapshot(snapshot)` alone told every other page "idle"
 * while its own masthead said Ready, and a folded card's dot never announced
 * the offer (`at0559`).
 *
 * @covers tugdeck/src/body/body-publisher.ts
 * @covers tugdeck/src/lib/code-session-store/use-session-phase.ts
 */
import { afterEach, describe, expect, test } from "bun:test";

import { readBodyCardFacts } from "../body-publisher";
import { cardServicesStore } from "@/lib/card-services-store";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import type { ArcChangesetEntry } from "@/lib/changeset-types";

const ARC = "tugarc/ready#a1";
const offer = { request_id: "ready:base1:head1", base_sha: "base1", arc_head: "head1" };

const idle = {
  phase: "idle",
  transportState: "online",
  interruptInFlight: false,
  stopStalled: false,
  streamStalled: false,
  apiRetry: null,
  jobs: [],
  pendingAsk: null,
  canInterrupt: false,
  compactionSeed: null,
};

function arcRow(over: Partial<ArcChangesetEntry> = {}): ArcChangesetEntry {
  return { kind: "arc", owner_id: ARC, display_name: "ready", files: [], ...over } as ArcChangesetEntry;
}

const realGetServices = cardServicesStore.getServices;

/** Stand services in for card A: an idle session, and the changes feed's arc rows. */
function standServices(arcs: ArcChangesetEntry[]): void {
  const services = {
    codeSessionStore: { getSnapshot: () => idle },
    changesController: { getSnapshot: () => ({ arcs }) },
  };
  cardServicesStore.getServices = ((cardId: string) =>
    cardId === "A" ? services : null) as unknown as typeof cardServicesStore.getServices;
}

afterEach(() => {
  cardServicesStore.getServices = realGetServices;
  cardSessionBindingStore.clearAll();
});

describe("a body's reported phase", () => {
  test("reads Ready while the card's arc stands at a join offer", () => {
    cardSessionBindingStore.setBinding("A", {
      tugSessionId: "s1",
      lineId: "s1",
      workspaceKey: "/p",
      projectDir: "/p",
      sessionMode: "resume",
      arc: { id: ARC, name: "ready" },
    });
    standServices([arcRow({ join: { phase: "resolved", offer } })]);
    expect(readBodyCardFacts("A").activity).toBe("ready");
  });

  test("reads the session's own phase when no offer stands", () => {
    cardSessionBindingStore.setBinding("A", {
      tugSessionId: "s1",
      lineId: "s1",
      workspaceKey: "/p",
      projectDir: "/p",
      sessionMode: "resume",
      arc: { id: ARC, name: "ready" },
    });
    standServices([arcRow({ join: { phase: "resolved" } })]);
    expect(readBodyCardFacts("A").activity).toBe("idle");
  });
});
