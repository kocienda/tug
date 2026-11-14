/**
 * vd-short-dialogs.test.ts — a YouTube Short on the keyboard in a dialog: the
 * double ring that marks the default button, Return choosing it, the arrow
 * keys moving the ring, and Escape and ⌘. dismissing.
 *
 * A video tool, not a test of the app: it stages a scene and records it. It
 * lives beside the other video drivers and shares the site clips' helpers and
 * gate: run by path with `TUG_SITE_CLIPS_OUT` and `TUG_SITE_CLIPS_MODE` set;
 * with either unset it skips. The `vids` repo's `tools/shot.py short-dialogs`
 * is the usual caller, and its `tools/short.py` composes the portrait frame.
 *
 * The dialogs are the Component Gallery's alert demos, raised by a click on
 * the demo's own button, so every one is the real `TugAlert`: app-modal,
 * centred in the window, 460 px wide. At View › Zoom 1 that is 920 captured
 * pixels, which is the width of a 1080 px frame less a margin, so the
 * composer has no camera to run: it crops a frame-sized window around the
 * dialog (`shot.json` says where the dialog stood).
 *
 * The frame is dressed for a Short, by elements this driver adds to the page
 * and which are no part of the app (`DRESSING_SCRIPT`): the deck's canvas and
 * grid, in the theme's own tokens, over the gallery's labels, so a dialog and
 * its scrim stand on the canvas; a title bar at the frame's top, larger than
 * life, with the app's icon and name; and a row of key caps under the dialog,
 * filled and quiet at rest, each lit (a highlight, with no press drawn) from
 * a moment before its key is pressed, because a key press is not a thing a
 * viewer can see. A dialog is never off screen for longer than
 * `REOPEN_MS`: the next one opens as soon as the last is answered.
 *
 * The times are seconds of the narration (`BEATS`, `END`). Until there is a
 * recording they are a draft read's; `incoming/short-dialogs.wav` in the
 * `vids` repo re-times them from its word timestamps (`build/transcribe`).
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { App, NativeModifier } from "../_harness";
import { pollFor } from "../body-grounding/_frames";
import { stubDirectory } from "../streaming-stub-fixture";
import { MODE, RUNS, contentSize, expectRecorded, launchForMode, outDirFor, scene, standIns } from "../site-clips/_site-clips";

const TEST_TIMEOUT_MS = 300_000;
const SHOT = "short-dialogs";
const CARD = "vd-short-dlg";

/** The card in CSS pixels: wider and taller than the frame's 540 × 960, so the crop never meets an edge. */
const CARD_CSS = { width: 680, height: 1040 };
const MARGIN_CSS = 10;
const CONTENT_SIZE = { width: CARD_CSS.width + 2 * MARGIN_CSS, height: CARD_CSS.height + 2 * MARGIN_CSS };

/** The Short's frame in CSS pixels (1080 × 1920 at the 2× backing store), and where the dialog's middle sits in it. */
const FRAME_CSS = { width: 540, height: 960 };
const DIALOG_CY_CSS = 470;
/** The title bar's height, and the gap from the dialog's foot to the key row. */
const TITLE_BAR_CSS = 92;
const KEY_ROW_GAP_CSS = 56;
/**
 * A cap lights this long before its key is pressed, so the eye is on it when the dialog answers, and longer for a
 * key that dismisses the dialog (Return, Escape, ⌘.): its result is the dialog leaving, which takes the eye with it.
 * A cap stays lit `KEYCAP_AFTER_MS` past its key, but is always dark `KEYCAP_GAP_MS` before the next key's cap lights:
 * two caps lit at once read as two keys pressed at once.
 */
const KEYCAP_LEAD_MS = 250;
const KEYCAP_DISMISS_LEAD_MS = 550;
const KEYCAP_AFTER_MS = 400;
const KEYCAP_GAP_MS = 80;
/** From a dialog's answer to the next one's opening. */
const REOPEN_MS = 350;
/** The app's icon, in the checkout. */
const ICON = join(import.meta.dir, "..", "..", "..", "tugapp", "Assets.xcassets", "AppIcon.appiconset", "AppIcon-1024b.png");

const ALERT = ".tug-alert-content";

/** The gallery's demo buttons, by their label. */
type Demo = "Send Feedback" | "Delete Card" | "Discard Changes" | "Open Files";

type Beat =
  | { at: number; open: Demo }
  | { at: number; key: string; mods?: NativeModifier[]; caps: string[]; next?: Demo };

/** The scene: what happens at each second of narration. */
const BEATS: readonly Beat[] = [
  // Timed to shots/short-dialogs-mixdown.wav in the vids repo (27.0 s; speech from 0.0 s to 26.7 s).
  // "Here's a detail I loved putting into Tug: the classic macOS double ring on buttons." The composer covers the
  // opening with its classic frame and fades to this dialog under "double ring".
  { at: 0.1, open: "Open Files" },
  // "It marks the default: the button I get if I just hit Return." (5.9–9.3) The composer pushes in on the buttons
  // and back; Return lands on the word.
  { at: 8.75, key: "Return", caps: ["return"], next: "Delete Card" },
  // "And in Tug, I can move the double ring with the arrow keys." (9.9–13.1) There and back, and Return only once
  // the arrow's cap has gone dark: a hand presses one key at a time.
  { at: 11.0, key: "ArrowRight", caps: ["right"] },
  { at: 11.8, key: "ArrowLeft", caps: ["left"] },
  { at: 13.0, key: "Return", caps: ["return"], next: "Discard Changes" },
  // "Escape dismisses a dialog, of course," (13.6–16.2)
  { at: 14.8, key: "Escape", caps: ["esc"], next: "Send Feedback" },
  // "and so does Command-period, in typical Mac style." (16.2–19.3)
  { at: 17.3, key: ".", mods: ["cmd"], caps: ["cmd", "period"], next: "Open Files" },
  // "Tug is all about this: bringing pleasant nuances and details to the AI coding experience." (19.8–26.7) The ring
  // keeps moving under the line, so the last dialog is never a still.
  { at: 20.4, key: "ArrowLeft", caps: ["left"] },
  { at: 22.0, key: "ArrowRight", caps: ["right"] },
  { at: 23.6, key: "ArrowLeft", caps: ["left"] },
  { at: 25.2, key: "ArrowRight", caps: ["right"] },
];
const END = 26.9;

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: CARD, componentId: "gallery-alert", title: "Alert", closable: true }],
    panes: [
      {
        id: `${CARD}-pane`,
        position: { x: MARGIN_CSS, y: MARGIN_CSS },
        size: CARD_CSS,
        cardIds: [CARD],
        activeCardId: CARD,
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: `${CARD}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** The key row, left to right: a cap's id (what a beat names) and its legend. */
const KEY_ROW: readonly (readonly [string, string])[] = [["esc", "esc"], ["cmd", "⌘"], ["period", "."], ["left", "←"], ["right", "→"], ["return", "return"]];

/**
 * The Short's dressing, added to the page the alert is in: the canvas and its grid under the dialog's layer, and
 * above everything a title bar across the frame's top and the key row at `capY`. `window.__vdKey(ids)` lights caps.
 * The canvas is painted as the deck paints it, a line every 24 px both ways. No `//` comment inside: the script is
 * evaluated as one expression. The alert's scrim is made clear (its own token, set on the body): in a frame this
 * close the whole picture dimming and lifting with each dialog pulls the eye off the buttons.
 */
function dressingScript(frame: { x: number; y: number; width: number; height: number }, capY: number): string {
  return `(function () {
  var CANVAS = "var(--tug7-surface-global-primary-normal-canvas-rest)";
  var GRID = "var(--tug7-surface-global-primary-normal-grid-rest)";
  var TOP = 2147483647;
  document.body.style.setProperty("--tugx-alert-overlay-bg", "transparent");
  var ink = getComputedStyle(document.body).color;
  function add(css, parent) {
    var el = document.createElement("div");
    el.style.cssText = css;
    (parent || document.body).appendChild(el);
    return el;
  }
  add("position:fixed;inset:0;pointer-events:none;z-index:1;background-color:" + CANVAS + ";background-image:" +
    "repeating-linear-gradient(" + GRID + " 0 1px,transparent 1px 24px),repeating-linear-gradient(90deg," + GRID + " 0 1px,transparent 1px 24px);");
  var bar = add("position:fixed;left:${frame.x}px;top:${frame.y}px;width:${frame.width}px;height:${TITLE_BAR_CSS}px;box-sizing:border-box;pointer-events:none;z-index:" + TOP + ";" +
    "display:flex;align-items:center;justify-content:center;gap:14px;" +
    "background:color-mix(in srgb," + CANVAS + " 86%,white);border-bottom:1px solid color-mix(in srgb," + ink + " 22%,transparent);");
  var lights = add("position:absolute;left:24px;top:0;bottom:0;display:flex;align-items:center;gap:11px;", bar);
  ["#ff5f57", "#febc2e", "#28c840"].forEach(function (c) { add("width:17px;height:17px;border-radius:50%;background:" + c + ";", lights); });
  var img = document.createElement("img");
  img.src = window.__vdIcon;
  img.style.cssText = "width:58px;height:58px;";
  bar.appendChild(img);
  add("font:600 30px/1 -apple-system,system-ui,sans-serif;letter-spacing:0.01em;color:" + ink + ";", bar).textContent = "Tug";
  var row = add("position:fixed;left:${frame.x}px;width:${frame.width}px;top:${capY}px;display:flex;justify-content:center;gap:10px;pointer-events:none;z-index:" + TOP + ";");
  var REST = "color:color-mix(in srgb," + ink + " 70%," + CANVAS + ");border-color:color-mix(in srgb," + CANVAS + " 62%," + ink + ");background:color-mix(in srgb," + CANVAS + " 82%," + ink + ");";
  var LIT = "color:" + CANVAS + ";border-color:" + ink + ";background:" + ink + ";";
  var BASE = "min-width:22px;height:50px;padding:0 15px;display:flex;align-items:center;justify-content:center;box-sizing:content-box;" +
    "font:600 21px/1 -apple-system,system-ui,sans-serif;border:1.5px solid;border-bottom-width:4px;border-radius:10px;";
  var caps = {};
  var timers = {};
  ${JSON.stringify(KEY_ROW)}.forEach(function (k) {
    caps[k[0]] = add(BASE + REST, row);
    caps[k[0]].textContent = k[1];
  });
  window.__vdKey = function (ids, hold) {
    ids.forEach(function (id) {
      caps[id].style.cssText = BASE + LIT;
      clearTimeout(timers[id]);
      timers[id] = setTimeout(function () { caps[id].style.cssText = BASE + REST; }, hold);
    });
  };
})()`;
}

interface Page {
  evalJS<T>(script: string): Promise<T>;
}

describe.skipIf(!RUNS)("video shot: the dialog-keyboard Short", () => {
  test(
    "records dialogs answered from the keyboard: Return, the arrow keys, Escape and ⌘.",
    async () => {
      const app: App = await launchForMode("vd-short-dialogs", deck(), stubDirectory(), { contentSize: CONTENT_SIZE });
      try {
        const body = app.body(CARD);
        await pollFor(
          () => body.evalJS<boolean>(`document.querySelector('[data-testid="gallery-alert"]') !== null`).catch(() => false),
          (ready) => ready,
          30_000,
        );
        // Name each demo's button so a click can aim at it.
        await body.evalJS<void>(`(function () {
          document.querySelectorAll('[data-testid="gallery-alert"] button').forEach(function (b) {
            b.setAttribute("data-vd-demo", b.textContent.trim());
          });
        })()`);
        // The gallery is taller than the card: a button below the fold is brought into view before the click.
        const open = async (demo: Demo) => {
          const button = `[data-vd-demo=${JSON.stringify(demo)}]`;
          await body.evalJS<void>(`document.querySelector(${JSON.stringify(button)}).scrollIntoView({ block: "nearest" })`);
          await body.nativeClickAtElement(button);
        };
        const alertIn = (page: Page) =>
          page
            .evalJS<{ x: number; y: number; width: number; height: number } | null>(
              `(function () { var el = document.querySelector(${JSON.stringify(ALERT)}); if (!el) return null; var r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
            )
            .catch(() => null);

        // A rehearsal, off the record: raise one alert to learn which page it is in and where it rests, then dismiss it.
        await open("Open Files");
        let page: Page = app;
        let where = "shell";
        const rect = await pollFor(
          async () => {
            const inShell = await alertIn(app);
            if (inShell !== null) return inShell;
            const inBody = await alertIn(body);
            if (inBody !== null) {
              page = body;
              where = "body";
            }
            return inBody;
          },
          (r) => r !== null,
          10_000,
        );
        await Bun.sleep(600);
        const settled = (await alertIn(page)) ?? rect!;
        const dialog = where === "body" ? await app.elementRect(CARD, ALERT) : settled;
        // The dialog's own words and where its icon stands in it (from the dialog's corner), for the composer: its classic opening frame says the same
        // thing under the same mark, so the cross-fade changes the dialog's clothes and nothing else.
        const text = await page.evalJS<{ title: string; message: string; icon: { x: number; y: number; width: number; height: number } | null }>(
          `(function () {
            var root = document.querySelector(${JSON.stringify(ALERT)});
            var say = function (sel) { var el = root.querySelector(sel); return el ? el.textContent.replace(/\\s+/g, " ").trim() : ""; };
            var svg = root.querySelector(".tug-alert-icon svg") || root.querySelector(".tug-alert-icon");
            var o = root.getBoundingClientRect();
            var r = svg ? svg.getBoundingClientRect() : null;
            return { title: say(".tug-alert-title"), message: say(".tug-alert-message"), icon: r ? { x: r.x - o.x, y: r.y - o.y, width: r.width, height: r.height } : null };
          })()`,
        );
        // The dialog's buttons, for the composer: its classic opening frame puts a button where each of these is, and its push-in aims at them.
        const buttons = await page.evalJS<{ label: string; x: number; y: number; width: number; height: number }[]>(
          `Array.from(document.querySelectorAll(${JSON.stringify(`${ALERT} button`)})).map(function (b) { var r = b.getBoundingClientRect(); return { label: b.textContent.trim(), x: r.x, y: r.y, width: r.width, height: r.height }; })`,
        );
        await app.nativeKey("Escape");
        await pollFor(() => alertIn(page), (r) => r === null, 10_000);
        const frame = {
          x: Math.round(settled.x + settled.width / 2 - FRAME_CSS.width / 2),
          y: Math.round(settled.y + settled.height / 2 - DIALOG_CY_CSS),
          ...FRAME_CSS,
        };
        expect(frame.x >= 0 && frame.y >= 0, "the frame starts inside the window").toBe(true);
        const capY = Math.round(settled.y + settled.height + KEY_ROW_GAP_CSS);
        const small = join(outDirFor(SHOT), "icon.png");
        Bun.spawnSync(["sips", "-Z", "128", ICON, "--out", small]);
        // The icon goes to the page a piece at a time: one call carrying all of it is never answered.
        const icon = `data:image/png;base64,${readFileSync(small).toString("base64")}`;
        await page.evalJS<void>(`window.__vdIcon = ""`);
        for (let i = 0; i < icon.length; i += 2000) await page.evalJS<void>(`window.__vdIcon += ${JSON.stringify(icon.slice(i, i + 2000))}`);
        await page.evalJS<void>(dressingScript(frame, capY));
        await Bun.sleep(800);

        const card = (await standIns(app))[CARD];
        expect(card, "the card has a stand-in").toBeDefined();
        const window = await contentSize(app);

        const s = scene().mark("loop-start", 0);
        const leadOf = (beat: Beat) => ("open" in beat ? 0 : beat.next !== undefined ? KEYCAP_DISMISS_LEAD_MS : KEYCAP_LEAD_MS);
        const keys = BEATS.filter((beat) => !("open" in beat));
        for (const beat of BEATS) {
          const t = Math.round(beat.at * 1000);
          if ("open" in beat) {
            s.at(t, () => open(beat.open));
            continue;
          }
          const lead = leadOf(beat);
          // Dark before the next key's cap lights.
          const following = keys[keys.indexOf(beat) + 1];
          const room = following === undefined ? Infinity : Math.round(following.at * 1000) - leadOf(following) - KEYCAP_GAP_MS - (t - lead);
          const hold = Math.min(lead + KEYCAP_AFTER_MS, room);
          expect(hold > lead, `the ${beat.caps.join("+")} cap at ${beat.at} s is still lit when its key is pressed`).toBe(true);
          s.at(t - lead, () => page.evalJS<void>(`window.__vdKey(${JSON.stringify(beat.caps)}, ${hold})`));
          s.at(t, () => app.nativeKey(beat.key, beat.mods ?? []));
          // A key that answers a dialog is followed at once by the next dialog: the frame never stands empty.
          if (beat.next !== undefined) s.at(t + REOPEN_MS, () => open(beat.next!));
        }
        s.mark("loop-end", Math.round(END * 1000));
        const reading = await s.record(app, { outDir: outDirFor(SHOT), settleMs: 300 });

        const results = await body.evalJS<string[]>(
          `Array.from(document.querySelectorAll('[data-testid="gallery-alert"] .cg-section')).map(function (el) { return el.textContent.replace(/\\s+/g, " ").trim().slice(-40); })`,
        );
        writeFileSync(
          join(outDirFor(SHOT), "shot.json"),
          JSON.stringify(
            { shot: SHOT, mode: MODE, pageZoom: 1, contentSize: window, card, dialog, text, buttons, frame, crop: reading.crop, marks: reading.marks, frames: reading.frames, scale: reading.scale, notes: { alertPage: where, inPage: settled, capY, results, beats: BEATS } },
            null,
            2,
          ),
        );
        expectRecorded(reading);
        expect(await alertIn(page), "the last dialog is still up at the end").not.toBeNull();
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
