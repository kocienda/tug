/**
 * at0551-session-fold-form.test.ts — what a folded Session card IS.
 *
 * ## What this gates
 *
 * The flag is the pane's ([P01]) and at0550 gates the doors that set it. This
 * file gates the FORM it produces ([B01], [P03]): a masthead tier one beat
 * line taller with the beat wrapped to two lines and the Z2 status row, whose
 * leading edge carries the card's one fold control ([B03]) — and nothing
 * else on screen.
 *
 * Four claims:
 *
 *   1. **The form.** `data-folded="true"` reaches the pane frame; the title
 *      bar stands at `MASTHEAD_FOLDED_HEIGHT`; the beat run is two lines
 *      tall and carries no `data-truncated` (the wrap is what retires the
 *      middle-truncation reading, [R04]); the transcript slot and the entry
 *      region are neither displayed nor reachable; Z2 is still on screen with
 *      its cells; and the control at Z2's leading edge has turned over to
 *      `Unfold` — the one thing the form change costs the reader,
 *      now that the verb has one seat instead of two ([B03], [B04]).
 *   2. **The composer folds, it does not unmount** ([B05], [L26]). Text typed
 *      into the editor is still in it after a fold and a show — which is
 *      the whole reason the fold is a collapse and an `inert` attribute rather
 *      than a conditional mount.
 *   3. **The beat reads in the WALL register** ([P09].3, [B08]). Folded,
 *      the beat is the only thing on screen and gets two lines with two jobs:
 *      the retained intent above, the action below, each its own run and each
 *      set to `block` so the reader meets two facts rather than one
 *      paragraph. At rest the line names what the last turn FINISHED —
 *      `Finished: <intent>. Completed at <stamp>. Ready.` — which is the
 *      question a wall of watched sessions is being asked. Open, the same
 *      feed renders one run and no intent at all, because the transcript
 *      underneath is already saying what the session is for.
 *   4. **The flag rides the saved layout.** Fold, reload, and the pane's
 *      `folded` is in the layout blob on tugbank disk — the SAVE side of
 *      [P01], driven through the real flush. The load side is a unit test's
 *      subject (`serialization.ts`'s `parseV4` rebuilds a pane field by
 *      field, so an additive field it does not read is one that does not come
 *      back) rather than this file's, because the harness re-seeds a deck
 *      after a reload instead of restoring the saved one — a restored frame
 *      here would be reading the seed back, not the disk.
 *
 * The two-line beat is seeded through `publishPulseFrame`, the same door
 * at0498 uses — no live commentator, and a beat long enough that an open card
 * would have had to cut it.
 *
 * `@covers` names the files that make the form and nothing it merely reaches
 * through. `session-card.tsx` is left out for the reason at0550's header
 * gives: it stands at the selection budget's ceiling and at0140 catches its
 * breakage sooner. What is left out with it is the `inert` write, which this
 * file asserts all the same.
 *
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugdeck/src/components/tugways/masthead-frame.css
 * @covers tugdeck/src/components/tugways/session-masthead.css
 * @covers tugdeck/src/components/tugways/cards/session-card.css
 * @covers tugdeck/src/components/tugways/cards/session-fold-control.tsx
 * @covers tugdeck/src/components/tugways/cards/session-fold-control.css
 * @covers tugdeck/src/components/tugways/session-identity-row.tsx
 * @covers tugdeck/src/components/tugways/session-identity-row.css
 * @covers tugdeck/src/components/tugways/session-masthead.tsx
 * @covers tugdeck/src/lib/pulse-line/resting-line.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankRead,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0551-session";
const PANE_ID = "p1";
const PANE = `.tug-pane[data-pane-id="${PANE_ID}"]`;
const CARD = '[data-card-id="A"]';
const TITLE_BAR = `${PANE} .tug-pane-title-bar[data-masthead="true"]`;
const BEAT = `${PANE} .session-masthead-row [data-slot="tug-pulse-activity"]`;
const VIEW_SLOT = `${CARD} .session-view-slot`;
const ENTRY_REGION = `${CARD} [data-slot="session-card-entry-region"]`;
const STATUS_BAR = `${CARD} [data-slot="session-card-status-bar"]`;
const STATUS_CELL = `${STATUS_BAR} [data-slot="tug-status-cell"]`;
const CONTROL = `${STATUS_BAR} [data-slot="session-fold-control"]`;
const CONTROL_BUTTON = `${CONTROL} button`;
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;

/**
 * `MASTHEAD_FOLDED_HEIGHT` in `tug-pane.tsx`, which must equal
 * `--tug-masthead-height` (72) + `--tugx-masthead-beat-extra-line` (16). The
 * constant is duplicated here rather than imported because an app-test drives
 * the BUILT app: importing the module would assert the source against itself
 * and say nothing about the cascade that actually produced the tier.
 */
const MASTHEAD_FOLDED_HEIGHT = 88;

/** A beat no open card could show whole — the second line's whole reason. */
const LONG_BEAT =
  "Reading the imposition allocator and its ceiling ladder, then re-running the column tests for the wall";

/** One Session card in one pane, wide enough that the row is not the subject. */
function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
    ],
    panes: [
      {
        id: PANE_ID,
        position: { x: 40, y: 40 },
        size: { width: 820, height: 620 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: PANE_ID,
    hasFocus: true,
  };
}

/** One PULSE frame body, scoped to this session, as the emitter writes it. */
function pulseFrame(text: string, beat: number, intent?: string): string {
  return JSON.stringify({
    type: "pulse",
    text,
    scopes: [SID],
    beat,
    at: Date.now(),
    ...(intent !== undefined ? { intent } : {}),
  });
}

/**
 * The retained thought the wall register puts on its own line — real
 * interstitial narration in the register the voice actually emits it in.
 */
const WALL_INTENT = "Folding the transcript and the composer on one clock";

/**
 * The activity line as the two registers render it: which register the row
 * drew, the whole line's text, and — in the wall register — each run on its
 * own with the `display` that puts it on its own line.
 */
async function readActivity(app: App): Promise<{
  register: string | null;
  runs: number;
  text: string;
  intentRun: string | null;
  intentBlock: string | null;
  beatRun: string | null;
  beatBlock: string | null;
  truncated: boolean;
}> {
  return app.evalJS(
    `(function () {
      var run = document.querySelector(${JSON.stringify(BEAT)});
      if (run === null) {
        return {
          register: null, runs: 0, text: "",
          intentRun: null, intentBlock: null,
          beatRun: null, beatBlock: null, truncated: false,
        };
      }
      var wall = run.querySelector('[data-register="wall"]');
      var intent = run.querySelector(".session-identity-activity-intent");
      var beat = run.querySelector(".session-identity-activity-beat");
      var flat = function (el) {
        return el === null ? null : (el.textContent || "").replace(/\\s+/g, " ").trim();
      };
      return {
        register: wall === null ? null : wall.getAttribute("data-register"),
        runs: run.querySelectorAll("span[class]").length,
        text: (run.textContent || "").replace(/\\s+/g, " ").trim(),
        intentRun: flat(intent),
        intentBlock: intent === null ? null : getComputedStyle(intent).display,
        beatRun: flat(beat),
        beatBlock: beat === null ? null : getComputedStyle(beat).display,
        truncated: run.hasAttribute("data-truncated"),
      };
    })()`,
  );
}

/** Bring a bound Session card up on a fresh app. */
async function openCard(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
  await app.bindSession("A", { tugSessionId: SID });
  await app.awaitEngineReady("A");
}

/** Flip the flag through the one command every door reaches ([P02]). */
async function toggleFolded(app: App, want: boolean): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("toggle-session-fold"), null)`,
  );
  await app.waitForCondition<boolean>(
    `window.__tug.getPaneRecord(${JSON.stringify(PANE_ID)}).folded === ${want}`,
    { timeoutMs: 8000 },
  );
  // And then on the fold itself. The flag arms the motion; the card writes the
  // terminal state — the view slot's `display`, both regions' `inert` — when
  // the motion ENDS ([B06]), so the record moving is not yet the form being
  // worn. `data-fold` is the card's own account of that: `"settled"` once a
  // fold has landed folded, absent once one has landed open.
  await app.waitForCondition<boolean>(
    `(function () {
       var card = document.querySelector(${JSON.stringify(CARD)} + " .session-card");
       if (card === null) return false;
       return card.getAttribute("data-fold") === ${want ? '"settled"' : "null"};
     })()`,
    { timeoutMs: 8000 },
  );
}

/** The whole form, read off the built DOM in one round trip. */
async function readForm(app: App): Promise<{
  frameFolded: string | null;
  titleBarHeight: number;
  beatHeight: number;
  beatTruncated: boolean;
  beatLines: number;
  viewSlotDisplay: string;
  viewSlotInert: boolean;
  entryDisplay: string;
  entryHeight: number;
  entryInert: boolean;
  statusBarHeight: number;
  statusCells: number;
  controlWidth: number;
  /** The control's inset from the strip's own leading edge, in px. */
  controlInset: number;
  /** The gap between the control's trailing edge and the first cell's. */
  controlToFirstCell: number;
  controlLabel: string;
}> {
  return app.evalJS(
    `(function () {
      var q = function (sel) { return document.querySelector(sel); };
      var frame = q(${JSON.stringify(PANE)});
      var bar = q(${JSON.stringify(TITLE_BAR)});
      var beat = q(${JSON.stringify(BEAT)});
      var slot = q(${JSON.stringify(VIEW_SLOT)});
      var entry = q(${JSON.stringify(ENTRY_REGION)});
      var status = q(${JSON.stringify(STATUS_BAR)});
      var control = q(${JSON.stringify(CONTROL)});
      var controlButton = q(${JSON.stringify(CONTROL_BUTTON)});
      var firstCell = q(${JSON.stringify(STATUS_CELL)});
      var lineHeight = beat === null
        ? 0
        : parseFloat(getComputedStyle(beat).lineHeight) || 0;
      return {
        frameFolded: frame === null ? null : frame.getAttribute("data-folded"),
        // The CONTENT height, not the border box: the tier's height rule is
        // content-box and the bar draws a 1px bottom rule under it, so a rect
        // would report the constant plus one and the arithmetic would read as
        // off-by-one when it is exact.
        titleBarHeight: bar === null ? -1 : parseFloat(getComputedStyle(bar).height),
        beatHeight: beat === null ? -1 : beat.getBoundingClientRect().height,
        beatTruncated: beat === null ? false : beat.hasAttribute("data-truncated"),
        beatLines: beat === null || lineHeight === 0
          ? -1
          : Math.round(beat.getBoundingClientRect().height / lineHeight),
        viewSlotDisplay: slot === null ? "absent" : getComputedStyle(slot).display,
        viewSlotInert: slot === null ? false : slot.hasAttribute("inert"),
        entryDisplay: entry === null ? "absent" : getComputedStyle(entry).display,
        entryHeight: entry === null ? -1 : entry.getBoundingClientRect().height,
        entryInert: entry === null ? false : entry.hasAttribute("inert"),
        statusBarHeight: status === null ? -1 : status.getBoundingClientRect().height,
        statusCells: document.querySelectorAll(${JSON.stringify(STATUS_CELL)}).length,
        controlWidth: control === null ? -1 : control.getBoundingClientRect().width,
        controlInset: control === null || status === null
          ? -1
          : control.getBoundingClientRect().left - status.getBoundingClientRect().left,
        controlToFirstCell: control === null || firstCell === null
          ? -1
          : firstCell.getBoundingClientRect().left - control.getBoundingClientRect().right,
        controlLabel: controlButton === null
          ? ""
          : (controlButton.getAttribute("aria-label") || ""),
      };
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0551: the folded Session card's form", () => {
  test(
    "the tier grows a beat line, the body folds to Z2, and the bar takes the width",
    async () => {
      const app = await launchTugApp({ testName: "at0551-fold-form" });
      try {
        await openCard(app);

        // A beat long enough that the open card had to cut it — which is the
        // reading the second line is being bought for.
        await app.evalJS<boolean>(
          `window.__tug.publishPulseFrame(${JSON.stringify(pulseFrame(LONG_BEAT, 1))})`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BEAT)}) !== null`,
          { timeoutMs: 20_000 },
        );

        const openTier = (await readForm(app)).titleBarHeight;
        note("open masthead tier px", openTier);

        await toggleFolded(app, true);
        await app.waitForCondition<boolean>(
          `(function () {
             var button = document.querySelector(${JSON.stringify(CONTROL_BUTTON)});
             return button !== null && button.getAttribute("aria-label") === "Unfold";
           })()`,
          { timeoutMs: 8000 },
        );

        const form = await readForm(app);
        note("folded masthead tier px", form.titleBarHeight);
        note("folded beat box px", form.beatHeight);
        note("Z2 cells", form.statusCells);
        note("control px", `${form.controlWidth} wide, inset ${form.controlInset}, ${form.controlToFirstCell} to STATE`);

        // 1. The flag reaches the frame — every rule below hangs off it.
        expect(form.frameFolded).toBe("true");

        // 2. The tier is one beat line taller, and it is the DECLARED number
        // rather than whatever the text asked for.
        expect(form.titleBarHeight).toBeCloseTo(MASTHEAD_FOLDED_HEIGHT, 0);
        expect(form.titleBarHeight).toBeGreaterThan(openTier);

        // 3. The beat wraps to two lines and stops there, and the wrap is what
        // takes the middle-truncated reading out of the DOM ([R04]).
        expect(form.beatLines).toBe(2);
        expect(form.beatTruncated).toBe(false);

        // 4. The transcript and the composer are off the screen AND out of the
        // walk — hidden, not unmounted, so both must be said.
        expect(form.viewSlotDisplay).toBe("none");
        expect(form.viewSlotInert).toBe(true);
        // The entry region is folded to nothing rather than un-displayed, and
        // that difference is Step 9's ([B06]): it is the element the fold's
        // transition runs on, and a transition has nothing to start from when
        // its element was `display: none` a moment ago — hiding it would cost
        // the SHOW its motion. Zero-height, clipped and `inert` is off the
        // screen and out of the walk by every measure that matters here.
        expect(form.entryHeight).toBeLessThanOrEqual(1);
        expect(form.entryInert).toBe(true);

        // 5. Z2 stays whole: a folded card is instruments plus one door,
        // and the instruments are the same five cells the open card shows.
        expect(form.statusBarHeight).toBeGreaterThan(0);
        expect(form.statusCells).toBe(5);

        // 6. The door is in the row rather than under it ([B03], [B04]), and
        // its label is the whole of what the form change tells the reader.
        // Where in the row it sits is layout, hand-tuned and not pinned.
        expect(form.controlLabel).toBe("Unfold");

        // 7. And it is a door: clicking it shows the transcript again.
        await app.nativeClickAtElement(CONTROL_BUTTON);
        await app.waitForCondition<boolean>(
          `window.__tug.getPaneRecord(${JSON.stringify(PANE_ID)}).folded === false`,
          { timeoutMs: 8000 },
        );
        const shown = await readForm(app);
        expect(shown.frameFolded).toBe(null);
        expect(shown.viewSlotDisplay).not.toBe("none");
        expect(shown.viewSlotInert).toBe(false);
        expect(shown.entryInert).toBe(false);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an unsent draft survives the fold",
    async () => {
      const app = await launchTugApp({ testName: "at0551-fold-draft" });
      try {
        await openCard(app);

        const draft = "the composer folds rather than unmounts";
        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType(draft);
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(PROMPT_INPUT)}).textContent || "").indexOf(${JSON.stringify(draft)}) !== -1`,
          { timeoutMs: 8000 },
        );

        await toggleFolded(app, true);
        await toggleFolded(app, false);

        // The editor is the same element it was: `display: none` costs a draft
        // nothing, and a conditional mount would have cost it everything.
        expect(
          await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(PROMPT_INPUT)})?.textContent || "")`,
          ),
        ).toContain(draft);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the flag rides the saved layout to disk",
    async () => {
      // A tugbank of its own, and `persistInTestMode`: the harness does not
      // write the deck's layout to disk by default, and a reload with nothing
      // saved would restore the DEFAULT deck and pass or fail for a reason
      // that has nothing to do with the flag.
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0551-fold-reload",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await openCard(app);
          await toggleFolded(app, true);

          // The reload's `prepareForReload` flushes every save callback
          // synchronously before navigating, so the layout on disk afterwards
          // is the one the fold produced.
          await app.appReload({ timeoutMs: 20_000 });

          const onDisk = tugbankRead<Record<string, unknown>>(
            tugbankPath,
            "dev.tugapp.deck.layout",
            "layout",
          );
          expect(onDisk, "the deck layout must be on tugbank disk").not.toBeNull();
          const panes = (onDisk!.value as { panes?: readonly Record<string, unknown>[] })
            .panes;
          expect(Array.isArray(panes)).toBe(true);
          const saved = (panes ?? []).find((p) => p["id"] === PANE_ID);
          expect(saved, `pane ${PANE_ID} must be in the saved layout`).toBeDefined();
          expect(saved!["folded"]).toBe(true);
        } finally {
          await app.close();
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the wall register gives the beat two runs, and names what it finished at rest",
    async () => {
      const app = await launchTugApp({ testName: "at0551-fold-wall-register" });
      try {
        await openCard(app);

        // ── A live beat with an intent behind it ──
        // Two facts, and on the folded card two lines to put them on
        // ([P09].3): the retained goal above, the action below. Open, the
        // same feed reads in the one-line register, where the transcript
        // underneath is already saying what the session is for.
        await app.evalJS<boolean>(
          `window.__tug.publishPulseFrame(${JSON.stringify(
            pulseFrame("Running cargo nextest run", 1, WALL_INTENT),
          )})`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BEAT)}) !== null`,
          { timeoutMs: 20_000 },
        );
        const open = await readActivity(app);
        note("open register", `${open.register} · ${open.runs} run(s)`);
        expect(open.register).toBeNull();
        expect(open.text).toContain("Running cargo nextest run");
        // Open, the intent does not render at all — one line, one fact.
        expect(open.intentRun).toBeNull();

        await toggleFolded(app, true);
        const folded = await readActivity(app);
        note(
          "wall register",
          `${folded.register} · intent="${folded.intentRun}" beat="${folded.beatRun}"`,
        );
        expect(folded.register).toBe("wall");
        expect(folded.intentRun).toBe(WALL_INTENT);
        expect(folded.beatRun).toContain("Running cargo nextest run");
        // Two RUNS is not two lines: the runs are set to block so the reader
        // meets the goal and the action as two facts rather than one
        // paragraph, and that is what the claim is about.
        expect(folded.intentBlock).toBe("block");
        expect(folded.beatBlock).toBe("block");
        // …and the pair still fits the two-line clamp the tier was widened
        // for, so a wall of these never ripples ([R04], [B02]).
        expect(folded.truncated).toBe(false);

        // ── The turn ends, and the wall says what it finished ──
        // The voice keeps the turn's intent across the marker ([P09].2), so
        // the rest sentence can name the work rather than only the clock.
        await app.evalJS<boolean>(
          `window.__tug.publishPulseFrame(${JSON.stringify(
            pulseFrame("Done", 2, WALL_INTENT),
          )})`,
        );
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(BEAT)})?.textContent || "").indexOf("Finished:") >= 0`,
          { timeoutMs: 20_000 },
        );
        const rested = await readActivity(app);
        note("wall at rest", rested.text);
        expect(rested.text).toContain(`Finished: ${WALL_INTENT}.`);
        expect(rested.text).toContain("Completed at ");
        expect(rested.text.endsWith("Ready.")).toBe(true);
        // The bare marker never reaches the line — it is the ABSENCE of a
        // beat, and this sentence is what says so with facts in it.
        expect(rested.text).not.toBe("Done");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
