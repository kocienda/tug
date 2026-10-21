/**
 * row-24-focus-through-motion.test.ts — the body that holds the keyboard
 * keeps it through a settle that carries it on the host, and what is typed
 * during the motion lands in it.
 *
 * The shell decides which card is key and posts `bodyFocus`; the host makes
 * that body's web view the first responder; a settle that only moves frames
 * carries the body's container on the host as Core Animation
 * (`lib/card-plan.ts`). None of that moves the deck's first responder,
 * so nothing should take the keyboard from the body while it rides.
 *
 * A two-up holding two body cards, the mover key with its caret in the
 * composer; a cross-column stack move (the Last pass's move beat, row 14's
 * second gesture) carries it. Characters are typed through the session tap
 * the moment the move is dispatched, while the deck reads settling. The
 * host is read throughout: the mover's body is first responder at every
 * reading. At rest the composer holds exactly what was typed.
 *
 * @foreground activation
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/keyboard-yield.ts
 * @covers tugapp/Sources/BodyBeats.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "../_harness";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { bodyOf, composerText, focusBody, landed, pollFor, sessionPane, spawnStub, waitForBody } from "./_bodies";

const TEST_NAME = "body-grounding-row-24-focus-through-motion";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;
const SETTLE_MS = 6_000;
const TYPED = "carried";

const settling = (app: App): Promise<boolean> =>
  app.evalJS<boolean>(`document.querySelector("[data-deck-canvas-background]")?.hasAttribute("data-imposer-settling") ?? false`);

interface Reading {
  t: number;
  settling: boolean;
  firstResponder: boolean | null;
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 24: the keyboard rides with the body", () => {
  test(
    "a body keeps the keyboard through a carried move, and typing during it lands in its composer",
    async () => {
      const stubDir = stubDirectory();
      const bodies = ["r24-s", "r24-m"];
      const mover = bodies[1];
      const app = await launchTugApp({
        testName: TEST_NAME,
        foreground: true,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({
          state: {
            cards: bodies.map((id) => ({ id, componentId: "session", title: id, closable: true })),
            panes: bodies.map((id, slot) => ({ ...sessionPane(id, slot), size: { width: 675, height: 620 } })),
            activePaneId: `${mover}-pane`,
            imposition: { kind: "two-up" },
            hasFocus: true,
          },
          focusCardId: mover,
        });
        for (const id of bodies) await spawnStub(app, id, stubDir, 2);
        for (const id of bodies) await waitForBody(app, id);
        // Slot 0 stacks, so the mover crosses into it as one move beat.
        await app.evalJS<null>(`(window.__tug.dispatchControlAction("set-column-mode", { slot: 0, mode: "stack" }), null)`);
        await pollFor(() => settling(app), (v) => !v, SETTLE_MS);
        await focusBody(app, mover);
        const body = app.body(mover);
        // An empty composer's text is its placeholder, which typing replaces.
        note(`the composer before: ${JSON.stringify(await body.evalJS<string | null>(composerText))}`);

        const frameBefore = (await bodyOf(app, mover))!.frame;
        const readings: Reading[] = [];
        const t0 = Date.now();
        await app.evalJS<null>(`(window.__tug.dispatchControlAction("assign-slot", { cardId: ${JSON.stringify(mover)}, slot: 0 }), null)`);
        const typedWhileSettling = await settling(app);
        const typing = app.nativeType(TYPED);
        let done = false;
        void typing.finally(() => {
          done = true;
        });
        // Read the host until the move has landed and the typing is over.
        while (Date.now() - t0 < SETTLE_MS) {
          const [moving, b] = await Promise.all([settling(app), bodyOf(app, mover)]);
          readings.push({ t: Date.now() - t0, settling: moving, firstResponder: b?.firstResponder ?? null });
          if (done && !moving) break;
        }
        await typing;
        await landed(app, mover);
        const frameAfter = (await bodyOf(app, mover))!.frame;

        note(`readings: ${JSON.stringify(readings)}`);
        note(`frame ${JSON.stringify(frameBefore)} → ${JSON.stringify(frameAfter)}`);
        expect(frameAfter.x !== frameBefore.x || frameAfter.y !== frameBefore.y, "the move carried the body somewhere else").toBe(true);
        expect(typedWhileSettling, "the typing began while the deck was settling").toBe(true);
        expect(readings.some((r) => r.settling), "the host was read while the move ran").toBe(true);
        const dropped = readings.filter((r) => r.firstResponder !== true);
        expect(dropped, "the mover's body is first responder at every reading").toEqual([]);
        const text = await pollFor(() => body.evalJS<string | null>(composerText), (v) => v === TYPED, 3_000);
        expect(text, "what was typed during the motion is in the composer").toBe(TYPED);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
