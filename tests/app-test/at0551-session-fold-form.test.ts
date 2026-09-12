/**
 * at0551-session-fold-form.test.ts — what a folded Session card IS.
 *
 * ## What this gates
 *
 * The flag is the pane's ([P01]) and at0550 gates the doors that set it. This
 * file gates the FORM it produces ([B01], [P03]): the Session card's
 * masthead tier — one line taller than a document's in EVERY form ([B04]),
 * with the DESCRIPTION wrapped to two lines — and the Z2 status row, whose
 * leading edge carries the card's one fold control ([B03]), and nothing else
 * on screen.
 *
 * Four claims:
 *
 *   1. **The form.** `data-folded="true"` reaches the pane frame; the title
 *      bar stands at `SESSION_MASTHEAD_HEIGHT` — the SAME tier it stood at
 *      open, which is the fold no longer moving the chrome; the DESCRIPTION
 *      run is two lines tall and the beat under it is still one; the
 *      transcript slot and the entry region are neither displayed nor
 *      reachable; Z2 is still on screen with its cells; and the control at
 *      Z2's leading edge has turned over to `Unfold` — the one thing the
 *      form change costs the reader, now that the verb has one seat instead
 *      of two ([B03], [B04]).
 *   2. **The composer folds, it does not unmount** ([B05], [L26]). Text typed
 *      into the editor is still in it after a fold and a show — which is
 *      the whole reason the fold is a collapse and an `inert` attribute rather
 *      than a conditional mount.
 *   3. **The DESCRIPTION reads in the WALL register** ([B01]), open as well
 *      as folded ([B04]). The tier's extra line goes to the line carrying
 *      the most and changing the least: during a turn that is the newest
 *      Observer POST about this session, falling back to the ask the turn is
 *      answering ([D187]). It is set to `block` and given the two lines the
 *      tier was widened for, and a post too long for one line is read over
 *      both. The beat under it keeps the single line it reads in on every
 *      other surface — it is short, and it changes about once a second. At
 *      rest the beat's line is the activity rest sentence
 *      (`No turns. Ready.`) and the description is the standing sentence
 *      again.
 *   4. **The flag rides the saved layout.** Fold, reload, and the pane's
 *      `folded` is in the layout blob on tugbank disk — the SAVE side of
 *      [P01], driven through the real flush. The load side is a unit test's
 *      subject (`serialization.ts`'s `parseV4` rebuilds a pane field by
 *      field, so an additive field it does not read is one that does not come
 *      back) rather than this file's, because the harness re-seeds a deck
 *      after a reload instead of restoring the saved one — a restored frame
 *      here would be reading the seed back, not the disk.
 *
 * The two-line post is seeded through `publishOverviewPost`, the door the
 * ladder's own claim already uses — no live Observer, and a post long enough
 * that one line of the tier could never have held it.
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
 * @covers tugdeck/src/lib/session-activity-line.ts
 * @covers tugdeck/src/lib/digest-store.ts
 * @covers tugdeck/src/lib/overview-store.ts
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
const BEAT = `${PANE} .session-masthead-row [data-slot="tug-activity-line-activity"]`;
const VIEW_SLOT = `${CARD} .session-view-slot`;
const ENTRY_REGION = `${CARD} [data-slot="session-card-entry-region"]`;
const STATUS_BAR = `${CARD} [data-slot="session-card-status-bar"]`;
const STATUS_CELL = `${STATUS_BAR} [data-slot="tug-status-cell"]`;
const CONTROL = `${STATUS_BAR} [data-slot="session-fold-control"]`;
const CONTROL_BUTTON = `${CONTROL} button`;
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const DESCRIPTION = `${PANE} .session-masthead-row .tug-session-row-description`;
/* The GROUP the tape reports on: the description and the beat as one box. */
const PULSE = `${PANE} .session-masthead-row .tug-session-row-pulse`;
const TAPE = `${PANE} .session-masthead-row .tug-activity-line-trailing`;

/**
 * `SESSION_MASTHEAD_HEIGHT` in `tug-pane.tsx`, which must equal
 * `--tug-masthead-height` (72) + `--tugx-session-masthead-extra-line` (30).
 * The constant is duplicated here rather than imported because an app-test
 * drives the BUILT app: importing the module would assert the source against
 * itself and say nothing about the cascade that actually produced the tier.
 *
 * The tier moved once, from 88, when the description took the LOOSE type
 * setting ([B07] of the narration-one brief): the pair is set in a band
 * floored at the atom register, so a commit pill in a post is whole. What
 * this file pins is unchanged by that — the tier is the SAME in both forms,
 * which is the `masthead-second-line` decision and the reason for the
 * assertion below.
 */
const SESSION_MASTHEAD_HEIGHT = 102;

/** A beat, long enough that the run it rides in has to cut it — on both forms. */
const LONG_BEAT =
  "Reading the imposition allocator and its ceiling ladder, then re-running the column tests for the wall";

/**
 * A post no single line of the tier could show whole — the second line's
 * whole reason. Inside the Observer's own 200-character budget
 * (`overview_agent.rs`), and some three times what one line holds.
 */
const LONG_POST =
  "Rewriting the imposition allocator's ceiling ladder so a folded card asks for its own tier, then re-running the column tests and the fold form against the wall at both slim and wide widths.";

/**
 * The same sentence as the LINE renders it. The description runs through the
 * transcript's markdown pipeline now, the Overview's own call and no second
 * one, and that pipeline's smart punctuation sets a typed apostrophe as a
 * typographic one. The post is written the way an agent types it; what lands
 * on the line is what the reader sees, and the two differ in exactly this.
 */
const LONG_POST_INK = LONG_POST.replace("allocator's", "allocator’s");

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
function digestFrame(text: string, beat: number, kind?: string): string {
  return JSON.stringify({
    type: "digest",
    text,
    scopes: [SID],
    beat,
    at: Date.now(),
    ...(kind !== undefined ? { kind } : {}),
  });
}

/**
 * One Observer post about this session, as the OVERVIEW feed carries it.
 * `at_ms` is `Date.now()` so the post is newer than the beats seeded before
 * it, which is what the masthead's ladder and the history's grouping both
 * read.
 */
function observerPost(body: string, id: number): string {
  return JSON.stringify({
    id,
    at_ms: Date.now(),
    author: "observer",
    session_id: SID,
    body,
    refs: [],
  });
}

/** What the Observer says about the turn, in the register it writes in. */
const POST_BODY = "Folding the transcript and the composer on one clock";
/** What the user asked for — rung (2), and what shows before the first post. */
const ASK_TEXT = "Fold the card on one clock";

/**
 * The row's two lower lines as the two registers render them: which register
 * the row drew, the beat's own text, and — in the wall register — the post
 * run with the `display` that lets it take the width before it wraps.
 */
async function readActivity(app: App): Promise<{
  register: string | null;
  runs: number;
  text: string;
  beatRun: string | null;
  postBlock: string | null;
  truncated: boolean;
}> {
  return app.evalJS(
    `(function () {
      var run = document.querySelector(${JSON.stringify(BEAT)});
      var desc = document.querySelector(${JSON.stringify(DESCRIPTION)});
      if (run === null) {
        return {
          register: null, runs: 0, text: "",
          beatRun: null, postBlock: null, truncated: false,
        };
      }
      var wall = desc === null ? null : desc.querySelector('[data-register="wall"]');
      var flat = function (el) {
        return el === null ? null : (el.textContent || "").replace(/\\s+/g, " ").trim();
      };
      return {
        register: wall === null ? null : wall.getAttribute("data-register"),
        runs: run.querySelectorAll("span[class]").length,
        text: (run.textContent || "").replace(/\\s+/g, " ").trim(),
        beatRun: flat(run),
        postBlock: wall === null ? null : getComputedStyle(wall).display,
        truncated: run.hasAttribute("data-truncated"),
      };
    })()`,
  );
}

/** The description line's text, flattened — the masthead's upper line. */
async function readDescription(app: App): Promise<string> {
  return app.evalJS(
    `(function () {
      var el = document.querySelector(${JSON.stringify(DESCRIPTION)});
      return el === null ? "" : (el.textContent || "").replace(/\\s+/g, " ").trim();
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
  descHeight: number;
  descLines: number;
  /** The tape's centre, less the pulse group's — 0 when it reads centred. */
  tapeOffCentre: number;
  /** The tape's drawn width. Zero is the instrument being absent. */
  tapeWidth: number;
  beatHeight: number;
  beatTruncated: boolean;
  beatLines: number;
  viewSlotDisplay: string;
  viewSlotInert: boolean;
  entryDisplay: string;
  entryHeight: number;
  entryRows: string;
  entryFoldPhase: string;
  entryChild: string;
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
      var desc = q(${JSON.stringify(DESCRIPTION)});
      var pulse = q(${JSON.stringify(PULSE)});
      var tape = q(${JSON.stringify(TAPE)});
      var slot = q(${JSON.stringify(VIEW_SLOT)});
      var entry = q(${JSON.stringify(ENTRY_REGION)});
      var status = q(${JSON.stringify(STATUS_BAR)});
      var control = q(${JSON.stringify(CONTROL)});
      var controlButton = q(${JSON.stringify(CONTROL_BUTTON)});
      var firstCell = q(${JSON.stringify(STATUS_CELL)});
      var lineHeight = beat === null
        ? 0
        : parseFloat(getComputedStyle(beat).lineHeight) || 0;
      var descLineHeight = desc === null
        ? 0
        : parseFloat(getComputedStyle(desc).lineHeight) || 0;
      return {
        frameFolded: frame === null ? null : frame.getAttribute("data-folded"),
        // The CONTENT height, not the border box: the tier's height rule is
        // content-box and the bar draws a 1px bottom rule under it, so a rect
        // would report the constant plus one and the arithmetic would read as
        // off-by-one when it is exact.
        titleBarHeight: bar === null ? -1 : parseFloat(getComputedStyle(bar).height),
        descHeight: desc === null ? -1 : desc.getBoundingClientRect().height,
        descLines: desc === null || descLineHeight === 0
          ? -1
          : Math.round(desc.getBoundingClientRect().height / descLineHeight),
        tapeOffCentre: pulse === null || tape === null
          ? -999
          : (function () {
              var t = tape.getBoundingClientRect();
              var p = pulse.getBoundingClientRect();
              return (t.top + t.height / 2) - (p.top + p.height / 2);
            })(),
        tapeWidth: tape === null ? -1 : tape.getBoundingClientRect().width,
        beatHeight: beat === null ? -1 : beat.getBoundingClientRect().height,
        beatTruncated: beat === null ? false : beat.hasAttribute("data-truncated"),
        beatLines: beat === null || lineHeight === 0
          ? -1
          : Math.round(beat.getBoundingClientRect().height / lineHeight),
        viewSlotDisplay: slot === null ? "absent" : getComputedStyle(slot).display,
        viewSlotInert: slot === null ? false : slot.hasAttribute("inert"),
        entryDisplay: entry === null ? "absent" : getComputedStyle(entry).display,
        entryHeight: entry === null ? -1 : entry.getBoundingClientRect().height,
        entryRows: entry === null ? "absent" : getComputedStyle(entry).gridTemplateRows,
        entryFoldPhase: (function () {
          var card = q(${JSON.stringify(CARD)} + " .session-card");
          return card === null ? "absent" : (card.getAttribute("data-fold") || "none");
        })(),
        entryChild: (function () {
          var kid = entry === null ? null : entry.firstElementChild;
          if (kid === null) return "absent";
          var cs = getComputedStyle(kid);
          return kid.getBoundingClientRect().height + "px child, min-height " +
            cs.minHeight + ", overflow " + cs.overflow;
        })(),
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
    "the tier grows a line, the body folds to Z2, and the bar takes the width",
    async () => {
      const app = await launchTugApp({ testName: "at0551-fold-form" });
      try {
        await openCard(app);

        // A turn in flight, and on both lower lines a run too long for it: a
        // kinded beat (which is also what puts the turn in flight, so the
        // post rung is the one the description climbs to), and a post three
        // times what one line holds — the reading the second line is bought
        // for.
        await app.evalJS<boolean>(
          `window.__tug.publishDigestFrame(${JSON.stringify(
            digestFrame(LONG_BEAT, 1, "tool"),
          )})`,
        );
        await app.evalJS<boolean>(
          `window.__tug.publishOverviewPost(${JSON.stringify(
            observerPost(LONG_POST, 1),
          )})`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BEAT)}) !== null`,
          { timeoutMs: 20_000 },
        );
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(DESCRIPTION)})?.textContent || "").indexOf(${JSON.stringify(LONG_POST_INK)}) >= 0`,
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
        note("folded post box px", form.descHeight);
        note("folded beat box px", form.beatHeight);
        note("tape off pulse centre px", form.tapeOffCentre);
        note("tape box px", form.tapeWidth);
        note("folded beat truncated", form.beatTruncated);
        note("Z2 cells", form.statusCells);
        note("control px", `${form.controlWidth} wide, inset ${form.controlInset}, ${form.controlToFirstCell} to STATE`);
        note("entry region", `${form.entryHeight}px, rows ${form.entryRows}, fold ${form.entryFoldPhase}`);
        note("entry child", form.entryChild);

        // 1. The flag reaches the frame — every rule below hangs off it.
        expect(form.frameFolded).toBe("true");

        // 2. The tier is the DECLARED number rather than whatever the text
        // asked for — and it is the same number it was open, because the
        // Session card's masthead carries its extra line in both forms
        // ([B04]) and the fold no longer moves the chrome at all.
        expect(form.titleBarHeight).toBeCloseTo(SESSION_MASTHEAD_HEIGHT, 0);
        expect(form.titleBarHeight).toBeCloseTo(openTier, 0);

        // 3. The POST wraps to two lines and stops there, and the beat under
        // it stays on the one line it reads in everywhere else ([B01]) — the
        // extra line is spent on the longest and slowest run, not the
        // shortest and fastest.
        expect(form.descLines).toBe(2);
        expect(form.beatLines).toBe(1);

        // 3b. The tape reads on the GROUP, so it centres on the group's box —
        // the description and the beat together — however many lines the
        // description is standing at. Riding the beat's own line on a lift
        // computed from ONE line's band put it half a line low exactly here,
        // where the description is two. And it is drawn at all: an instrument
        // that comes and goes with its data is one the reader cannot trust.
        expect(Math.abs(form.tapeOffCentre)).toBeLessThanOrEqual(1);
        expect(form.tapeWidth).toBeGreaterThan(0);

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
    "the upper line climbs the post/ask ladder and reads in the wall register",
    async () => {
      const app = await launchTugApp({ testName: "at0551-fold-wall-register" });
      try {
        await openCard(app);

        // ── The turn opens: an ask, then work ──
        // For the first minute of any turn there is no post yet — the sitrep
        // is 60 s — so rung (2) is the whole of what the reader gets, and it
        // is the thing they most want ([D187]).
        await app.evalJS<boolean>(
          `window.__tug.publishDigestFrame(${JSON.stringify(
            digestFrame(`asked: ${ASK_TEXT}`, 1, "ask"),
          )})`,
        );
        await app.evalJS<boolean>(
          `window.__tug.publishDigestFrame(${JSON.stringify(
            digestFrame("Running cargo nextest run", 2, "tool"),
          )})`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BEAT)}) !== null`,
          { timeoutMs: 20_000 },
        );
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(DESCRIPTION)})?.textContent || "").indexOf(${JSON.stringify(ASK_TEXT)}) >= 0`,
          { timeoutMs: 20_000 },
        );
        const asking = await readDescription(app);
        note("upper line, no post yet", asking);
        // The ask, without the `asked:` head the strip gives it: on the upper
        // line it is the only thing there, so the label labels nothing.
        expect(asking).toBe(ASK_TEXT);

        // ── The first post lands and takes the line ──
        await app.evalJS<boolean>(
          `window.__tug.publishOverviewPost(${JSON.stringify(
            observerPost(POST_BODY, 1),
          )})`,
        );
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(DESCRIPTION)})?.textContent || "").indexOf(${JSON.stringify(POST_BODY)}) >= 0`,
          { timeoutMs: 20_000 },
        );
        note("upper line, post landed", await readDescription(app));

        // The beat line paces its swaps (`MIN_DWELL_MS`), so the ask holds it
        // for a moment before the tool line arrives. Wait for the beat the
        // register claims are about, rather than for the frame that carried it.
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(BEAT)})?.textContent || "").indexOf("Running cargo nextest run") >= 0`,
          { timeoutMs: 20_000 },
        );
        const open = await readActivity(app);
        note("open register", `${open.register} · ${open.runs} run(s)`);
        // The masthead reads in the wall register OPEN too ([B04]) — the
        // register no longer turns over with the form, because the tier no
        // longer changes height with it.
        expect(open.register).toBe("wall");
        expect(open.text).toContain("Running cargo nextest run");

        await toggleFolded(app, true);
        const folded = await readActivity(app);
        note("wall register", `${folded.register} · beat="${folded.beatRun}"`);
        expect(folded.register).toBe("wall");
        expect(folded.beatRun).toContain("Running cargo nextest run");
        // `block` is what lets the POST take the width before it wraps into
        // the two lines the tier was widened for.
        expect(folded.postBlock).toBe("block");
        // Folded, the post is still the line above the beat: the two facts a
        // watched card is being asked for are what it is doing and what that
        // is for — and it is the upper one the second line went to.
        expect(await readDescription(app)).toBe(POST_BODY);

        // ── The turn ends, and both lines go to rest ──
        // The marker never reaches the beat line: it is the ABSENCE of a beat,
        // and the rest sentence is what says so with facts in it.
        await app.evalJS<boolean>(
          `window.__tug.publishDigestFrame(${JSON.stringify(
            digestFrame("Done", 3, "turn"),
          )})`,
        );
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(BEAT)})?.textContent || "").trim().endsWith("Ready.")`,
          { timeoutMs: 20_000 },
        );
        const rested = await readActivity(app);
        note("wall at rest", rested.text);
        expect(rested.text.endsWith("Ready.")).toBe(true);
        expect(rested.text).not.toBe("Done");
        // And the upper line leaves the ladder: at rest it is [D132]'s again.
        // This session has no standing sentence, no recorded first prompt and
        // no arc, so what it lands on is that ladder's floor — which is the
        // point: the post is gone from the line the moment the turn is.
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(DESCRIPTION)})?.textContent || "").indexOf(${JSON.stringify(POST_BODY)}) < 0`,
          { timeoutMs: 20_000 },
        );
        note("upper line at rest", await readDescription(app));
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
