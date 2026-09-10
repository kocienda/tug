/**
 * at0545-field-focus-one-mark.test.ts — a text field wears exactly one focus mark.
 *
 * The Filter Cards field in the Cards sidebar card could show two strokes at
 * once: the app-owned ring offset outside it AND its own border painted in the
 * ring's own accent hue. Both are read out of computed style here, in the real
 * WKWebView, because both were cascade facts rather than logic — no assertion
 * on a store or an attribute would have caught either.
 *
 * ## What this gates (failure modes, not busywork)
 *
 *   - **A parked field wears the ring and nothing else (A):** Tab-walked onto
 *     the Cards filter field, the input's outline is the ring — same colour as
 *     the resolved `--tugx-focus-ring` — and its own border computes fully
 *     transparent. Fails if the field's quiet-bounds rule loses the cascade to
 *     `TugInput`'s hover rule again, which is what put a second closed
 *     rectangle a couple of pixels inside the ring.
 *   - **A live caret is the only mark (B):** clicking the same field grants the
 *     caret, the mode stands the ring down (outline `none`), and the border does
 *     NOT take the ring's hue. Fails if a field's own border goes back to
 *     riding `--tugx-focus-ring`, which reinstates the ring under another
 *     property name at exactly the moment the ring stood down to avoid it.
 *   - **The focus border rides the field family's own token (C):** a plain
 *     `TugInput` with a live caret paints its border in the resolved
 *     `--tug7-element-field-border-normal-plain-active` — the key-toned token
 *     its two siblings (`tug-value-input.css`, `tug-text-editor.css`) never
 *     drifted off — and not in the ring's accent. (A) and (B) ride a filter
 *     field, whose border is transparent by its own rule, so this is the one
 *     that pins what a focused field actually paints.
 *
 * Colours are compared by resolving each token through a scratch element's
 * `color` in the field's own subtree, so both sides of every comparison come
 * back in one normalized form. Reading the custom property's text and diffing
 * it against `borderTopColor` would compare `oklch(...)` against `rgb(...)` and
 * pass whatever happened.
 *
 * Both halves need the real screen, which is why this one takes it. `:focus`
 * and `:hover` are decided by WebKit against the key window and the physical
 * cursor, and in a background launch neither ever matches — a caret-holding
 * field would take no focus paint at all, and every assertion here would pass
 * against a state the product never shows.
 *
 * @foreground
 * @covers tugdeck/src/components/tugways/tug-input.css
 * @covers tugdeck/src/components/tugways/tug-filter-field.css
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARDS_CARD = ".cards-card";
const CARDS_FILTER_INPUT = `${CARDS_CARD} [data-testid="cards-filter"] input`;
const CARDS_ROW = `${CARDS_CARD} .cards-row[data-cards-row-id]`;
/** A plain `TugInput` in a maker card — no filter field's quiet bounds on it. */
const PLAIN_INPUT = '[data-card-id="A"] #demo-name';

/** Fully transparent, as `getComputedStyle` serializes it. */
const TRANSPARENT = "rgba(0, 0, 0, 0)";

/**
 * True once the caret is live in `selector`.
 *
 * Read as `document.activeElement`, never as a `:focus` selector — the engine
 * routes keys off its own sink and a `querySelector(":focus")` poll against
 * this webview does not settle the way the identity comparison does.
 */
function caretLandedOn(selector: string): string {
  return `document.activeElement === document.querySelector(${JSON.stringify(selector)})`;
}

/**
 * Click `selector` until the caret is in it.
 *
 * A foreground launch routes clicks through the windowserver by screen
 * coordinate, so a click posted while the app is still coming to the front
 * lands somewhere else and the caret never arrives. That is a race with the
 * activation, not a fact about the field — one repeat settles it, and a field
 * that genuinely cannot take a caret still fails, just after three tries.
 */
async function clickUntilCaret(
  app: {
    evalJS<T>(s: string): Promise<T>;
    nativeClickAtElement(s: string): Promise<void>;
    waitForCondition<T>(s: string, o?: { timeoutMs?: number }): Promise<T>;
  },
  selector: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await app.nativeClickAtElement(selector);
    try {
      await app.waitForCondition<boolean>(caretLandedOn(selector), {
        timeoutMs: 3_000,
      });
      return;
    } catch {
      // Fall through to the next attempt.
    }
  }
  throw new Error(
    `the caret never landed in ${selector} after three clicks — ${await app.evalJS<string>(focusReport(selector))}`,
  );
}

/**
 * Wait out the field's `border-color` transition before reading the paint.
 *
 * `.tug-input` transitions `border-color` over 80ms, and a value sampled part
 * way through comes back in the interpolation's own space — `oklab(...)` rather
 * than the token's `oklch(...)` — so an equality check against the resolved
 * token fails on the serialization even when the paint is on its way to being
 * right. Two consecutive identical reads mean the transition has landed.
 */
async function settle(
  app: { evalJS<T>(s: string): Promise<T> },
  selector: string,
): Promise<void> {
  let last = "";
  for (let i = 0; i < 20; i += 1) {
    const now = await app.evalJS<string>(
      `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).borderTopColor`,
    );
    if (now === last) return;
    last = now;
    await new Promise<void>((r) => setTimeout(r, 100));
  }
}

/**
 * A one-line picture of where the engine put the keyboard and the caret. Read
 * only when the walk fails: which of the ring, the key view and the caret is
 * missing says whether the walk never started or merely stopped short.
 */
function focusReport(selector: string): string {
  return `(function(){
    function name(el) {
      if (el === null) return "none";
      return el.tagName + "." + String(el.className) + " testid=" + (el.getAttribute("data-testid") || "-");
    }
    var field = document.querySelector(${JSON.stringify(selector)});
    var r = field === null ? null : field.getBoundingClientRect();
    return JSON.stringify({
      kbd: name(document.querySelector("[data-key-view-kbd]")),
      keyView: name(document.querySelector("[data-key-view]")),
      active: name(document.activeElement),
      kbfOnHtml: document.documentElement.hasAttribute("data-kbf"),
      fieldFocusable: field === null ? "no field" : String(field.hasAttribute("data-tug-focusable")),
      fieldRect: r === null ? null : [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      hitIsField: r === null ? null : (function(){
        var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit === field ? "yes" : name(hit);
      })()
    });
  })()`;
}

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "gallery-label", title: "Label", closable: true },
    ],
    panes: [
      {
        id: "pA",
        position: { x: 60, y: 60 },
        size: { width: 560, height: 520 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "pA",
    hasFocus: true,
  };
}

interface FieldPaint {
  parked: boolean;
  focused: boolean;
  outlineStyle: string;
  outlineWidth: number;
  outlineColor: string;
  borderColor: string;
  ring: string;
  fieldActive: string;
}

/**
 * Read one field's focus paint. Every colour — the field's own and each token
 * it is compared against — comes back through `getComputedStyle().color` on a
 * scratch span mounted beside the field, so the custom properties resolve in
 * the field's own inheritance and every value serializes the same way.
 */
function paintProbe(selector: string): string {
  return `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) throw new Error("no field at " + ${JSON.stringify(selector)});
    var host = el.parentNode;
    function resolved(name) {
      var probe = document.createElement("span");
      probe.style.position = "absolute";
      probe.style.color = "var(" + name + ")";
      host.appendChild(probe);
      var value = getComputedStyle(probe).color;
      host.removeChild(probe);
      return value;
    }
    var cs = getComputedStyle(el);
    return {
      parked: el.hasAttribute("data-key-view-kbd"),
      focused: document.activeElement === el,
      outlineStyle: cs.outlineStyle,
      outlineWidth: parseFloat(cs.outlineWidth) || 0,
      outlineColor: cs.outlineColor,
      borderColor: cs.borderTopColor,
      ring: resolved("--tugx-focus-ring"),
      fieldActive: resolved("--tug7-element-field-border-normal-plain-active")
    };
  })()`;
}

/**
 * Walk the Tab ring until `selector` holds the KEYBOARD key view; throws if it
 * never does. The check runs after every press including the last, so a walk
 * that arrived on its final one is not reported as one that never arrived. The
 * bound is a runaway guard, not a claim about the walk's length.
 *
 * `modifiers` picks the direction — `["shift"]` walks backward, which is how a
 * field the pointer just parked a caret on is re-reached BY THE KEYBOARD. That
 * distinction is the whole point of the parked state: the ring is the mark for
 * a stop the walk landed on, and only a walk can land on one.
 */
async function walkUntilParked(
  app: {
    evalJS<T>(s: string): Promise<T>;
    nativeKey(k: string, m?: readonly "shift"[]): Promise<void>;
  },
  selector: string,
  modifiers: readonly "shift"[] = [],
): Promise<void> {
  const reached = (): Promise<boolean> =>
    app.evalJS<boolean>(
      `document.querySelector(${JSON.stringify(`${selector}[data-key-view-kbd]`)}) !== null`,
    );
  for (let i = 0; i < 20; i += 1) {
    if (await reached()) return;
    await app.nativeKey("Tab", modifiers);
    await new Promise<void>((r) => setTimeout(r, 200));
  }
  if (await reached()) return;
  throw new Error(
    `Tab never reached ${selector} — ${await app.evalJS<string>(focusReport(selector))}`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0545 — a field wears one focus mark", () => {
  test(
    "a parked field wears the ring alone, a caret-holding field wears no ring, and the focus border is key-toned",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0545-field-focus-one-mark",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
          // A foreground launch, because both halves of this test are decided
          // by pseudo-classes the background launch cannot produce. WebKit
          // matches `:focus` only while the document has focus, so in a
          // non-key window a caret-holding field never takes its focus paint
          // at all — the assertion would pass against a state the product
          // never shows. `:hover` needs the physical cursor for the same
          // reason, and the cursor resting on the parked field after the click
          // is exactly the state the double ring was reported in.
          foreground: true,
        });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );
          await app.dispatchControlAction("toggle-cards");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CARDS_FILTER_INPUT)}) !== null`,
            { timeoutMs: 8_000 },
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CARDS_ROW)}) !== null`,
            { timeoutMs: 8_000 },
          );

          // (B) first, because the gesture order runs that way: a click on the
          // field is what grants the caret AND what seats the walk on it, and
          // the walk is what (A) then needs. Opening a card is not a keyboard
          // entry, so with no click there is no cursor for Tab to move.
          //
          // Caret live: the mode stands the ring down, so the field must carry
          // no stroke in the ring's hue under any property.
          await clickUntilCaret(app, CARDS_FILTER_INPUT);
          await settle(app, CARDS_FILTER_INPUT);
          const caret = await app.evalJS<FieldPaint>(
            paintProbe(CARDS_FILTER_INPUT),
          );
          expect(caret.focused).toBe(true);
          expect(caret.parked).toBe(false);
          expect(caret.outlineStyle).toBe("none");
          expect(caret.borderColor).not.toBe(caret.ring);
          // A filter field's bounds are its surface, in every state.
          expect(caret.borderColor).toBe(TRANSPARENT);

          // (A) Parked. Tab off the field and walk back onto it, which is what
          // makes the key view keyboard-reached rather than pointer-parked.
          await app.nativeKey("Tab");
          await app.waitForCondition<boolean>(
            `document.querySelector("[data-key-view-kbd]") !== null`,
            { timeoutMs: 5_000 },
          );
          await walkUntilParked(app, CARDS_FILTER_INPUT, ["shift"]);
          await settle(app, CARDS_FILTER_INPUT);
          const parked = await app.evalJS<FieldPaint>(
            paintProbe(CARDS_FILTER_INPUT),
          );
          expect(parked.parked).toBe(true);
          expect(parked.outlineWidth).toBeGreaterThan(0);
          expect(parked.outlineColor).toBe(parked.ring);
          // The one that regressed: a hover border inside the ring read as a
          // second, inner ring.
          expect(parked.borderColor).toBe(TRANSPARENT);

          // (C) What a focused field actually paints. The filter field opts out
          // of a border entirely, so the plain input is where the focus border's
          // hue is pinned.
          await app.evalJS<null>(
            `(document.querySelector(${JSON.stringify(PLAIN_INPUT)}).scrollIntoView({ block: "center" }), null)`,
          );
          await clickUntilCaret(app, PLAIN_INPUT);
          await settle(app, PLAIN_INPUT);
          const plain = await app.evalJS<FieldPaint>(paintProbe(PLAIN_INPUT));
          expect(plain.focused).toBe(true);
          expect(plain.outlineStyle).toBe("none");
          expect(plain.borderColor).toBe(plain.fieldActive);
          expect(plain.borderColor).not.toBe(plain.ring);
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(
              `\n[at0545-field-focus-one-mark] log tail:\n${tail}\n`,
            );
          }
          throw err;
        } finally {
          await app.close();
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
