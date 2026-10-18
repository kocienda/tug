/**
 * at0741-every-kind-a-body.test.ts — every registered card kind is a body.
 *
 * With maker tooling loaded (the harness runs the prebuilt bundle with
 * `__tugTestMode` set, which is one of the three doors), the shell's
 * registry is read through the eval door. No registration says whether its
 * kind is a body — every kind is — so the guarantee is read off the running
 * app: one card of every kind is seeded, four kinds to a deck
 * — the kinds the Session card's hand-off rides a spawn for are spawned onto
 * a stub — and each card's body stands `ready` while the shell's document
 * mounts no card host at all: every card id is in the host's body list, and
 * `[data-card-host]` counts zero in the shell.
 *
 * Four to a deck rather than all at once: the cap on live bodies holds a
 * deck to a count, and a hundred bodies in one deck is a reading of the
 * machine's memory, not of the registry. Each deck proves its four kinds the
 * same way, and the union is every kind.
 *
 * @covers tugdeck/src/card-kinds.ts
 * @covers tugdeck/src/lib/body-handoff.ts
 * @covers tugdeck/src/components/tugways/cards/gallery-registrations.tsx
 * @covers tugdeck/src/spikes/spike-registry.tsx
 * @covers tugdeck/src/fixtures/fixture-registrations.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { BODY_READY_MS, pollFor, spawnStub } from "./body-grounding/_bodies";
import { CARD_KINDS, kindPane, kindSidebars } from "./body-grounding/_kinds";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "./streaming-stub-fixture";

const TEST_NAME = "at0741-every-kind-a-body";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 900_000;
const KINDS_PER_DECK = 4;

interface RegisteredKind {
  componentId: string;
  bodyHandOff: string | null;
  hidden: boolean;
  family: string | null;
}

const CARD_HOSTS = `document.querySelectorAll("[data-card-host]").length`;

/** The id a kind's one card is seeded under. */
const cardIdOf = (componentId: string): string => `at0741-${componentId}`;

/** A pane holding one card of `kind`: a rail pane for a rail kind, a slotted content pane otherwise. */
function paneOf(kind: RegisteredKind, cardId: string, slot: number): Record<string, unknown> {
  const known = CARD_KINDS.find((k) => k.componentId === kind.componentId);
  if (known !== undefined) return kindPane(kind.componentId, cardId, slot);
  return {
    id: `${cardId}-pane`,
    position: { x: 40, y: 40 },
    size: { width: 640, height: 480 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: [kind.family ?? "standard"],
    slot,
  };
}

/** A deck holding one card of each of `kinds`, content kinds in the flow band's slots and rail kinds on the right edge. */
function deckOf(kinds: readonly RegisteredKind[]): Record<string, unknown> {
  const rails = new Set(CARD_KINDS.filter((k) => k.rail).map((k) => k.componentId));
  let slot = 0;
  const panes = kinds.map((kind) => paneOf(kind, cardIdOf(kind.componentId), rails.has(kind.componentId) ? 0 : slot++));
  return {
    cards: kinds.map((kind) => ({ id: cardIdOf(kind.componentId), componentId: kind.componentId, title: kind.componentId, closable: true })),
    panes,
    activePaneId: `${cardIdOf(kinds[0].componentId)}-pane`,
    imposition: { kind: "four-up", layout: "flow", sidebars: kindSidebars(kinds.map((k) => k.componentId).filter((id) => rails.has(id))) },
    hasFocus: true,
  };
}

/** Seed one deck of `kinds`, spawn the spawn-handed ones, and wait for every body to stand ready. */
async function proveDeck(app: App, kinds: readonly RegisteredKind[], stubDir: string): Promise<void> {
  const ids = kinds.map((k) => cardIdOf(k.componentId));
  await app.seedDeckState({ state: deckOf(kinds), focusCardId: ids[0] });
  for (const kind of kinds) {
    if (kind.bodyHandOff === "spawn") await spawnStub(app, cardIdOf(kind.componentId), stubDir, 2);
  }
  const bodies = await pollFor(
    () => app.bodies(),
    (list) => ids.every((id) => list.some((b) => b.cardId === id && b.state === "ready")),
    BODY_READY_MS,
  );
  for (const kind of kinds) {
    const body = bodies.find((b) => b.cardId === cardIdOf(kind.componentId));
    expect(body?.state, `${kind.componentId}: its body stands ready`).toBe("ready");
    expect(body?.componentId, `${kind.componentId}: the body holds the card's kind`).toBe(kind.componentId);
  }
  // card-dom: shell
  const hosts = await app.evalJS<number>(CARD_HOSTS);
  expect(hosts, `${kinds.map((k) => k.componentId).join(", ")}: the shell's document mounts no card host`).toBe(0);
}

describe.skipIf(!SHOULD_RUN)("at0741: every registered kind is a body", () => {
  test(
    "one card of every registered kind stands ready in a body, with none in the shell's document",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({ testName: TEST_NAME, bodies: true, env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
      try {
        const kinds = await app.evalJS<RegisteredKind[]>("window.tugdeck.diag.registeredKinds()");
        note(`registered kinds: ${kinds.length} (${kinds.filter((k) => k.hidden).length} hidden; ${kinds.filter((k) => k.bodyHandOff === "spawn").length} spawn-handed)`);
        expect(kinds.length, "the registry holds the shipped kinds and the maker kinds").toBeGreaterThan(20);

        const started = Date.now();
        for (let i = 0; i < kinds.length; i += KINDS_PER_DECK) {
          await proveDeck(app, kinds.slice(i, i + KINDS_PER_DECK), stubDir);
        }
        note(`${kinds.length} kinds stood up in bodies, ${KINDS_PER_DECK} to a deck, in ${((Date.now() - started) / 1000).toFixed(1)} s`);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
