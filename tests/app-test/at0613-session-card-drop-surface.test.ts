/**
 * at0613-session-card-drop-surface.test.ts — a file dropped anywhere on a
 * Session card's content area lands at the composer's caret.
 *
 * ## The gap this pins
 *
 * Dropping a file on a Session card is one gesture with one meaning — *put
 * this in the prompt* — and the card used to honour it only over the bottom
 * fifth of itself. Over the transcript the drag was claimed by nobody: the
 * composer's own surface is continuous, but nothing above it listened, and an
 * unclaimed file drop in a single-webview app is not reliably inert. The
 * card's content area is now the surface, and the insertion point is the
 * composer's live selection rather than whatever is under the pointer —
 * because over the transcript there is no document under the pointer at all.
 *
 * ## Shape
 *
 * One app, two Session cards in two panes, three assertions in the order the
 * bindings allow:
 *
 *   **Declines with no composer.** Card B boots unbound, so its picker
 *   renders in place of the card content and there is no composer to insert
 *   into. A `dragover` over B comes back with `defaultPrevented === false` —
 *   the drag reads as refused by the OS rather than accepted and swallowed.
 *
 *   **Lands at the caret.** Card A is bound. Type `AB` into its composer and
 *   press ArrowLeft, so the caret sits at offset 1 with text on both sides of
 *   it. Drop a real PNG on A's *transcript* region — well outside the
 *   composer — and the draft comes back as `A￼B`: the atom at the caret,
 *   not appended at the end, and the draft either side of it intact. The
 *   `dragover` that preceded it was accepted, which is what the OS reads as
 *   "this surface wants the file".
 *
 *   **An inactive card raises.** Bind B, then activate A. Dropping on B's
 *   transcript makes B the active card and puts the atom in B's composer —
 *   dropping on a background card means "put this in *that* card's prompt",
 *   and the prompt the files land in should be the one the user ends up
 *   looking at.
 *
 * The drop is a synthesized `DragEvent` carrying a real canvas-minted PNG
 * `File` — the same event the OS delivers for a Finder drag, through the
 * production `processAttachmentFiles` pipeline, downsample and all. What a
 * dropped file *becomes* is not this test's subject; where the gesture is
 * accepted is.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/prompt-insert-target.ts
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/components/tugways/cards/use-session-card-drop.ts
 * @covers tugdeck/src/components/tugways/use-composer-drop.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor/drop-extension.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 120_000;

/** The atom sentinel the substrate stands an atom widget on. */
const ATOM_CHAR = "￼";

/** The composer's editable surface, per card. */
const editorContent = (card: string): string =>
  `[data-card-id="${card}"] [data-slot="tug-text-editor"] .cm-content`;

/**
 * The card's transcript region — inside `.session-card` (the content area
 * that is the drop surface) and well outside the composer, which is the whole
 * point of the drop this test makes.
 */
const transcriptRegion = (card: string): string =>
  `[data-card-id="${card}"] [data-slot="session-card-top-column"]`;

const atomImg = (card: string): string =>
  `${editorContent(card)} img[data-atom-label]`;

const DECK_STATE = {
  cards: [
    { id: "A", componentId: "session", title: "Session A", closable: true },
    { id: "B", componentId: "session", title: "Session B", closable: true },
  ],
  panes: [
    {
      id: "p1",
      position: { x: 20, y: 20 },
      size: { width: 620, height: 460 },
      cardIds: ["A"],
      activeCardId: "A",
      title: "",
      acceptsFamilies: ["maker"],
    },
    {
      id: "p2",
      position: { x: 680, y: 20 },
      size: { width: 620, height: 460 },
      cardIds: ["B"],
      activeCardId: "B",
      title: "",
      acceptsFamilies: ["maker"],
    },
  ],
  activePaneId: "p1",
  hasFocus: true,
};

/**
 * Dispatch a `dragover` and then a `drop` carrying one real PNG `File` on
 * `selector`, and report whether the `dragover` was accepted. `evalJS` cannot
 * await and `canvas.toBlob` is async, so completion rides a window flag.
 *
 * The PNG is minted in-page so the bytes are real ones a real decoder has to
 * handle, with no fixture to copy.
 */
async function dragFileOnto(
  app: App,
  selector: string,
): Promise<{ accepted: boolean }> {
  await app.evalJS<void>(
    `(function(){
      window.__at0613 = { done: false, accepted: null };
      var el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) { window.__at0613.done = true; return; }
      var canvas = document.createElement("canvas");
      canvas.width = 64; canvas.height = 48;
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#2b3a55"; ctx.fillRect(0, 0, 64, 48);
      ctx.fillStyle = "#e8c07d"; ctx.fillRect(8, 8, 24, 24);
      canvas.toBlob(function(blob){
        var dt = new DataTransfer();
        dt.items.add(new File([blob], "dropped.png", { type: "image/png" }));
        var r = el.getBoundingClientRect();
        var x = r.left + r.width / 2;
        var y = r.top + r.height / 2;
        function fire(kind){
          var ev = new DragEvent(kind, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
          });
          Object.defineProperty(ev, "dataTransfer", { value: dt });
          el.dispatchEvent(ev);
          return ev.defaultPrevented;
        }
        window.__at0613.accepted = fire("dragover");
        fire("drop");
        window.__at0613.done = true;
      }, "image/png");
    })()`,
  );
  await app.waitForCondition<boolean>(`window.__at0613.done === true`, {
    timeoutMs: 5_000,
  });
  const accepted = await app.evalJS<boolean>(
    `window.__at0613.accepted === true`,
  );
  return { accepted };
}

/**
 * The card's live draft — the editor's own document string, with
 * {@link ATOM_CHAR} standing where each atom sits. Forces a save first so the
 * bag reflects the editor's current state rather than the last quiescent one.
 */
async function readDraftText(app: App, card: string): Promise<string | null> {
  return app.evalJS<string | null>(
    `(function(){
      window.tugdeck && window.tugdeck.saveState && window.tugdeck.saveState();
      var bag = window.__tug.getCardStateBag(${JSON.stringify(card)});
      var draft = bag && bag.content ? bag.content.draft : null;
      return draft && typeof draft.text === "string" ? draft.text : null;
    })()`,
  );
}

/** Wait until the card's composer holds an editable surface. */
async function awaitComposer(app: App, card: string): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(editorContent(card))}) !== null`,
    { timeoutMs: 15_000 },
  );
}

describe.skipIf(!SHOULD_RUN)(
  "at0613: the Session card's content area is the drop surface",
  () => {
    test(
      "a file dropped over the transcript lands at the composer's caret",
      async () => {
        const app = await launchTugApp({
          testName: "at0613-session-card-drop-surface",
        });

        await app.seedDeckState({ state: DECK_STATE, focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A");
        await awaitComposer(app, "A");

        // ── Declines when there is no composer ───────────────────────
        // B is unbound, so its picker renders in place of the card
        // content and these handlers are not mounted at all. The drag
        // has to read as refused rather than be accepted and swallowed.
        const unbound = await dragFileOnto(app, `[data-card-id="B"]`);
        expect(
          unbound.accepted,
          "axis decline: a drag over an unbound card (picker up) is not accepted",
        ).toBe(false);

        // ── Lands at the caret, not appended ─────────────────────────
        await app.nativeClickAtElement(editorContent("A"));
        await app.waitForCondition<boolean>(
          `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(editorContent("A"))})`,
          { timeoutMs: 3_000 },
        );
        await app.nativeType("AB");
        await app.nativeKey("ArrowLeft");
        await app.waitForCondition<boolean>(
          `(function(){
            var bag = window.__tug.getCardStateBag("A");
            var d = bag && bag.content ? bag.content.draft : null;
            return d !== null && d.text === "AB";
          })()`,
          { timeoutMs: 5_000 },
        );

        const onTranscript = await dragFileOnto(app, transcriptRegion("A"));
        expect(
          onTranscript.accepted,
          "axis accept: a file drag over the transcript is accepted by the card",
        ).toBe(true);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(atomImg("A"))}) !== null`,
          { timeoutMs: 15_000 },
        );
        expect(
          await readDraftText(app, "A"),
          "axis caret: the atom lands at the caret, with the draft intact either side",
        ).toBe(`A${ATOM_CHAR}B`);

        // ── An inactive card accepts, and raises itself ──────────────
        await app.bindSession("B");
        await awaitComposer(app, "B");
        await app.nativeClickAtElement(editorContent("A"));
        await app.waitForCondition<boolean>(
          `window.__tug.getActiveCardId() === "A"`,
          { timeoutMs: 5_000 },
        );

        const onBackground = await dragFileOnto(app, transcriptRegion("B"));
        expect(
          onBackground.accepted,
          "axis accept: a background card's transcript accepts the drag too",
        ).toBe(true);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(atomImg("B"))}) !== null`,
          { timeoutMs: 15_000 },
        );
        expect(
          await app.getActiveCardId(),
          "axis raise: dropping on a background card brings it forward",
        ).toBe("B");
        expect(
          await readDraftText(app, "B"),
          "axis routing: the files land in the dropped-on card's composer",
        ).toBe(ATOM_CHAR);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
