/**
 * row-29-voiceover-order.test.ts — VoiceOver reads the window in the deck's
 * order, not the bodies' stacking order.
 *
 * The window's accessibility children were its views in subview order: the
 * bodies, which stand beneath the shell, first, sorted by stacking, and the
 * shell after them. The host now hands the window its reading order on every
 * placement: the shell's view, which holds the deck's chrome and every card
 * it draws itself, then each showing body in its pane's place in the shell's
 * document.
 *
 * Two body Session cards with a Text card between them, three-up, the first
 * one active so it stands in front: the tree reads the shell and then the
 * bodies left to right — the Text card is a body too, so it is read between
 * them. The canvas renders panes in pane-id order, which here is not the
 * deck's (`r29-text` sorts after `r29-b`), so the order read is the one the
 * shell posts, not the document's. Giving the third card the keyboard
 * brings its pane forward and leaves the order where it was, so the order is
 * the deck's and not the stacking's.
 *
 * Every other kind that is a body is read the same way, standing to the
 * right of a body Session card and the Text card — a rail on its edge.
 *
 * The overlay page stands over every card and is read last, after the
 * cards: what it holds covers the deck ([D216]).
 *
 * @foreground
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/MainWindow.swift
 * @covers tugdeck/src/lib/card-placement.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "../_harness";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { SETTLE_MS, focusBody, pollFor, sessionPane, spawnStub, waitForBody } from "./_bodies";
import { standUpKind } from "./_kind-bodies";
import { kindPane, kindSidebars, kindsUnderTest, sessionUnderTest } from "./_kinds";

const TEST_NAME = "body-grounding-row-29-voiceover-order";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const A = "r29-a";
const B = "r29-b";
const T = "r29-text";

function deck(): Record<string, unknown> {
  return {
    cards: [
      { id: A, componentId: "session", title: "A", closable: true },
      { id: T, componentId: "text", title: "Text", closable: true },
      { id: B, componentId: "session", title: "B", closable: true },
    ],
    panes: [
      sessionPane(A, 0),
      {
        id: `${T}-pane`,
        position: { x: 40, y: 40 },
        size: { width: 640, height: 480 },
        cardIds: [T],
        activeCardId: T,
        title: "",
        acceptsFamilies: ["standard"],
        slot: 1,
      },
      sessionPane(B, 2),
    ],
    activePaneId: `${A}-pane`,
    imposition: { kind: "three-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 29: VoiceOver's order", () => {
  for (const kind of kindsUnderTest(29)) {
    if (kind.componentId === "session") continue;
    test(
      `${kind.componentId}: the window reads the shell and then each body in deck order, whichever pane stands in front`,
      async () => {
        const K = `r29-${kind.componentId}`;
        const stubDir = stubDirectory();
        const textDir = mkdtempSync(join(tmpdir(), "tug-row29-text-"));
        const textFile = join(textDir, "notes.txt");
        writeFileSync(textFile, "one\ntwo\n");
        const app = await launchTugApp({ testName: `${TEST_NAME}-${kind.componentId}`, foreground: true, env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
        try {
          const base = deck() as { cards: unknown[]; panes: unknown[] };
          await app.seedDeckState({
            state: {
              ...base,
              cards: [...base.cards.filter((c) => (c as { id: string }).id !== B), { id: K, componentId: kind.componentId, title: kind.componentId, closable: true }],
              panes: [...base.panes.filter((p) => (p as { id: string }).id !== `${B}-pane`), kindPane(kind.componentId, K, 2)],
              imposition: { kind: "three-up", layout: "fit", sidebars: kindSidebars([kind.componentId]) },
            },
            cardStates: { [T]: { content: { path: textFile, anchor: { line: 1, ch: 0 }, scrollTop: 0 } } },
            focusCardId: A,
          });
          await spawnStub(app, A, stubDir, 2);
          await waitForBody(app, A);
          await standUpKind(app, kind, K);
          await focusBody(app, A, { composer: false });
          const expected = ["shell", A, T, K, "overlay"];
          const first = await pollFor(() => app.accessibilityOrder(), (o) => JSON.stringify(o) === JSON.stringify(expected), SETTLE_MS);
          note(`A in front: order ${JSON.stringify(first)}`);
          expect(first, "the shell, then the bodies left to right").toEqual(expected);
          await focusBody(app, K, { composer: false });
          const second = await pollFor(() => app.accessibilityOrder(), (o) => JSON.stringify(o) === JSON.stringify(expected), SETTLE_MS);
          note(`${K} in front: order ${JSON.stringify(second)}`);
          expect(second, `bringing the ${kind.componentId} card forward leaves the deck's order`).toEqual(expected);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  }

  test.skipIf(!sessionUnderTest(29))(
    "the window reads the shell and then each body in deck order, whichever pane stands in front",
    async () => {
      const stubDir = stubDirectory();
      const textDir = mkdtempSync(join(tmpdir(), "tug-row29-text-"));
      const textFile = join(textDir, "notes.txt");
      writeFileSync(textFile, "one\ntwo\n");
      const app = await launchTugApp({
        testName: TEST_NAME,
        foreground: true,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({
          state: deck(),
          cardStates: { [T]: { content: { path: textFile, anchor: { line: 1, ch: 0 }, scrollTop: 0 } } },
          focusCardId: A,
        });
        await spawnStub(app, A, stubDir, 2);
        await spawnStub(app, B, stubDir, 2);
        await waitForBody(app, A);
        await waitForBody(app, B);
        await focusBody(app, A, { composer: false });
        const expected = ["shell", A, T, B, "overlay"];

        const bodies = await app.bodies();
        const first = await pollFor(() => app.accessibilityOrder(), (o) => JSON.stringify(o) === JSON.stringify(expected), SETTLE_MS);
        note(`A in front: z ${JSON.stringify(bodies.filter((x) => x.cardId !== null).map((x) => ({ card: x.cardId, z: x.z })))}; order ${JSON.stringify(first)}`);
        expect(first, "the shell, then the bodies left to right").toEqual(expected);

        await focusBody(app, B, { composer: false });
        const zAfter = (await app.bodies()).filter((x) => x.cardId !== null).map((x) => ({ card: x.cardId, z: x.z }));
        const second = await pollFor(() => app.accessibilityOrder(), (o) => JSON.stringify(o) === JSON.stringify(expected), SETTLE_MS);
        note(`B in front: z ${JSON.stringify(zAfter)}; order ${JSON.stringify(second)}`);
        expect(second, "bringing B forward leaves the deck's order").toEqual(expected);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
