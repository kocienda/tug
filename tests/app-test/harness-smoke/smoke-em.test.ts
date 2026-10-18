/**
 * smoke-em.test.ts — EM-card observation surface smoke ([AT0010] area).
 * Permanent test file (not scratch).
 *
 * ## What this file pins
 *
 * The EM-card observation surface added at tugdeck `SURFACE_VERSION`
 * 1.2.0:
 *
 *   1. **engine-ready trace event** — when an EM card mounts, its
 *      factory emits an `engine-ready` deck-trace event with the
 *      card id and engine name. Wired in
 *      `tug-text-editor.tsx` (other factories follow as wired).
 *
 *   2. **`__tug.getEmCardState(cardId)`** — returns
 *      `{ kind: "em", engine, text, engineSelection, streamState,
 *      lastTurnSeq }` for an EM card with content captured in its
 *      bag, or `null` for FC cards / unknown ids. The surface
 *      forces a save before reading so the returned text reflects
 *      current engine content.
 *
 *   3. **`__tug.isEngineReady(cardId)` / harness
 *      `app.awaitEngineReady`** — pure / wrapped variants of the
 *      same trace-ring scan, used to gate test assertions on
 *      engine init.
 *
 * ## Out of scope (streaming)
 *
 * Driving a real tugcode round-trip into the EM card (typing →
 * stream-json → assistant text → engine update). The harness's
 * tugcode is independent of tugdeck's production tugcast → tugcode
 * path, so end-to-end AI streaming requires tugcast-bypass
 * plumbing not yet in place. This smoke focuses on the
 * observation primitives the streaming layer will eventually feed.
 *
 * ## Gating
 *
 * `describe.skipIf(!SHOULD_RUN)`. CI and `bun x tsc --noEmit` runs
 * without `TUGAPP_APP_TEST=1` skip every test.
 *
 * @covers tests/app-test/_harness/
 * @covers tugapp/Sources/TestHarness/
 * @covers tugdeck/src/test-surface.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "../_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const PROMPT_INPUT_SELECTOR = '[data-slot="tug-text-editor"] .cm-content';

describe.skipIf(!SHOULD_RUN)("EM-card observation surface", () => {
  test("engine-ready fires when a TugTextEditor-backed EM card mounts", async () => {
    const app = await launchTugApp({ testName: "smoke-em-engine-ready" });
    try {
      await app.enableDeckTrace(true);

      // Seed a single EM card. `gallery-prompt-entry` is the
      // gallery's TugPromptEntry showcase (wraps TugTextEditor); its
      // `useCardStatePreservation` returns engine state on save, which
      // makes it an EM card by `bag.content !== undefined`.
      await app.seedDeckState({
        state: {
          cards: [
            {
              id: "A",
              componentId: "gallery-prompt-entry",
              title: "Card A",
              closable: true,
            },
          ],
          panes: [
            {
              id: "p1",
              position: { x: 40, y: 40 },
              size: { width: 480, height: 320 },
              cardIds: ["A"],
              activeCardId: "A",
              title: "",
              acceptsFamilies: ["maker"],
            },
          ],
          activePaneId: "p1",
          hasFocus: true,
        },
        focusCardId: "A",
      });

      await app.waitForCondition<boolean>(
        `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
      );

      // engine-ready should fire as TugTextEditor's useLayoutEffect
      // creates the EditorView and stamps the trace event. The event
      // is recorded synchronously during the mount commit, so the
      // await completes well under 2000ms.
      await app.awaitEngineReady("A");

      // Probe the trace ring directly to assert the engine-ready
      // event carries the expected fields. The editor mounts in the
      // card's body, so the event is in the body's ring. TugTextEditor
      // stamps `engine: "tug-text-editor"` regardless of which wrapper
      // mounts it (TugPromptInput, TugPromptEntry, etc.).
      const events = await app.body("A").getDeckTrace();
      const engineReady = events.find(
        (e) => e.kind === "engine-ready" && (e as { cardId?: string }).cardId === "A",
      );
      expect(engineReady).toBeDefined();
      expect((engineReady as { engine?: string }).engine).toBe("tug-text-editor");

      // isEngineReady is the synchronous variant of awaitEngineReady;
      // both must agree.
      expect(await app.isEngineReady("A")).toBe(true);
      expect(await app.isEngineReady("nonexistent")).toBe(false);
    } finally {
      await app.close();
    }
  });

  test("getEmCardState reflects current engine text after typing", async () => {
    const app = await launchTugApp({ testName: "smoke-em-get-state" });
    try {
      await app.enableDeckTrace(true);
      await app.seedDeckState({
        state: {
          cards: [
            {
              id: "A",
              componentId: "gallery-prompt-entry",
              title: "Card A",
              closable: true,
            },
          ],
          panes: [
            {
              id: "p1",
              position: { x: 40, y: 40 },
              size: { width: 480, height: 320 },
              cardIds: ["A"],
              activeCardId: "A",
              title: "",
              acceptsFamilies: ["maker"],
            },
          ],
          activePaneId: "p1",
          hasFocus: true,
        },
        focusCardId: "A",
      });

      await app.waitForCondition<boolean>(
        `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
      );
      await app.awaitEngineReady("A");

      // Click into the prompt input to focus it, then type some
      // text. The selector matches TugTextEditor's contenteditable
      // (`.cm-content`) inside the gallery card.
      await app.body("A").nativeClickAtElement(`[data-card-id="A"] ${PROMPT_INPUT_SELECTOR}`);
      await app.body("A").waitForCondition<boolean>(
        `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(PROMPT_INPUT_SELECTOR)})`,
      );
      await app.nativeType("hello em");

      // Native typing into a WebKit contenteditable produces
      // input events asynchronously — the engine's text buffer
      // may not reflect every keystroke by the time `nativeType`
      // resolves. Wait for the engine to report the full text
      // before asserting.
      await app.body("A").waitForCondition<boolean>(
        `(typeof window.__tug !== "undefined") && (window.__tug.getEmCardState("A")?.text === "hello em")`,
        { timeoutMs: 2000 },
      );

      // getEmCardState returns the EM state. The page-side
      // surface fires invokeSaveCallback before reading, so the
      // text is current despite no debounce window having elapsed.
      const state = await app.getEmCardState("A");
      expect(state).not.toBeNull();
      expect(state!.kind).toBe("em");
      expect(state!.engine).toBe("gallery-prompt-entry");
      expect(state!.text).toBe("hello em");
      // Stub fields until streaming is wired; pinned so a regression in
      // their default values surfaces here.
      expect(state!.streamState).toBe("idle");
      expect(state!.lastTurnSeq).toBe(0);
    } finally {
      await app.close();
    }
  });

  test("getEmCardState returns null for an FC card", async () => {
    const app = await launchTugApp({ testName: "smoke-em-fc-returns-null" });
    try {
      await app.seedDeckState({
        state: {
          cards: [
            {
              id: "A",
              componentId: "gallery-input",
              title: "Card A",
              closable: true,
            },
          ],
          panes: [
            {
              id: "p1",
              position: { x: 40, y: 40 },
              size: { width: 400, height: 320 },
              cardIds: ["A"],
              activeCardId: "A",
              title: "",
              acceptsFamilies: ["maker"],
            },
          ],
          activePaneId: "p1",
          hasFocus: true,
        },
        focusCardId: "A",
      });

      await app.waitForCondition<boolean>(
        `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
      );

      // gallery-input is an FC card — its useCardStatePreservation
      // doesn't return engine state, so bag.content is undefined.
      // getEmCardState must return null without throwing.
      const state = await app.getEmCardState("A");
      expect(state).toBeNull();
    } finally {
      await app.close();
    }
  });
});
