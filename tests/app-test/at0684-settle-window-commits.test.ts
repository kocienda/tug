/**
 * at0684 — every React commit inside a settle gesture's window, named by its
 * size and its cause.
 *
 * Every settle gesture's React commit lands inside the settle window by
 * design: the deck schedules React after the first painted frame of whatever
 * the settle armed. So the frame-gap bar `at0622` holds says whether a
 * gesture's frames arrived, and says nothing about the one thing that decides
 * whether they can — how large the commit under the tween is, and why it is
 * that large. Five gestures were red on their gap bars for exactly that, each
 * a single large commit (`briefs/zero-red-app-tests-brief.md`): closing a pane
 * in a split column, showing a two-member rail, dividing a column, unfolding a
 * session card, and switching workspaces.
 *
 * This file reads each of those legs off the census in `tugdeck/index.html`
 * and notes every commit in the window — fibers performed and mounted, the
 * components that performed the most, the ones that asked, and why each
 * pane-chrome component rendered. Each gesture is driven through the deck's
 * own gesture door, `window.tugdeck.lab.drive`, which is the same door
 * `tugtool deck motion settle` drives on a release deck, so a reading here and
 * a reading there are of the same gesture.
 *
 * It asserts that it read something — the census was in the page, the window
 * was served, the gesture wrote its window, and a commit fell in it. A census
 * that was missing, a covered window, or a gesture that armed no settle would
 * otherwise all read as a leg with nothing to report. Then it bars the
 * largest commit in each leg's window by fibers performed (`COMMIT_BAR`).
 *
 * ## Why this file does not name `deck-canvas.tsx`, `tug-pane.tsx` or `deck-manager.ts`
 *
 * Each of those already fans out to the ceiling `ACCEPTED_FANOUT` records for
 * it, and this file would put all three one over. So it names the engine whose
 * window it reads, the rail toggle its rail leg drives, and the gesture door
 * every leg goes through, and a change to the canvas, the pane frame or the
 * manager that means to move one of these commits runs it by name:
 * `just app-test at0684-settle-window-commits.test.ts`.
 *
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 * @covers tugdeck/src/sidebar-toggle.ts
 * @covers tugdeck/src/lib/gesture-drivers.ts
 * @covers tugdeck/src/components/chrome/pane-place-facts.ts
 */

import { describe, expect, test } from "bun:test";

import { note, type App } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  AFTER_LAND_MS,
  BAR_TIMEOUT_MS,
  FOLD_CARD_ID,
  SHOULD_RUN,
  SWITCH_WINDOW_MS,
  WINDOW_MARGIN_MS,
  bandCensus,
  blobFor,
  columnBlob,
  home,
  largestCommit,
  launch,
  railBlob,
  sampleB09Gesture,
  traceMark,
  traceWithSettleFrames,
  wait,
  windowCommits,
  type B09Leg,
  type WindowReading,
} from "./settle-frames-fixture";

const TEST_NAME = "at0684-settle-window-commits";

/** A `lab.drive` call, as the gesture expression `sampleB09Gesture` takes. */
const drive = (gesture: string, args: Record<string, unknown> = {}): string =>
  `window.tugdeck.lab.drive(${JSON.stringify(gesture)}, ${JSON.stringify(args)})`;

/**
 * Each leg's bar on its largest in-window commit, in fibers performed.
 *
 * About a quarter over the largest of three solo readings, taken with driven
 * gestures under the click's hold (`briefs/settle-window-commit-readings.md`).
 * The three readings per leg:
 *
 * - close: 1623, 547, 547 — bimodal: 1623 when React batches the close's own
 *   commit with its badge and popper commits, 547 when they land apart. A
 *   quarter over 1623 would be looser than the 2000 it was, so it stays 2000.
 * - rails: 45, 45, 45. The rails read 4063 while a hide closed its cards and
 *   the show minted them again; this bar keeps that mount from coming back.
 * - split: 858, 858, 858.
 * - unfold: 169, 169, 169.
 * - switch: 1026, 1026, 1026.
 *
 * The numbers are a default; revise them against these readings.
 */
const COMMIT_BAR: Record<string, number> = {
  close: 2_000,
  rails: 57,
  split: 1_075,
  unfold: 212,
  switch: 1_285,
};

/** The leg's largest in-window commit is under its bar, with the reading. */
function expectUnderBar(leg: string, w: WindowReading): void {
  const largest = largestCommit(w.commits);
  const bar = COMMIT_BAR[leg];
  expect(bar, `${leg}: the leg has a commit bar`).toBeDefined();
  if (largest === null || bar === undefined) return;
  expect(
    largest.performed,
    `${leg}: the largest commit in the window performed ${largest.performed} fibers ` +
      `(mounted ${largest.mounted}, t=${largest.t}, origins ` +
      `${JSON.stringify(largest.origins.slice(0, 6))}) against a bar of ${bar}`,
  ).toBeLessThan(bar);
}

/** Every commit in the window, and the largest, as diagnostics. */
function noteWindow(leg: string, w: WindowReading): void {
  const largest = largestCommit(w.commits);
  note(
    `at0684 ${leg}: ${w.commits.length} commit(s) in a ` +
      `${(w.to - w.from).toFixed(0)} ms window (±${WINDOW_MARGIN_MS} ms)`,
  );
  for (const c of w.commits) {
    note(
      `at0684 ${leg} commit t=${c.t} performed=${c.performed} ` +
        `mounted=${c.mounted} fibers=${c.fibers} top=${JSON.stringify(c.top)} ` +
        `why=${JSON.stringify(c.why.slice(0, 12))}`,
    );
  }
  if (largest !== null) {
    note(
      `at0684 ${leg} largest: t=${largest.t} performed=${largest.performed} ` +
        `mounted=${largest.mounted} fibers=${largest.fibers} ` +
        `origins=${JSON.stringify(largest.origins)} ` +
        `why=${JSON.stringify(largest.why.slice(0, 12))} ` +
        `hooks=${JSON.stringify(largest.hooks)}`,
    );
  }
}

/** Each pane's active card id, which is the id a `why` entry carries. */
const paneCards = (app: App): Promise<Record<string, string>> =>
  app.evalJS<Record<string, string>>(
    `(function () {
       var m = {};
       window.tugdeck.diag.getDeckState().panes.forEach(function (p) {
         m[p.id] = p.activeCardId;
       });
       return m;
     })()`,
  );

/** The panes whose band entry differs between two `bandCensus` strings. */
function movedPanes(before: string, after: string): Set<string> {
  const entries = (s: string): Map<string, string> =>
    new Map(
      s
        .split(" ")
        .filter((e) => e !== "")
        .map((e) => [e.split("@")[0], e.split("@")[1] ?? ""] as [string, string]),
    );
  const a = entries(before);
  const b = entries(after);
  const moved = new Set<string>();
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(id) !== b.get(id)) moved.add(id);
  }
  return moved;
}

/**
 * The `TugPaneImpl` re-renders in the window that no prop of value asked for,
 * on a pane outside the gesture's own set: an entry whose keys are all
 * `~`-prefixed (moved in identity only) or which reads `[state/ctx]`. A
 * survivor the gesture did not move has no reason to render at all, and one
 * that renders only for a fresh reference is a selector that is not narrow.
 *
 * A pane whose props the window shows moving in value (a bare key) is the
 * gesture's too, whether or not its band box moved: a close's slot-mate gets
 * a new `slotStack` and keeps its box.
 */
function strayPaneRenders(w: WindowReading, given: ReadonlySet<string>): string[] {
  const own = new Set(given);
  for (const c of w.commits) {
    for (const entry of c.why) {
      const m = /^TugPaneImpl@([^{[]*)\{([^}]*)\}$/.exec(entry);
      if (m !== null && m[2].split(",").some((k) => k !== "" && !k.startsWith("~"))) own.add(m[1]);
    }
  }
  const stray: string[] = [];
  for (const c of w.commits) {
    for (const entry of c.why) {
      const m = /^TugPaneImpl@([^{[]*)(\{([^}]*)\}|\[state\/ctx\])$/.exec(entry);
      if (m === null || own.has(m[1])) continue;
      const keys = m[3] === undefined ? null : m[3].split(",").filter((k) => k !== "");
      if (keys === null || keys.every((k) => k.startsWith("~"))) stray.push(`t=${c.t} ${entry}`);
    }
  }
  return stray;
}

/** Hold `strayPaneRenders` empty for a leg. */
function expectNoStrayPaneRenders(leg: string, w: WindowReading, own: ReadonlySet<string>): void {
  const stray = strayPaneRenders(w, own);
  expect(
    stray,
    `${leg}: no pane outside the gesture's set re-rendered for identity or a hook — ` +
      `own set ${JSON.stringify([...own])}`,
  ).toEqual([]);
}

/**
 * The props a pane frame lays itself out from. A survivor of a close takes a
 * new share of its run, so these may move on it; nothing else should reach it.
 */
const FRAME_GEOMETRY_KEYS = ["placement", "sizePolicy", "stackState", "columnMember"];

/**
 * Hold a close's survivors to their geometry: no survivor's title bar
 * renders in the window, and a survivor's frame renders only for a key in
 * `FRAME_GEOMETRY_KEYS` moving in value. The badge's count and band, and the
 * picker rows, are read by the badge itself, so a close reaches no bar.
 */
function expectSurvivorsKeepTheirBars(w: WindowReading, departed: string): void {
  const bars: string[] = [];
  const frames: string[] = [];
  for (const c of w.commits) {
    for (const entry of c.why) {
      const bar = /^CardTitleBar\w*@([^{[]*)/.exec(entry);
      if (bar !== null && bar[1] !== departed) bars.push(`t=${c.t} ${entry}`);
      const frame = /^TugPaneImpl@([^{[]*)\{([^}]*)\}$/.exec(entry);
      if (frame === null || frame[1] === departed) continue;
      const moved = frame[2].split(",").filter((k) => k !== "" && !k.startsWith("~"));
      if (moved.some((k) => !FRAME_GEOMETRY_KEYS.includes(k))) frames.push(`t=${c.t} ${entry}`);
    }
  }
  expect(bars, `close: no survivor's title bar rendered in the window`).toEqual([]);
  expect(
    frames,
    `close: a survivor's frame rendered only for ${FRAME_GEOMETRY_KEYS.join(", ")}`,
  ).toEqual([]);
}

/**
 * Read one settle leg's window and hold the four clauses that make it a
 * reading: the census is in the page, the probe was served, the gesture wrote
 * its `settle-frames` row, and a commit fell inside the window.
 */
async function readLeg(
  app: App,
  leg: string,
  mark: number,
  sampled: B09Leg,
  cards: Record<string, string>,
  targets: readonly string[] = [],
): Promise<WindowReading> {
  const census = await app.evalJS<boolean>(`!!window.__tugCommits`);
  expect(census, `${leg}: the commit census is installed in the page`).toBe(true);
  expect(
    sampled.probe.suspended,
    `${leg}: the window was served — ${sampled.probe.ticks} ticks`,
  ).toBe(false);
  expect(sampled.row, `${leg}: the gesture armed a settle and wrote its row`).not.toBeNull();
  const w = await windowCommits(app, mark);
  expect(w, `${leg}: the settle window was found in the trace`).not.toBeNull();
  noteWindow(leg, w as WindowReading);
  expect(
    (w as WindowReading).commits.length,
    `${leg}: at least one React commit fell in the window`,
  ).toBeGreaterThan(0);
  const own = new Set<string>(targets);
  for (const pane of movedPanes(sampled.before, sampled.after)) own.add(cards[pane] ?? pane);
  expectNoStrayPaneRenders(leg, w as WindowReading, own);
  expectUnderBar(leg, w as WindowReading);
  return w as WindowReading;
}

/** One leg on its own launched deck, torn down whatever happens. */
async function onDeck(
  count: number,
  blob: Record<string, unknown>,
  body: (app: App) => Promise<void>,
  homeFirst = true,
): Promise<void> {
  const { app, tugbankPath } = await launch(count, blob, TEST_NAME);
  try {
    await traceWithSettleFrames(app);
    if (homeFirst) await home(app);
    await wait(AFTER_LAND_MS);
    await body(app);
  } finally {
    await app.close();
    rmTempTugbank(tugbankPath);
  }
}

describe.skipIf(!SHOULD_RUN)("at0684 — a card's departure from a split column", () => {
  test(
    "closing the newcomer in a split column: every commit in the window, recorded",
    async () => {
      await onDeck(8, columnBlob(), async (app) => {
        await app.evalJS<null>(`(${drive("split", { slot: 0, mode: "split" })}, null)`);
        await wait(AFTER_LAND_MS);
        const standing = new Set(
          (await bandCensus(app)).split(" ").map((s) => s.split("@")[0]),
        );
        const appear = await sampleB09Gesture(
          app,
          `window.__tug.dispatchControlAction("show-card", { component: "session" })`,
        );
        const newcomers = appear.after
          .split(" ")
          .map((s) => s.split("@")[0])
          .filter((id) => id !== "" && !standing.has(id));
        expect(
          newcomers.length,
          `close (setup): exactly one frame arrived — ${JSON.stringify(newcomers)}`,
        ).toBe(1);
        await wait(AFTER_LAND_MS);

        const cards = await paneCards(app);
        const mark = await traceMark(app);
        const close = await sampleB09Gesture(app, drive("close", { pane: newcomers[0] }));
        const w = await readLeg(app, "close", mark, close, cards);
        expectSurvivorsKeepTheirBars(w, cards[newcomers[0]] ?? newcomers[0]);
      });
    },
    BAR_TIMEOUT_MS,
  );
});

/** The rail's frames, by pane id: every sidebar pane, standing or parked. */
const railFrames = (app: App, which: "all" | "parked" | "standing"): Promise<string[]> =>
  app.evalJS<string[]>(
    `Array.prototype.map.call(
       document.querySelectorAll(${JSON.stringify(
         which === "all"
           ? ".tug-pane[data-sidebar-pane]"
           : which === "parked"
             ? ".tug-pane[data-sidebar-pane][data-rail-parked]"
             : ".tug-pane[data-sidebar-pane]:not([data-rail-parked])",
       )}),
       function (el) { return el.getAttribute("data-pane-id"); }
     ).sort()`,
  );

/** `NSControl.StateValue` for a menu item's mark: unmarked, and checked. */
const MENU_OFF = 0;
const MENU_ON = 1;

/** Poll a Window-menu item until its mark is `want`; return the last read. */
async function menuMark(app: App, identifier: string, want: number): Promise<number | null> {
  const deadline = Date.now() + 8_000;
  let last: number | null = null;
  while (Date.now() < deadline) {
    const item = await app.menuItemState(identifier);
    last = item.found ? item.state : null;
    if (last === want) return last;
    await wait(100);
  }
  return last;
}

/** The rail fixture's two sidebar cards, as their Window-menu toggles. */
const RAIL_MENU_ROWS = ["view.sidebar.layout.show", "view.sidebar.jots.show"];

describe.skipIf(!SHOULD_RUN)("at0684 — showing a two-member rail", () => {
  test(
    "showing the rails after hiding them: the hide parks, the show mounts nothing",
    async () => {
      await onDeck(4, railBlob(), async (app) => {
        const rail = await railFrames(app, "all");
        expect(rail.length, `rails: the fixture stands a two-member rail`).toBe(2);

        await sampleB09Gesture(app, drive("rails"));
        await wait(AFTER_LAND_MS);
        // A hide PARKS: the same frames are still in the document, marked.
        expect(await railFrames(app, "parked"), `rails: the hide parked the rail's frames`).toEqual(
          rail,
        );
        for (const row of RAIL_MENU_ROWS) {
          expect(await menuMark(app, row, MENU_OFF), `rails menu: ${row} unmarked while parked`).toBe(
            MENU_OFF,
          );
        }

        const mark = await traceMark(app);
        const show = await sampleB09Gesture(app, drive("rails"));
        const w = await readLeg(app, "rails", mark, show, await paneCards(app));
        const mounted = w.commits.reduce((sum, c) => sum + c.mounted, 0);
        expect(mounted, `rails: the show mounted nothing in its window`).toBe(0);
        // [L26]: the frames that stand are the very ones that parked.
        expect(await railFrames(app, "standing"), `rails: the same frames stand again`).toEqual(
          rail,
        );
        expect(await railFrames(app, "parked"), `rails: nothing is left parked`).toEqual([]);
        for (const row of RAIL_MENU_ROWS) {
          expect(await menuMark(app, row, MENU_ON), `rails menu: ${row} marked once shown`).toBe(
            MENU_ON,
          );
        }
      });
    },
    BAR_TIMEOUT_MS,
  );
});

describe.skipIf(!SHOULD_RUN)("at0684 — dividing a shared column", () => {
  test(
    "splitting slot 0 of the eight-card column deck: every commit in the window, recorded",
    async () => {
      await onDeck(8, columnBlob(), async (app) => {
        const cards = await paneCards(app);
        const mark = await traceMark(app);
        const split = await sampleB09Gesture(app, drive("split", { slot: 0, mode: "split" }));
        await readLeg(app, "split", mark, split, cards);
      });
    },
    BAR_TIMEOUT_MS,
  );
});

describe.skipIf(!SHOULD_RUN)("at0684 — unfolding a session card", () => {
  test(
    "unfolding a folded session card in the flow: every commit in the window, recorded",
    async () => {
      await onDeck(4, blobFor(4), async (app) => {
        await sampleB09Gesture(app, drive("fold", { card: FOLD_CARD_ID }));
        await wait(AFTER_LAND_MS);
        const cards = await paneCards(app);
        const mark = await traceMark(app);
        const unfold = await sampleB09Gesture(app, drive("unfold", { card: FOLD_CARD_ID }));
        await readLeg(app, "unfold", mark, unfold, cards, [FOLD_CARD_ID]);
      });
    },
    BAR_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// The switch: two workspaces, after at0643's shape without its growth step
// ---------------------------------------------------------------------------

const SPACE_ONE = "at0684-one";
const SPACE_TWO = "at0684-two";

/** The card ids of workspace `n`'s deck in `twoSpaceBlob`. */
const spaceCards = (n: string): string[] => [
  `at0684-c${n}`,
  ...[1, 2, 3].map((i) => `at0684-s${n}${i}`),
  ...[1, 2].map((i) => `at0684-t${n}${i}`),
];

/**
 * Two workspaces, each a Workspaces rail, three session cards and two text
 * cards — `at0643`'s fixture without the streamed turns and loops it grows
 * itself with. This file reads which components the switch commits, and that
 * does not need a grown deck to be named; how long the grown one takes to
 * paint is `at0643`'s question.
 */
function twoSpaceBlob(): Record<string, unknown> {
  const deck = (n: string): Record<string, unknown> => {
    const sessions = [1, 2, 3].map((i) => `at0684-s${n}${i}`);
    const texts = [1, 2].map((i) => `at0684-t${n}${i}`);
    const pane = (id: string, cardId: string, y: number, rail = false) => ({
      id,
      position: { x: rail ? 0 : 60, y },
      size: rail ? { width: 420, height: 900 } : { width: 700, height: 360 },
      cardIds: [cardId],
      activeCardId: cardId,
      title: "",
      acceptsFamilies: rail ? [] : ["standard"],
    });
    return {
      cards: [
        { id: `at0684-c${n}`, componentId: "cards", title: "Workspaces", closable: true },
        ...sessions.map((id) => ({ id, componentId: "session", title: id, closable: true })),
        ...texts.map((id) => ({ id, componentId: "text", title: id, closable: true })),
      ],
      panes: [
        pane(`at0684-pc${n}`, `at0684-c${n}`, 0, true),
        ...[...sessions, ...texts].map((id, i) => pane(`at0684-p${n}${i}`, id, 40 + i * 260)),
      ],
      activePaneId: `at0684-p${n}0`,
      imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
      hasFocus: true,
    };
  };
  return {
    version: 5,
    activeSpaceId: SPACE_ONE,
    spaces: [
      { id: SPACE_ONE, name: "One", deck: deck("a") },
      { id: SPACE_TWO, name: "Two", deck: deck("b") },
    ],
  };
}

describe.skipIf(!SHOULD_RUN)("at0684 — switching workspaces", () => {
  test(
    "a switch to a mounted workspace: every commit in its window, recorded",
    async () => {
      await onDeck(4, twoSpaceBlob(), async (app) => {
        // Mount both layers first: the first switch to a workspace nobody has
        // visited is a mount, a different path from the re-show every switch
        // after it takes (`at0643`).
        await app.evalJS<null>(`(${drive("switch", { space: SPACE_TWO })}, null)`);
        await wait(2_000);
        await app.evalJS<null>(`(${drive("switch", { space: SPACE_ONE })}, null)`);
        await wait(2_000);

        await app.evalJS<null>(
          `(window.__deckTrace.enableKind("space-switch-frames", true), null)`,
        );
        const mark = await traceMark(app);
        const from = await app.evalJS<number>(
          `(function () { var t = performance.now(); ${drive("switch", { space: SPACE_TWO })}; return t; })()`,
        );
        await wait(SWITCH_WINDOW_MS + AFTER_LAND_MS);
        await app.waitForCondition<boolean>(
          `window.__deckTrace.since(${mark}).some(function (e) { return e.kind === "space-switch-frames"; })`,
          { timeoutMs: 8_000 },
        );
        const record = await app.evalJS<{ suspended: boolean; ticks: number }>(
          `(function () {
             var rows = window.__deckTrace.since(${mark}).filter(function (e) {
               return e.kind === "space-switch-frames";
             });
             var r = rows[rows.length - 1];
             return { suspended: r.suspended, ticks: r.ticks };
           })()`,
        );
        await app.evalJS<null>(
          `(window.__deckTrace.enableKind("space-switch-frames", false), null)`,
        );

        const census = await app.evalJS<boolean>(`!!window.__tugCommits`);
        expect(census, `switch: the commit census is installed in the page`).toBe(true);
        expect(record.suspended, `switch: the window was served — ${record.ticks} ticks`).toBe(
          false,
        );
        const w = await windowCommits(app, mark, { from, ms: SWITCH_WINDOW_MS });
        expect(w, `switch: the window was read`).not.toBeNull();
        noteWindow("switch", w as WindowReading);
        expect(
          (w as WindowReading).commits.length,
          `switch: at least one React commit fell in the window`,
        ).toBeGreaterThan(0);
        // The gesture's own set is the arriving workspace: every one of its
        // panes is newly shown. The departing workspace's panes are outside it.
        expectNoStrayPaneRenders("switch", w as WindowReading, new Set(spaceCards("b")));
        expectUnderBar("switch", w as WindowReading);
      }, false);
    },
    BAR_TIMEOUT_MS,
  );
});
