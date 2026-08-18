/**
 * at0376-session-atom-clipboard.test.ts — the session reference is a real Tug
 * atom, on the real pasteboard.
 *
 * ## What this gates
 *
 * `session-atom.test.ts` covers the payload builder — the sidecar's shape, the
 * two flat-text forms, the wire marker's round-trip. What it cannot cover is
 * whether any of that reaches the system pasteboard, and whether what lands
 * there is what a paste would turn back into a CHIP rather than a string. Both
 * need the real app and the real NSPasteboard.
 *
 *   A. **The `text/plain` flavor is the citation.** Seed a sentinel, copy the
 *      atom, read the pasteboard back. What lands is what would paste into any
 *      app outside Tug, and it has to be the resolvable form — a bare callsign
 *      pasted elsewhere is a name, not a reference.
 *
 *   B. **The atom sidecar rode along, typed `session`.** Read back off the
 *      SAME pasteboard through the two functions the editor's paste handler
 *      calls — `readClipboardViaNative` for the private
 *      `dev.tug.prompt-atoms` type, then `parseClipboardSidecar` to validate
 *      it. That is the entire Tug-to-Tug chain: JS write → NSPasteboard → JS
 *      read → the production validator. What comes back is exactly what a
 *      paste would insert, and its being typed `session` is what makes it
 *      re-materialize as a session chip with no session-specific code on the
 *      paste side.
 *
 *   C. **The masthead's TITLE offers the same copy.** A third way in, and it has
 *      to be the same one: the atom should be reachable without opening
 *      anything. Both paths run `writeSessionAtomToClipboard` through
 *      `useCopyableText`, so what C pins is that the title CLAIMS the
 *      right-click — a title that silently ignored it would leave the telemetry
 *      popover as the only door.
 *
 *   D. **A DOM paste re-materializes the chip.** The copy is written natively,
 *      to the private pasteboard type, exactly because WebKit swallows custom
 *      MIME types — so a DOM `paste` event's `clipboardData` cannot see it, and
 *      the paste fell through to plain text: the atom landing in the composer
 *      as its citation string. The event here is dispatched with an EMPTY
 *      `clipboardData`, which is the shape of the real hazard — everything the
 *      paste needs is on the pasteboard and none of it is in the event.
 *
 *   E. **And what lands wears the session face.** The pasted chip is a Canvas
 *      bake inside an `<img>` and stays one ([P14]), so its face is pinned in
 *      pixels: no ground where the shared atom family paints an opaque surface,
 *      and a filled dot where the family strokes a glyph (Spec S05).
 *
 * `pbpaste` cannot see a private pasteboard type, which is why B goes through
 * the app rather than the shell. The KEYSTROKE half is still not driven here:
 * ⌘V does not reach the web layer in this harness at all. D covers the branch
 * that keystroke lands in, which is the part that was broken.
 *
 * Foreground: the copy and the pasteboard reads want a key window.
 *
 * @foreground
 *
 * @covers tugdeck/src/lib/session-atom.ts
 * @covers tugdeck/src/lib/session-atom-shape.ts
 * @covers tugdeck/src/lib/command-atom.ts
 * @covers tugdeck/src/lib/tug-atom-img.ts
 * @covers tugdeck/src/components/tugways/use-copyable-text.tsx
 * @covers tugdeck/src/components/tugways/session-masthead.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor/clipboard-filters.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SESSION_ID = "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const TAG = "stocky-pixie";
const CITATION = "tugtool/stocky-pixie (f6e43925)";
const SENTINEL = "at0376-sentinel-nothing-copied";

const SPIKE_CARD = '[data-card-id="G"]';
const CHIP = `${SPIKE_CARD} [data-slot="tug-session-identity"][data-tier="chip"]`;
const MENU = '[data-slot="tug-editor-context-menu"]';
const COMPOSER = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';
/** The bound Session card's masthead title — the third way into the atom copy. */
const MASTHEAD_TITLE =
  '.tug-pane[data-pane-id="p1"] [data-slot="session-masthead"] .session-masthead-title';

function setPasteboard(text: string): void {
  Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(text) });
}

function readPasteboard(): string {
  return Bun.spawnSync(["pbpaste"]).stdout.toString();
}

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
      {
        id: "G",
        componentId: "spike-session-identity",
        title: "Session Identity",
        closable: true,
      },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 20, y: 20 },
        size: { width: 700, height: 420 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
      },
      {
        id: "p2",
        position: { x: 20, y: 470 },
        size: { width: 700, height: 420 },
        cardIds: ["G"],
        activeCardId: "G",
        title: "",
        acceptsFamilies: ["spike"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

describe.skipIf(!SHOULD_RUN)("at0376 — the session atom on the clipboard", () => {
  test(
    "copy writes the citation, and the atom sidecar rides the same pasteboard",
    async () => {
      const app = await launchTugApp({
        testName: "at0376-session-atom-clipboard",
        foreground: true,
      });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.bindSession("A", {
          tugSessionId: SESSION_ID,
          projectDir: "/Users/tester/src/tugtool",
        });
        await app.evalJS<boolean>(
          `window.__tug.publishSessionUpdated(${JSON.stringify(
            JSON.stringify({
              session_id: SESSION_ID,
              fields: { tag: TAG, name: null, name_user_set: false },
            }),
          )})`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHIP)}) !== null
             && document.querySelector(${JSON.stringify(COMPOSER)}) !== null`,
          { timeoutMs: 20_000 },
        );

        // Right-click on the chip offers the session's menu — the affordance
        // every Tug chip has, and the reason the hover surface is a tooltip
        // rather than a placard. Assert the menu exists with an enabled
        // `Copy as Atom`, which is the item this file's write is behind; the
        // rest of the menu (the go-to verb, the citation, the id) is
        // `useSessionIdentityMenu`'s and is pinned by at0387.
        await app.evalJS<null>(`(function(){
          var chip = document.querySelector(${JSON.stringify(CHIP)});
          var r = chip.getBoundingClientRect();
          chip.dispatchEvent(new MouseEvent("contextmenu", {
            bubbles: true,
            clientX: Math.round(r.left + r.width / 2),
            clientY: Math.round(r.top + r.height / 2),
          }));
          return null;
        })()`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MENU)}) !== null`,
          { timeoutMs: 8_000 },
        );
        const copyItem = await app.evalJS<{ label: string; disabled: string }>(
          `(function(){
            var item = document.querySelector(
              ${JSON.stringify(MENU)} + ' [data-item-action="copy-session-atom"]');
            if (item === null) throw new Error("the chip's menu has no atom copy");
            return {
              label: item.textContent || "",
              disabled: item.getAttribute("aria-disabled") || "",
            };
          })()`,
        );
        expect(copyItem.label).toContain("Copy as Atom");
        expect(copyItem.disabled).not.toBe("true");
        await app.nativeKey("Escape");

        // ---- A. Copy the atom; the plain-text flavor is the citation. ------
        //
        // The WRITE is what this gates, so it is driven at the production
        // writer rather than through the menu: `writeSessionAtomToClipboard`
        // is the exact function the menu's Copy handler calls, and it is the
        // only code here that this phase wrote. The sentinel makes "the copy
        // never happened" distinguishable from "the copy wrote this".
        setPasteboard(SENTINEL);
        expect(
          await app.evalJS<boolean>(
            `window.__tug.copySessionAtom(${JSON.stringify(SESSION_ID)})`,
          ),
        ).toBe(true);

        const deadline = Date.now() + 5000;
        let seen = readPasteboard();
        while (seen === SENTINEL && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
          seen = readPasteboard();
        }
        // The copy happened at all…
        expect(seen).not.toBe(SENTINEL);
        // …and what it wrote is the citation, resolvable outside Tug.
        expect(seen.trim()).toBe(CITATION);

        // ---- B. The sidecar rode along, and it is a session atom. ----------
        //
        // Read back off the SAME pasteboard through the two functions the
        // editor's paste handler calls — `readClipboardViaNative` (the private
        // `dev.tug.prompt-atoms` type) and `parseClipboardSidecar`. That is the
        // whole Tug-to-Tug chain: JS write → NSPasteboard → JS read → the
        // production validator. What comes back is what a paste would insert.
        // The read is async (the native bridge calls back), and `evalJS`
        // cannot return a promise — so kick it off, park the result, and poll.
        await app.evalJS<null>(
          `(window.__at0376sidecar = undefined,
            window.__tug.readClipboardAtoms().then(function (r) {
              window.__at0376sidecar = JSON.stringify(r);
            }),
            null)`,
        );
        await app.waitForCondition<boolean>(
          `window.__at0376sidecar !== undefined`,
          { timeoutMs: 8_000 },
        );
        const sidecar = JSON.parse(
          await app.evalJS<string>(`window.__at0376sidecar`),
        ) as {
          text: string;
          atoms: Array<{ type: string; label: string; value: string }>;
        } | null;
        expect(sidecar).not.toBeNull();
        // One atom, at the object-replacement char that is its position.
        expect(sidecar?.text).toBe("￼");
        expect(sidecar?.atoms.length).toBe(1);
        // Typed `session` — which is what makes it re-materialize as a session
        // chip rather than a file one, with no session-specific code on the
        // paste side.
        expect(sidecar?.atoms[0].type).toBe("session");
        // The chip carries the callsign run, not the citation — the atom's
        // label is what the reader sees, and the citation is its flat form.
        expect(sidecar?.atoms[0].label).toBe(`tugtool/${TAG}`);
        expect(sidecar?.atoms[0].value).toBe(`tugtool/${TAG}`);

        // ---- C. The masthead's TITLE offers the same copy. -----------------
        //
        // A third way in, and it has to be the same one: the atom should be
        // reachable without opening anything, and right-click is the idiom every
        // other Tug chip already uses ([D132]). Both paths run
        // `writeSessionAtomToClipboard` through `useCopyableText`, so what this
        // pins is that the masthead's title CLAIMS the gesture — a title that
        // silently ignored a right-click would leave the popover as the only
        // door, which is the thing this decision exists to fix.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MASTHEAD_TITLE)}) !== null`,
          { timeoutMs: 10_000 },
        );
        await app.evalJS<null>(`(function(){
          var title = document.querySelector(${JSON.stringify(MASTHEAD_TITLE)});
          var r = title.getBoundingClientRect();
          title.dispatchEvent(new MouseEvent("contextmenu", {
            bubbles: true,
            clientX: Math.round(r.left + r.width / 2),
            clientY: Math.round(r.top + r.height / 2),
          }));
          return null;
        })()`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MENU)}) !== null`,
          { timeoutMs: 8_000 },
        );
        // Every open menu's rows, not just the first — and that is a finding, not
        // a convenience. `useCopyableText`'s handler calls `preventDefault` but
        // not `stopPropagation`, so a right-click on the masthead title raises the
        // title's own single-Copy menu AND the surrounding surface's read-only
        // one. The claim here is the one [D132] makes — the title offers a live
        // Copy — and the diagnostic below records the overlap for the follow-on.
        const titleMenus = await app.evalJS<
          ReadonlyArray<ReadonlyArray<{ label: string; disabled: boolean }>>
        >(
          `Array.prototype.map.call(
             document.querySelectorAll(${JSON.stringify(MENU)}),
             function (menu) {
               return Array.prototype.map.call(
                 menu.querySelectorAll('[role="menuitem"]'),
                 function (item) {
                   return {
                     label: item.textContent || "",
                     disabled: item.getAttribute("aria-disabled") === "true",
                   };
                 });
             })`,
        );
        note("at0376 title menus", JSON.stringify(titleMenus));
        const liveCopy = titleMenus
          .flat()
          .some((item) => item.label.includes("Copy") && !item.disabled);
        expect(liveCopy).toBe(true);
        await app.nativeKey("Escape");

        // ---- D. And a DOM paste re-materializes the chip. ------------------
        //
        // The copy is written NATIVELY, to the Tug-private
        // `dev.tug.prompt-atoms` pasteboard type, precisely because WebKit's
        // pasteboard normalization swallows custom MIME types. The consequence
        // is that a DOM `paste` event's `clipboardData` cannot see it: the
        // handler's `getData(TUG_ATOMS_MIME)` branch comes back empty for a
        // clipboard that demonstrably carries an atom (A and B above just put
        // one there), and the paste used to fall through to plain text — the
        // atom arriving in the composer as its citation string.
        //
        // The event is dispatched with an EMPTY clipboardData, which is exactly
        // the shape of the real hazard: everything the paste needs is on the
        // pasteboard and none of it is in the event.
        await app.focusElement(COMPOSER);
        const before = await app.evalJS<number>(
          `document.querySelectorAll(${JSON.stringify(COMPOSER)} + ' img:not(.cm-widgetBuffer)').length`,
        );
        await app.evalJS<null>(`(function(){
          var cm = document.querySelector(${JSON.stringify(COMPOSER)});
          cm.dispatchEvent(new ClipboardEvent("paste", {
            bubbles: true, cancelable: true, clipboardData: new DataTransfer(),
          }));
          return null;
        })()`);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(COMPOSER)} + ' img:not(.cm-widgetBuffer)').length > ${before}`,
          { timeoutMs: 8_000 },
        );
        const pasted = await app.evalJS<{ atoms: number; text: string }>(
          `(function(){
            var cm = document.querySelector(${JSON.stringify(COMPOSER)});
            return {
              atoms: cm.querySelectorAll('img:not(.cm-widgetBuffer)').length,
              text: Array.from(cm.querySelectorAll('.cm-line'))
                .map(function(l){ return l.textContent || ""; }).join("").slice(0, 60),
            };
          })()`,
        );
        note("at0376 pasted composer", `${before} → ${JSON.stringify(pasted)}`);
        // Exactly one MORE chip than the composer already held.
        expect(pasted.atoms).toBe(before + 1);
        // The chip is the whole paste — not the citation typed out beside it.
        expect(pasted.text).not.toContain(TAG);

        // ---- E. And what landed wears the SESSION face. -------------------
        //
        // The composer's atom is a Canvas bake inside an `<img>` and stays one
        // ([P14]), so the only witness to its face is its pixels. Two samples
        // separate the session pill from the shared atom family:
        //
        //   - the right padding column, inside the chip and clear of the label:
        //     the family fills its box with an opaque surface + Key wash, the
        //     session atom paints no ground at all (Spec S05).
        //   - the leading mark's center: the family strokes a glyph there, the
        //     session atom fills a dot.
        //
        // Sampled in the bitmap's own device pixels; the bake is at 2× the
        // screen's density, so CSS coordinates are scaled by the ratio.
        const face = await app.evalJS<{
          type: string;
          groundAlpha: number;
          markAlpha: number;
        }>(
          `(function(){
            var img = document.querySelector(
              ${JSON.stringify(COMPOSER)} + ' img[data-atom-type="session"]');
            if (img === null) throw new Error("no session atom in the composer");
            var c = document.createElement("canvas");
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            var g = c.getContext("2d");
            g.drawImage(img, 0, 0);
            var device = img.naturalWidth / img.width;
            function alphaAt(cssX, cssY) {
              return g.getImageData(
                Math.round(cssX * device), Math.round(cssY * device), 1, 1).data[3];
            }
            // The chip fills the editor's line box minus a 1px inset per edge,
            // so its font size falls out of its height; the dot sits half a
            // mark-box in from the pill's 9px padding.
            var fontSize = (img.height + 2) / 1.5;
            return {
              type: img.dataset.atomType || "",
              groundAlpha: alphaAt(img.width - 4, img.height / 2),
              markAlpha: alphaAt(9 + fontSize / 2, img.height / 2),
            };
          })()`,
        );
        note("at0376 pasted face", JSON.stringify(face));
        expect(face.type).toBe("session");
        // No ground: the pill is transparent and the dot is its only color.
        expect(face.groundAlpha).toBeLessThan(16);
        // The dot is painted, and it is solid.
        expect(face.markAlpha).toBeGreaterThan(200);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
