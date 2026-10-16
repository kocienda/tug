/**
 * row-28-deck-facts.test.ts — a body follows the deck's facts that a page
 * cannot see for itself: the modifiers held while the shell has the keyboard,
 * and the focus-ring modality.
 *
 * A body sees only the keys that reach its own view, which is none while the
 * shell holds the keyboard, so the shell sends its held set as the
 * `modifierLatch` deck fact and a body's root wears the union of its own set
 * and the shell's. The focus-ring modality was read by each body from
 * tugbank at boot and never again; it is now a fact the body follows, and the
 * body persists nothing it is sent.
 *
 * One body Session card beside a Text card, which the shell draws:
 *
 * - **The modality.** `focusRingModality` written to tugbank by the CLI, under
 *   the app's instance id, while the app runs reaches the shell through the
 *   DEFAULTS push, and the body's focus
 *   engine follows it, to `pointer` and back.
 * - **The latch, shell key.** With the Text card holding the keyboard, Shift
 *   held through the session tap lands `data-mods="shift"` on the shell's
 *   root and on the body's, and its release clears both.
 * - **The latch, a hand-off while held.** Shift held in the Text card, the
 *   keyboard given to the body, Shift released there: no root is left
 *   wearing `shift`.
 * - **The latch, body key.** With the body holding the keyboard, Shift held
 *   lands on the body's root from its own key events, and the release clears it.
 *
 * @foreground
 * @covers tugdeck/src/components/tugways/modifier-latch.ts
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/focus-ring-modality-store.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App, type BodyApp } from "../_harness";
import { withModifiersHeld } from "../_harness/client";
import { mkTempTugbank, seedTugbankForLaunch } from "../_harness/tugbank-helpers";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { SETTLE_MS, bodyOf, focusBody, pollFor, spawnStub, waitForBody } from "./_bodies";
import { kindDeck, standUpKind } from "./_kind-bodies";
import { kindsUnderTest } from "./_kinds";

const TEST_NAME = "body-grounding-row-28-deck-facts";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const A = "r28-a";
const T = "r28-text";
const TEXT_EDITOR = `[data-card-id="${T}"] [data-slot="tug-text-card-editor"] .cm-content`;
const mods = `document.documentElement.getAttribute("data-mods")`;
const ringFollowsPointer = "window.__tug.ringFollowsPointer()";

/**
 * Write the focus-ring modality into the running app's tugbank the way
 * another process would: the CLI, under the app's instance id, so its change
 * notice reaches that instance's tugcast and the shell is pushed the value.
 */
function writeModality(app: App, tugbankPath: string, value: "keyboard" | "pointer"): void {
  const binary = process.env.TUGAPP_TUGBANK_BINARY;
  expect(binary, "the tugbank CLI is named for the harness").toBeDefined();
  const result = Bun.spawnSync(
    [binary!, "--path", tugbankPath, "write", "dev.tugapp.app", "focusRingModality", "--type", "string", value],
    { env: { ...process.env, TUG_INSTANCE_ID: app.instanceId } },
  );
  expect(result.exitCode, `tugbank write focusRingModality ${value}: ${result.stderr.toString()}`).toBe(0);
}

function deck(): Record<string, unknown> {
  return {
    cards: [
      { id: A, componentId: "session", title: "A", closable: true },
      { id: T, componentId: "text", title: "Text", closable: true },
    ],
    panes: [
      {
        id: `${A}-pane`,
        position: { x: 40, y: 40 },
        size: { width: 640, height: 600 },
        cardIds: [A],
        activeCardId: A,
        title: "",
        acceptsFamilies: ["maker"],
      },
      {
        id: `${T}-pane`,
        position: { x: 720, y: 40 },
        size: { width: 480, height: 600 },
        cardIds: [T],
        activeCardId: T,
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: `${A}-pane`,
    hasFocus: true,
  };
}

/** `deck` with the Text card standing in the band's next slot. */
function withText(deck: Record<string, unknown>): Record<string, unknown> {
  const panes = deck.panes as Array<Record<string, unknown>>;
  const slot = panes.filter((p) => typeof p.slot === "number").length;
  return {
    ...deck,
    cards: [...(deck.cards as unknown[]), { id: T, componentId: "text", title: "Text", closable: true }],
    panes: [...panes, { id: `${T}-pane`, position: { x: 40, y: 40 }, size: { width: 480, height: 600 }, cardIds: [T], activeCardId: T, title: "", acceptsFamilies: ["standard"], slot }],
  };
}

/** Both pages' `data-mods`, polled until `done` or the settle runs out. */
async function modsOf(app: App, a: BodyApp, done: (shell: string | null, body: string | null) => boolean): Promise<{ shell: string | null; body: string | null }> {
  return pollFor(
    async () => ({ shell: await app.evalJS<string | null>(mods), body: await a.evalJS<string | null>(mods) }),
    (m) => done(m.shell, m.body),
    SETTLE_MS,
  );
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 28: the deck facts a body follows", () => {
  for (const kind of kindsUnderTest(28)) test(
    `${kind.componentId}: the focus-ring modality and the shell's held modifiers reach its body`,
    async () => {
      const session = kind.componentId === "session";
      const card = session ? A : `r28-${kind.componentId}`;
      const stubDir = stubDirectory();
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const textDir = mkdtempSync(join(tmpdir(), "tug-row28-text-"));
      const textFile = join(textDir, "notes.txt");
      writeFileSync(textFile, "one\ntwo\nthree\n");
      const app = await launchTugApp({
        testName: kind.componentId === "session" ? TEST_NAME : `${TEST_NAME}-${kind.componentId}`,
        foreground: true,
        bodies: true,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir, TUGBANK_PATH: tugbankPath },
      });
      try {
        await app.seedDeckState({
          state: session ? deck() : withText(kindDeck(kind, card, { sessions: ["r28-seed"] })),
          cardStates: { [T]: { content: { path: textFile, anchor: { line: 1, ch: 0 }, scrollTop: 0 } } },
          focusCardId: card,
        });
        if (session) {
          await spawnStub(app, card, stubDir, 2);
          await waitForBody(app, card);
        } else {
          await standUpKind(app, kind, card);
        }
        const a = app.body(card);

        // ---- The focus-ring modality, followed live ----
        const atStart = { shell: await app.evalJS<boolean | null>(ringFollowsPointer), body: await a.evalJS<boolean | null>(ringFollowsPointer) };
        expect(atStart, "at the start both pages paint the ring on the keyboard only").toEqual({ shell: false, body: false });
        writeModality(app, tugbankPath, "pointer");
        const pointer = await pollFor(
          async () => ({ shell: await app.evalJS<boolean | null>(ringFollowsPointer), body: await a.evalJS<boolean | null>(ringFollowsPointer) }),
          (m) => m.shell === true && m.body === true,
          SETTLE_MS * 3,
        );
        note(`ring follows pointer: at the start ${JSON.stringify(atStart)}; after the write ${JSON.stringify(pointer)}`);
        expect(pointer, "the shell takes the write and the body follows it").toEqual({ shell: true, body: true });
        writeModality(app, tugbankPath, "keyboard");
        const back = await pollFor(
          async () => ({ shell: await app.evalJS<boolean | null>(ringFollowsPointer), body: await a.evalJS<boolean | null>(ringFollowsPointer) }),
          (m) => m.shell === false && m.body === false,
          SETTLE_MS * 3,
        );
        expect(back, "and back, both").toEqual({ shell: false, body: false });

        // ---- The latch with the shell holding the keyboard ----
        await app.nativeClickAtElement(TEXT_EDITOR);
        const shellKey = await pollFor(() => bodyOf(app, card), (b) => b?.firstResponder === false, SETTLE_MS);
        expect(shellKey?.firstResponder, "the Text card's click gives the shell the keyboard").toBe(false);
        let held: { shell: string | null; body: string | null } = { shell: null, body: null };
        await withModifiersHeld(app, ["shift"], async () => {
          held = await modsOf(app, a, (s, b) => s === "shift" && b === "shift");
        });
        const released = await modsOf(app, a, (s, b) => s === null && b === null);
        note(`shell key: Shift held ${JSON.stringify(held)}; released ${JSON.stringify(released)}`);
        expect(held, "Shift held in the shell lands on both roots").toEqual({ shell: "shift", body: "shift" });
        expect(released, "its release clears both").toEqual({ shell: null, body: null });

        // ---- Held in the shell, released in the body ----
        let handedOff: { shell: string | null; body: string | null } = { shell: null, body: null };
        await withModifiersHeld(app, ["shift"], async () => {
          await modsOf(app, a, (s) => s === "shift");
          await focusBody(app, card, { composer: false });
          handedOff = { shell: await app.evalJS<string | null>(mods), body: await a.evalJS<string | null>(mods) };
        });
        const afterHandOff = await modsOf(app, a, (s, b) => s === null && b === null);
        note(`Shift held across the hand-off to the body: while held ${JSON.stringify(handedOff)}; released ${JSON.stringify(afterHandOff)}`);
        expect(afterHandOff, "a modifier released after the keyboard moved leaves neither root wearing it").toEqual({ shell: null, body: null });

        // ---- The body's own key events ----
        let bodyHeld: { shell: string | null; body: string | null } = { shell: null, body: null };
        await withModifiersHeld(app, ["shift"], async () => {
          bodyHeld = await modsOf(app, a, (_s, b) => b === "shift");
        });
        const bodyReleased = await modsOf(app, a, (s, b) => s === null && b === null);
        note(`body key: Shift held ${JSON.stringify(bodyHeld)}; released ${JSON.stringify(bodyReleased)}`);
        expect(bodyHeld.body, "Shift held with the body key lands on the body's root").toBe("shift");
        expect(bodyReleased, "its release clears it").toEqual({ shell: null, body: null });
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
