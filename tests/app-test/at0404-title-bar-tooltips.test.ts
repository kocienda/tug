/**
 * at0404-title-bar-tooltips.test.ts — every control at the trailing end of a
 * title bar says what it does before you press it.
 *
 * The cluster is a row of icons and a count: a stack badge, a bullseye target,
 * the active card's own verbs (a Text card contributes Reveal in Finder and
 * Card Settings…), a width control, and the close box. All but the count are
 * glyphs with no text anywhere near them, and the count is a bare number. Read
 * cold, none of them is self-evident — so each carries a tooltip, and two of
 * them carry the chord that does the same thing without the mouse.
 *
 * What is worth proving here:
 *
 *   1. Each control opens a bubble, and the bubble names an ACT. The phrase is
 *      the thing the press will do ("Center this card in bullseye"), not a
 *      restatement of the glyph ("Bullseye") — the glyph is already on screen
 *      and repeating it in prose tells the reader nothing they did not have.
 *
 *   2. The chord chip is READ, never authored. Bullseye and close both
 *      duplicate a keyboard shortcut, so both are `TugActionTooltip`s whose
 *      chip comes from the keymap registry through `commandShortcut`. The
 *      proof that it is read is a REBIND: the test writes an override the way
 *      any other process would, through the defaults path, and the chip says
 *      the new chord on its next hover with no reload. An authored "⌃⌘B"
 *      would pass every assertion above this one and fail this one. The width
 *      control gets NO chip: its chords are ⌃⌘1/2/3, one per preset, and the
 *      trigger is none of them.
 *
 *   3. The phrase turns with the state it describes. In bullseye the button
 *      offers the way out; the width control names the width it is currently
 *      holding. A tooltip that read the same in both postures would be the
 *      resting lie the `aria-label` already avoids.
 *
 *   4. The composition survives. Two of these controls are popup-menu
 *      triggers and a third runs its own pointer-capture close protocol,
 *      so none of them can be a Radix tooltip trigger directly — the bubble
 *      anchors a span around each. The proof that the wrapper is inert is that
 *      the controls still work: this test opens the width menu through the
 *      same span it just hovered. (Option-click close, the gesture the direct
 *      composition broke, is held by at0040.)
 *
 * Hover is synthesized the way at0334 does it — a `pointerenter` plus a
 * `pointermove` on the trigger — because a background app-test window runs no
 * rAF and nothing here may hang off an animation completing. The bubble is
 * portaled to the canvas overlay, so it is found globally rather than under
 * the pane.
 *
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/lib/pane-title-bar-items-store.ts
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugdeck/src/components/tugways/tug-action-tooltip.tsx
 * @covers tugdeck/src/components/tugways/tug-tooltip.tsx
 * @covers tugdeck/src/components/tugways/tug-tooltip.css
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** The settle window (`IMPOSITION_SETTLE_MS`), with room for the tween. */
const AFTER_LAND_MS = 900;

const PANE = '[data-pane-id="p1"]';
const BADGE = `${PANE} [data-testid="tug-pane-title-bar-stack-badge"]`;
const SLOT_BADGE = `${PANE} [data-testid="card-slot-badge-trigger"]`;
const BULLSEYE = `${PANE} [data-testid="tug-pane-title-bar-bullseye-button"]`;
const REVEAL_BUTTON = `${PANE} [data-testid="tug-pane-title-bar-item-reveal-card-file"]`;
const OPTIONS_BUTTON = `${PANE} [data-testid="tug-pane-title-bar-item-show-card-settings"]`;
const WIDTH_BUTTON = `${PANE} [data-testid="tug-pane-title-bar-width-button"]`;
const MOVE_SPACE_BUTTON = `${PANE} [data-testid="tug-pane-title-bar-move-space-button"]`;
const CLOSE_BUTTON = `${PANE} [data-testid="tug-pane-close-button"]`;
const WIDTH_MENU = '[data-testid="tug-pane-title-bar-width-menu"]';

const BUBBLE = '[data-slot="tug-tooltip"]';
/**
 * The chip is always read as a DIRECT child of the bubble: the bubble also
 * holds a visually-hidden `[role="tooltip"]` copy of everything for the screen
 * reader, and a descendant selector would find that copy's chip too.
 */

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

function mkFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0404-"));
  const file = path.join(dir, "sample.txt");
  fs.writeFileSync(file, "fixture line 1\nfixture line 2\n", "utf8");
  return file;
}

/**
 * Two panes in slot 0 so the stack badge has something to report, at
 * MISMATCHED widths so the buried one is not fully covered and the front one
 * stays hoverable. The front card is a Text card because a Text card is what
 * publishes title-bar items — without one the card-contributed buttons do not
 * render at all, and there would be nothing to hover.
 */
function deckShape() {
  return {
    cards: [
      { id: "Z", componentId: "gallery-animator", title: "Card Z", closable: true },
      { id: "A", componentId: "text", title: "File", closable: true },
    ],
    panes: [
      {
        id: "p0",
        position: { x: 40, y: 40 },
        size: { width: 620, height: 460 },
        cardIds: ["Z"],
        activeCardId: "Z",
        title: "",
        acceptsFamilies: ["standard"],
        slot: 0,
      },
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 480, height: 460 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
        slot: 0,
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/**
 * An expression evaluating to the element a control's tooltip HANGS FROM: the
 * span wrapper where there is one, the control itself where there is not.
 */
const anchorExpr = (selector: string): string =>
  `(function () {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) throw new Error("no trigger: " + ${JSON.stringify(selector)});
    // Two anchor classes, because two components solve the same composition
    // problem in their own file: a control already claimed by a Radix
    // \`asChild\` slot cannot also be the tooltip's trigger, so each wraps a
    // span the bubble can address. The cluster's is
    // \`.tug-pane-title-bar-tooltip-anchor\`; the slot chip's is its own.
    // A control that needs no wrapper — the target — is its own anchor.
    return el.closest(".tug-pane-title-bar-tooltip-anchor")
      || el.closest(".card-slot-badge-anchor")
      || el;
  })()`;

/**
 * An expression evaluating to THIS control's bubble, or null.
 *
 * Found through the trigger rather than by taking whatever bubble happens to
 * be in the document. An open Radix tooltip points its trigger's
 * aria-describedby at the announced copy inside its own content, so following
 * that link can never hand back the previous control's bubble mid-handover —
 * which a bare document-wide query would do, and would do intermittently.
 */
const bubbleExpr = (selector: string): string =>
  `(function () {
    var anchor = ${anchorExpr(selector)};
    var id = anchor.getAttribute("aria-describedby");
    if (!id) return null;
    var announced = document.getElementById(id);
    return announced === null
      ? null
      : announced.closest(${JSON.stringify(BUBBLE)});
  })()`;

/**
 * Take the pointer OFF a control, and wait until it no longer describes a
 * bubble.
 *
 * Needed before a second hover of the same control, and for a reason worth
 * knowing: Radix's trigger latches "the pointer is inside me" and only clears
 * the latch on leave, so a second `pointerenter` while the latch stands is
 * dropped on the floor and the bubble never reopens.
 *
 * The leave is dispatched as a POINTEROUT carrying a relatedTarget outside the
 * element, because that is what React derives its synthetic `onPointerLeave`
 * from — a bare `pointerleave` does not bubble and the synthetic system never
 * sees it.
 *
 * The wait reads `aria-describedby` — the trigger's own statement that it has
 * a bubble — rather than the bubble's presence in the DOM. A closing Radix
 * tooltip stays mounted for its exit animation, and a background app-test
 * window runs no rAF, so waiting for the element to go could wait forever.
 */
async function unhover(app: App, selector: string): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      var anchor = ${anchorExpr(selector)};
      anchor.dispatchEvent(
        new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
      );
      return null;
    })()`,
  );
  await app.waitForCondition<boolean>(
    `${anchorExpr(selector)}.getAttribute("aria-describedby") === null`,
    { timeoutMs: 8000 },
  );
}

/** Put the pointer on a control and wait for its bubble to stand. */
async function hover(app: App, selector: string): Promise<void> {
  await unhover(app, selector);
  await app.evalJS<null>(
    `(function () {
      var anchor = ${anchorExpr(selector)};
      anchor.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
      anchor.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
      return null;
    })()`,
  );
  await app.waitForCondition<boolean>(`${bubbleExpr(selector)} !== null`, {
    timeoutMs: 8000,
  });
}

/**
 * Hover a control and read its bubble's phrase — the visible text, with any
 * chord chip stripped off the end.
 */
async function hoverPhrase(app: App, selector: string): Promise<string> {
  await hover(app, selector);
  return app.evalJS<string>(
    `(function () {
      var bubble = ${bubbleExpr(selector)};
      // Radix renders the phrase TWICE inside the bubble: once to be seen,
      // and once more in a visually-hidden [role="tooltip"] node that is what
      // a screen reader announces. Reading the whole subtree's text would
      // hand back the phrase doubled, so take the visible children only.
      var text = Array.prototype.filter
        .call(bubble.childNodes, function (n) {
          return !(n.nodeType === 1 && n.getAttribute("role") === "tooltip");
        })
        .map(function (n) { return n.textContent || ""; })
        .join("");
      var chip = bubble.querySelector(":scope > .tug-tooltip-shortcut");
      if (chip !== null) text = text.replace(chip.textContent || "", "");
      return text.trim();
    })()`,
  );
}

/** The chord chip on a control's bubble, or null when it carries none. */
async function chipText(app: App, selector: string): Promise<string | null> {
  return app.evalJS<string | null>(
    `(function () {
      var bubble = ${bubbleExpr(selector)};
      if (bubble === null) return null;
      var chip = bubble.querySelector(":scope > .tug-tooltip-shortcut");
      return chip === null ? null : chip.textContent.trim();
    })()`,
  );
}

/**
 * Poll a standing bubble's chip until it reads `want`, and return whatever it
 * last read. A rebind reaches the tooltip through a store notification, so the
 * update is a render away rather than an awaited round trip.
 */
async function waitForChip(
  app: App,
  selector: string,
  want: string,
  timeoutMs = 8000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  while (Date.now() < deadline) {
    last = await chipText(app, selector);
    if (last === want) return last;
    await wait(100);
  }
  return last;
}

const KEYMAP_DOMAIN = "dev.tugapp.keymap";

/** Write one command's override the way any other process would. */
async function writeOverride(
  app: App,
  commandId: string,
  bindings: unknown[],
): Promise<void> {
  const args = JSON.stringify([
    KEYMAP_DOMAIN,
    commandId,
    { kind: "string", value: JSON.stringify(bindings) },
  ]);
  await app.evalJS<void>(`window.__tug.setTugbankValue(...${args})`);
}

/** Drop the override — a deletion, which is how "use whatever ships" is spelled. */
async function resetOverride(app: App, commandId: string): Promise<void> {
  const args = JSON.stringify([KEYMAP_DOMAIN, commandId]);
  await app.evalJS<void>(`window.__tug.deleteTugbankValue(...${args})`);
}

describe.skipIf(!SHOULD_RUN)(
  "at0404 — the title bar's trailing controls name their acts",
  () => {
    test(
      "each control opens a bubble that names what pressing it does",
      async () => {
        const app = await launchTugApp({ testName: "at0404-title-bar-tooltips" });
        try {
          await app.seedDeckState({
            state: deckShape(),
            cardStates: {
              A: { content: { path: mkFixture(), anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
            },
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('.tug-pane[data-pane-id]').length === 2`,
            { timeoutMs: 5000 },
          );
          await wait(AFTER_LAND_MS);

          // --- The column badge: the count, then the acts, then the chord. -
          // The badge is small and its glyph is schematic, so a reader hovering
          // it is asking two questions at once — what am I looking at, and what
          // happens if I press. The phrase answers them in that order.
          //
          // Reading the count off the phrase is not redundant with the numeral
          // the badge draws: the numeral is one character behind a stack of
          // slices at 11px, and the bubble is where it gets said in words.
          expect(
            await hoverPhrase(app, BADGE),
            "the badge says how many cards share the column, then what pressing it does",
          ).toBe("2 cards in this column — press to show one, or split it");
          expect(
            await chipText(app, BADGE),
            "and names the chord that splits without the mouse",
          ).toBe("⌃⌘S");

          // --- The slot badge: where the card is, and that it can move. ----
          // The chip's numeral says where the card stands and nothing on it
          // says the number is changeable, which is the whole reason it has a
          // bubble. No chord: assigning a slot holds no binding of its own.
          expect(
            await hoverPhrase(app, SLOT_BADGE),
            "the chip says the position it holds, out of how many, and that pressing moves the card",
          // The seed names no imposition, so the deck stands in its default
          // three-up: the chip reports the arrangement it is actually in, not
          // the number of panes that happen to be on the deck.
          ).toBe("In position 1 of 3 — press to move this card");
          expect(
            await chipText(app, SLOT_BADGE),
            "slot assignment has no chord to advertise",
          ).toBeNull();

          // --- Bullseye: the act, plus the chord that does it. ------------
          expect(
            await hoverPhrase(app, BULLSEYE),
            "out of bullseye, the target offers the way in",
          ).toBe("Center this card in bullseye");
          expect(
            await chipText(app, BULLSEYE),
            "and names the chord that does the same thing without the mouse",
          ).toBe("⌃⌘B");

          // --- The card's own verbs: each button says its command. --------
          // Both phrases are READ from the command table, the same source the
          // File menu's items and any chord read, so a button and its command
          // cannot say different things.
          expect(
            await hoverPhrase(app, REVEAL_BUTTON),
            "the folder glyph names the act, from the registry",
          ).toBe("Reveal in Finder");
          expect(
            await hoverPhrase(app, OPTIONS_BUTTON),
            "the gear opens the card's own view settings",
          ).toBe("Card Settings…");

          // --- Move to Workspace: the act, and why it is dimmed. ----------
          // One workspace stands in this deck, so the trigger is disabled and
          // the phrase has to say so — which is the whole reason the bubble
          // hangs off the anchoring span rather than the button ([L31]): a
          // disabled button takes no pointer events, and the one state that
          // most needs explaining would explain nothing.
          expect(
            await hoverPhrase(app, MOVE_SPACE_BUTTON),
            "dimmed, it says what it would do and why it cannot",
          ).toBe("Move this card to another workspace — there is only one");
          expect(
            await chipText(app, MOVE_SPACE_BUTTON),
            "the move has no chord yet — drag is its fast path",
          ).toBeNull();

          // --- Width: the act, and the width it is holding now. -----------
          expect(
            await hoverPhrase(app, WIDTH_BUTTON),
            "a seeded pane carries no preset, so the phrase claims none",
          ).toBe("Set this card's width");
          expect(
            await chipText(app, WIDTH_BUTTON),
            "the width chords are one per preset; this trigger is none of them",
          ).toBeNull();

          // --- Close: the act, and ⌘W. ------------------------------------
          expect(
            await hoverPhrase(app, CLOSE_BUTTON),
            "one card in the pane, so the phrase is singular",
          ).toBe("Close this card");
          expect(await chipText(app, CLOSE_BUTTON), "with ⌘W beside it").toBe("⌘W");

          // --- The row's spine, right to left. ----------------------------
          // Bullseye, card width, Move to Workspace, Reveal in Finder — the
          // verbs more than one kind of card offers, at the end that holds
          // still. Only the leftmost positions belong to what a particular
          // card adds, which here is Card Settings.
          //
          // Move to Workspace is authored in the spine rather than published
          // through the items store, because a card of ANY kind moves and the
          // verb is therefore the pane's; it sits before card width so
          // bullseye and width keep the two spots already learned.
          //
          // The failure this catches is the one it was written for: a Text
          // card published Reveal then Settings and the Session masthead
          // portalled Reveal then its summary, so the same act sat at a
          // different offset on each kind and the hand had to learn two rows.
          // Ordering is enforced now — `SHARED_VERB_RANK` for the items store,
          // by hand in the masthead for its portal — and this is the assertion
          // that the two agree.
          expect(
            await app.evalJS<string[]>(
              `Array.from(
                 document.querySelectorAll(
                   ${JSON.stringify(PANE)} + " .tug-pane-title-bar-rollup-row .tug-button"
                 )
               ).map(function (el) { return el.getAttribute("aria-label"); })`,
            ),
            "the card's own verb leads, then the shared spine",
          ).toEqual([
            "Card Settings…",
            "Reveal in Finder",
            "Move to workspace",
            "Card width",
            "Bullseye",
          ]);

          // --- The chips are READ, not authored. --------------------------
          // Rebind bullseye through the defaults path — the same route any
          // other process takes — and the bubble says the new chord on its
          // next hover. No reload: the override store notifies the registry
          // and `TugActionTooltip` is subscribed to it.
          await writeOverride(app, "toggle-bullseye", [
            {
              chord: { key: "KeyB", meta: true, alt: true },
              scope: { kind: "global" },
            },
          ]);
          expect(
            await hoverPhrase(app, BULLSEYE),
            "the phrase is untouched by a rebind",
          ).toBe("Center this card in bullseye");
          expect(
            await waitForChip(app, BULLSEYE, "⌥⌘B"),
            "but the chip followed the override, with nothing reloaded",
          ).toBe("⌥⌘B");

          // Put it back, so the chord this instance leaves behind is the one
          // that ships — and so the restore path is exercised too.
          await resetOverride(app, "toggle-bullseye");
          expect(await waitForChip(app, BULLSEYE, "⌃⌘B"), "reset restores the default").toBe(
            "⌃⌘B",
          );

        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the phrase turns with the state, and the hover wrapper leaves the control working",
      async () => {
        const app = await launchTugApp({ testName: "at0404-title-bar-tooltips-state" });
        try {
          await app.seedDeckState({
            state: deckShape(),
            cardStates: {
              A: { content: { path: mkFixture(), anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
            },
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('.tug-pane[data-pane-id]').length === 2`,
            { timeoutMs: 5000 },
          );
          await wait(AFTER_LAND_MS);

          // The width control and the target both rest inside the pane's
          // rollup. The hovers below are dispatched straight at the anchors
          // and reach them either way, but the PRESSES are native and would
          // land on the bar behind a hidden row — so pin it open once here.
          await app.revealPaneControls(PANE);

          // --- The span is inert: the menu it wraps still opens. ----------
          // Pressing through a hovered wrapper is the whole risk of this
          // composition, so the press happens right after the hover.
          await hoverPhrase(app, WIDTH_BUTTON);
          await app.nativeClickAtElement(WIDTH_BUTTON);
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(WIDTH_MENU)}).length > 0`,
            { timeoutMs: 5000 },
          );

          // Choose a preset: the pane takes a width, and the tooltip has a
          // fact to report that it did not have a moment ago.
          const chose = await app.evalJS<boolean>(
            `(function () {
              var row = Array.from(
                document.querySelectorAll(${JSON.stringify(WIDTH_MENU)} + " [role='menuitemradio']"),
              ).find(function (el) { return el.getAttribute("data-item-id") === "comfy"; });
              if (!row) return false;
              row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
              row.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
              row.click();
              return true;
            })()`,
          );
          expect(chose, "the width menu offered its Comfy row").toBe(true);
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(WIDTH_MENU)}).length === 0`,
            { timeoutMs: 8000 },
          );
          await wait(AFTER_LAND_MS);

          expect(
            await hoverPhrase(app, WIDTH_BUTTON),
            "the closed control cannot show its width, so the bubble does",
          ).toBe("Set this card's width — now Comfy");

          // --- Bullseye's phrase turns with the posture. ------------------
          await app.nativeClickAtElement(BULLSEYE);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(BULLSEYE)}).getAttribute("aria-pressed") === "true"`,
            { timeoutMs: 8000 },
          );
          await wait(AFTER_LAND_MS);
          expect(
            await hoverPhrase(app, BULLSEYE),
            "in bullseye, the same button offers the way out",
          ).toBe("Take this card out of bullseye");

        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
