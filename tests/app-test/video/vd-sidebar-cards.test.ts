/**
 * vd-sidebar-cards.test.ts — the video's sidebar-cards sequence, timed to the
 * narration in the `vids` repo (`incoming/sidebar-cards-audio.wav`): the
 * whole window from "Sidebar cards pin to the edges" (0.0 s) to "…between
 * cards and projects" (38.0 s), in two bursts of one launch, for a
 * half-width frame.
 *
 * A video tool, not a test of the app: it stages a scene and records it,
 * and its assertions are that frames were written and the deck ended where
 * the scene says. It lives beside the site's drivers and shares their
 * helpers and gate (`../site-clips/_site-clips.ts`): run by path, once per
 * mode, with `TUG_SITE_CLIPS_OUT` and `TUG_SITE_CLIPS_MODE` set. The `vids`
 * repo's `tools/shot.py sidebar-cards` is the usual caller, and its
 * `tools/assemble.py sidebar-cards` lays the frames under the narration.
 *
 * The scene: a two-up under Flow at Slim width in a window the shape of
 * half a 4K frame, with both rails standing and all five factory rail cards
 * up from the first frame. Two Session cards divide slot 1 (a split column,
 * so the upper card's composer sits beside the Jots card) and two Harbor
 * files share slot 2, so the Workspaces card has four rows and a file row's
 * click fronts a card the reader could not see.
 * The sessions are resumed from committed transcripts on a scratch
 * repository named `tug`, where two arcs stand with task lists the real
 * verbs walked, each bound to its session, so the Arcs card has rows to
 * fold open. The Overview is fed posts through `publishOverviewPost`.
 * Every act is placed at a narration time, in seconds of audio:
 *
 *   "pin to the edges"              all five sidebar cards flash at once
 *   "Overview is a feed…"           observer posts arrive, from both
 *                                   sessions and a second project
 *   "ask it questions"              a question is typed in the Overview's
 *                                   composer and sent; the Operator answers
 *   "Arcs…"                         an arc's row folds open to its steps,
 *                                   then the other's
 *   "Jots…"                         a jot is dragged from the Jots card into
 *                                   the upper session's prompt composer
 *   "Layout gives controls"         Width to Comfy and back to Slim
 *   "live interactive miniature"    a press flashes a card; a card is
 *                                   dragged across the picture and the deck
 *                                   follows; and dragged home
 *   "Workspaces…"                   rows are clicked, and the deck fronts
 *                                   each card in turn
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { note, type App } from "../_harness";
import { nativeDrag } from "../_harness/client";
import { claudeProjectDir } from "../_harness/claude-home";
import { onTestRunEnd } from "../_harness/test-cleanup";
import {
  appendArcLogLine,
  arcBriefPath,
  arcLogPath,
  arcTasksPath,
  bindArc,
  createArc,
  fixturePlanDocument,
  makeArcScratchRepo,
  rmArcScratchRepo,
  tugtool,
  type ArcScratchRepo,
} from "../arc-fixture";
import { PROMPT_INPUT, settleFor } from "../body-grounding/_bodies";
import { kindPane } from "../body-grounding/_kinds";
import { fixturePath } from "../fixtures/resolve";
import { placeholderCard, placeholderSettings, placeholderStates, standUpPlaceholders, type Placeholder } from "../site-clips/_placeholders";
import { factoryRails, railsEnv, standUpRails } from "../site-clips/_rails";
import { MODE, RUNS, contentSize, expectRecorded, launchForMode, outDirFor, scene, standIns } from "../site-clips/_site-clips";

const TEST_TIMEOUT_MS = 500_000;
/** This checkout — whose built CLI cuts the arcs, and never the tree they are cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", "..", ".."));

/** The narration's window, and where the two bursts meet (a quiet beat before "Layout"). */
const CLIP_AT = 0.0;
const BURST_SPLIT = 21.2;
const CLIP_END = 38.0;

/** Half a 4K frame's shape, as tall as the screen's menu bar allows: 3080 × 3464 pixels at 2×, scaled to 1920 × 2160 by assemble.py. */
const CONTENT_SIZE = { width: 1540, height: 1732 };
/** View › Zoom, so two Slim cards and both rails fit the band under Flow. */
const PAGE_ZOOM = 0.6;

const RAIL_PREFIX = "vd-sb-rail";
const ARCS = `${RAIL_PREFIX}-arcs`;
const JOTS = `${RAIL_PREFIX}-jots`;
const OVERVIEW = `${RAIL_PREFIX}-overview`;
const CARDS = `${RAIL_PREFIX}-cards`;
const LAYOUT = `${RAIL_PREFIX}-layout`;
/** The five sidebar cards, which stand from the first frame. */
const RAIL_CARDS: readonly string[] = [ARCS, JOTS, OVERVIEW, CARDS, LAYOUT];

/** One arc a session worked: its name, its step titles, and how many are closed. */
interface Arc {
  name: string;
  steps: readonly string[];
  done: number;
}

/** A Session card: the transcript it resumes, the identity its masthead shows, the ledger facts its rest line reads, and the arc it is the seat of. */
interface Session {
  id: string;
  fixture: string;
  identity: { name: string; name_user_set: boolean; tag: string; synopsis: string };
  facts: { turn_count: number; file_size: number; last_used_at: number };
  /** Absent for a session that only has to exist, so a post can cite it. */
  arc?: Arc;
}

const S1: Session = {
  id: "vd-sb-s1",
  fixture: "session-transcript-basic",
  identity: { name: "picker-keys", name_user_set: true, tag: "amber-heron", synopsis: "Make the session picker's arrow keys walk the tree" },
  facts: { turn_count: 4, file_size: 149_606, last_used_at: Date.UTC(2026, 9, 24, 23, 12) },
  arc: {
    name: "picker-keys",
    steps: ["Walk the tree with the arrow keys", "Wrap at the ends of a branch", "Open a folder row on Return", "An app-test over the walk"],
    done: 2,
  },
};
const S2: Session = {
  id: "vd-sb-s2",
  fixture: "session-task-run-fold",
  identity: { name: "edge-insert", name_user_set: true, tag: "teal-otter", synopsis: "Add the Edge Insert effect with an Overlap slider" },
  facts: { turn_count: 4, file_size: 139_045, last_used_at: Date.UTC(2026, 10, 6, 21, 40) },
  arc: {
    name: "edge-insert",
    steps: ["Rig the Overlap slider to the Ramp", "Fill the frame-sized drop zone", "Default the edge to Bottom", "Verify in Motion and Final Cut"],
    done: 3,
  },
};
const TIDES = { id: "vd-sb-tides", file: "tides.ts" } as const satisfies Placeholder;
/** A third session, parked behind the files, so the Operator's answer can cite it as a session atom: the ledger must hold a session of that name. */
const S3: Session = {
  id: "vd-sb-s3",
  fixture: "session-transcript-margins",
  identity: { name: "glyph-font", name_user_set: true, tag: "slate-wren", synopsis: "Add a font for the macOS modifier glyphs in chord labels" },
  facts: { turn_count: 3, file_size: 121_880, last_used_at: Date.UTC(2026, 9, 28, 17, 5) },
};
const README = { id: "vd-sb-readme", file: "README.md" } as const satisfies Placeholder;
const FILES = [TIDES, README] as const;

/** The Jots card's rows, `j1` to `j5`; `j2` is the one dragged into a prompt. */
const JOTS_TEXT: readonly string[] = [
  "ask me some questions to guide the process for writing a c program to build a command-line calculator. give me options for the math features to support.",
  "count the number of lines of code with tokei",
  "run `just ci` and fix the issues please!",
  "audit the implementation work for the just-completed arc.",
  "write me a haiku about summertime",
];
const DRAGGED_JOT = "j2";

const BOUND_MS = 90_000;
const SETTLE_HOLD_MS = 500;

/** Pace for the drags: the press, then steps × delay. */
const PRESS_MS = 250;
const DRAG_STEPS = 36;
const DRAG_STEP_MS = 30;

const arcsRow = (arc: Arc): string => `[data-slot="arcs-row"][data-arc="${arc.name}"]`;
const foldCue = (arc: Arc): string => `${arcsRow(arc)} [data-slot="arcs-steps-fold"]`;
const jotLabel = (jotId: string): string => `.jot-row-content[data-jot-id="${jotId}"] .jot-row-label`;
const widthChoice = (value: string): string => `[data-testid="layout-card-width"] [data-choice-value="${value}"]`;
/** A miniature target: a split column's member by its row, or an unsplit slot's block; `miniSlot` takes whichever a slot draws. */
const miniMember = (slot: number, index: number): string => `[data-testid="layout-card-places"] [data-testid="layout-card-target-member-${slot}-${index}"]`;
const miniBlock = (slot: number): string => `[data-testid="layout-card-places"] [data-testid="layout-card-target-block-${slot}"]`;
const miniSlot = (slot: number): string => `${miniBlock(slot)}, ${miniMember(slot, 0)}`;
/** A Workspaces row: a single-card pane's row is keyed by its session id for a Session card, and by its card id otherwise. */
const workspaceRow = (key: string): string => `.cards-row[data-cards-row-id="${key}"]`;
const OVERVIEW_TRANSCRIPT = '[data-testid="overview-card"] [data-testid="overview-transcript"]';
const OVERVIEW_FIELD = '[data-testid="overview-composer-field"] .cm-content';
/** The question asked in the Overview's composer, and the Operator's answer. */
const QUESTION = "what was the session where we added the new font for macOS modifier glyphs?";
/** The answer cites the session through the post's `session_id`, which the card draws as a session atom under the prose. */
const ANSWER = `That was ${S3.identity.name}, on October 28 in tug. It added the font that draws the ⌘ ⌥ ⌃ ⇧ glyphs and pointed the chord labels at it; the session card and the menus picked it up in the same commit.`;

interface WirePost {
  id: number;
  at_ms: number;
  author: "observer" | "operator" | "user";
  body: string;
  refs: { kind: string; target: string }[];
  session_id?: string;
  wake_reason?: string;
  project_dir?: string;
  request_id?: string;
  elapsed_ms?: number;
}

function deck(): Record<string, unknown> {
  const rails = factoryRails(RAIL_PREFIX);
  return {
    cards: [
      { id: S1.id, componentId: "session", title: S1.identity.name, closable: true },
      { id: S2.id, componentId: "session", title: S2.identity.name, closable: true },
      { id: S3.id, componentId: "session", title: S3.identity.name, closable: true },
      placeholderCard(TIDES),
      placeholderCard(README),
      ...rails.cards,
    ],
    // Slot 1 is split, picker-keys above edge-insert; in slot 2 the last pane stands in front, tides.ts over README.md over glyph-font.
    panes: [kindPane("session", S2.id, 0), kindPane("session", S1.id, 0), kindPane("session", S3.id, 1), kindPane("text", README.id, 1), kindPane("text", TIDES.id, 1), ...rails.panes],
    activePaneId: `${S1.id}-pane`,
    imposition: {
      kind: "two-up",
      layout: "flow",
      contentWidth: "slim",
      columns: { 0: { mode: "split", order: [`${S1.id}-pane`, `${S2.id}-pane`] } },
      sidebars: rails.sidebars,
      rails: rails.rails,
    },
    hasFocus: true,
  };
}

/** The arcs' repository: a scratch repo moved under a parent whose basename is `tug`, since the masthead and the rows print the directory's last segment. */
function arcRepository(parent: string): ArcScratchRepo {
  const scratch = makeArcScratchRepo({ prefix: "vd-sidebar", checkout: CHECKOUT });
  const repo = join(parent, "tug");
  renameSync(scratch.repo, repo);
  return { ...scratch, repo };
}

/** A task list with the arc's step titles, in the fixture's grammar. */
function tasks(arc: Arc): string {
  let doc = fixturePlanDocument(arc.steps.length);
  const fixtureTitles = ["The only step", "The second step", "The third step", "The fourth step", "The fifth step", "The sixth step", "The seventh step", "The eighth step"];
  arc.steps.forEach((title, i) => {
    doc = doc.split(fixtureTitles[i]!).join(title);
  });
  return doc;
}

/** Make `arc`, walk its task list through the real verbs to where it stood, and leave the wheel's record. */
function stageArc(scratch: ArcScratchRepo, arc: Arc): void {
  createArc(scratch.repo, arc.name, arc.name.split("-").join(" "), scratch.cli);
  writeFileSync(arcBriefPath(scratch.repo, arc.name), `# ${arc.name}\n`);
  writeFileSync(arcTasksPath(scratch.repo, arc.name), tasks(arc));
  const step = (...args: string[]): void => {
    tugtool(["arc", "step", arc.name, ...args], { cwd: scratch.repo, binaryRoot: scratch.cli.binaryRoot, env: scratch.cli.env });
  };
  const through = String(arc.steps.length);
  for (let n = 1; n <= arc.done; n++) {
    step("start", String(n), "--through", through);
    step("done", String(n));
  }
  if (arc.done < arc.steps.length) step("start", String(arc.done + 1), "--through", through);
  const log = arcLogPath(scratch.dataRoot);
  appendArcLogLine(log, arc.name, "arc-start", `.tug/arcs/${arc.name}/tasks.md`);
  appendArcLogLine(log, arc.name, "arc-kind", "plain");
}

/** Copy a committed fixture transcript into `repo`'s Claude project directory under `sessionId`, each row's `cwd` moved to the repo, so `claude --resume` finds it there. */
function transplant(fixture: string, repo: string, sessionId: string): void {
  const lines = readFileSync(fixturePath(fixture), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if ("cwd" in row) row.cwd = repo;
        if ("sessionId" in row) row.sessionId = sessionId;
        return JSON.stringify(row);
      } catch {
        return line;
      }
    });
  const dir = claudeProjectDir(repo);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
  onTestRunEnd(() => rmSync(dir, { recursive: true, force: true }));
}

/** Resume `s`'s transcript into its card on `repo`, wait for it to settle, and publish its identity (as `_placeholders.ts` does). Returns the session id. */
async function bindSession(app: App, s: Session, repo: string): Promise<string> {
  const tugSessionId = randomUUID();
  transplant(s.fixture, repo, tugSessionId);
  const deadline = Date.now() + BOUND_MS;
  while (!(await app.bodies()).some((b) => b.cardId === s.id && b.state === "ready")) {
    if (Date.now() > deadline) throw new Error(`${s.id}: no ready body within ${BOUND_MS} ms`);
    await Bun.sleep(100);
  }
  const body = app.body(s.id);
  await app.spawnSessionResume(s.id, { tugSessionId, projectDir: repo });
  note(`${s.id}: resume spawned`);
  const host = `[data-card-id="${s.id}"] [data-testid="session-card-transcript"]`;
  const scroller = `[data-card-id="${s.id}"] [data-tug-scroll-key="session-card-transcript"]`;
  await body.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(host)}) !== null && document.querySelector('[data-card-id="${s.id}"] .session-card-picker-form') === null`,
    { timeoutMs: BOUND_MS },
  );
  note(`${s.id}: transcript hosted`);
  await body.waitForCondition<boolean>(
    `(function(){
      var host = document.querySelector(${JSON.stringify(host)});
      var el = document.querySelector(${JSON.stringify(scroller)});
      if (host === null || el === null || host.hasAttribute("data-replaying")) return false;
      var seen = window.__tugVideoSettle || (window.__tugVideoSettle = {});
      var now = performance.now(), last = seen[${JSON.stringify(s.id)}];
      if (last === undefined || last.height !== el.scrollHeight) {
        seen[${JSON.stringify(s.id)}] = { height: el.scrollHeight, at: now };
        return false;
      }
      return now - last.at >= ${SETTLE_HOLD_MS};
    })()`,
    { timeoutMs: BOUND_MS },
  );
  const row = { session_id: tugSessionId, project_dir: repo, ...s.identity, ...s.facts };
  note(`${s.id}: settled`);
  const push = `window.__tug.publishSessionUpdated(${JSON.stringify(JSON.stringify({ session_id: tugSessionId, fields: row }))})`;
  await app.evalJS<boolean>(push);
  // A rail body can be replaced while a session registers its workspace, so a push that finds no body is retried once the bodies settle.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      for (const b of await app.bodies()) {
        if (b.state === "ready" && b.cardId !== null) await app.body(b.cardId).evalJS<boolean>(push);
      }
      break;
    } catch (error) {
      note(`identity push retried: ${String(error)}`);
      await Bun.sleep(1_000);
    }
  }
  const masthead = `(document.querySelector('[data-slot="session-masthead"]') || { textContent: "" }).textContent || ""`;
  note(`${s.id}: pushed`);
  await settleFor(() => body.evalJS<string>(masthead), (t) => t.includes(s.identity.name), 5_000);
  return tugSessionId;
}

/** The centre of an element of `cardId`'s body, in window points. */
async function centerOf(app: App, cardId: string, selector: string): Promise<{ x: number; y: number }> {
  const r = await app.elementRect(cardId, selector);
  if (r === null) throw new Error(`${cardId}: nothing at ${selector}`);
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Drag from one body element to another, at the video's pace, with a held beat before the release so the page under the pointer takes the drop. */
async function dragBetween(app: App, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await nativeDrag(app, from, to, { interpolationSteps: DRAG_STEPS, interpolationDelayMs: DRAG_STEP_MS, mouseDownDelayMs: PRESS_MS, mouseUpDelayMs: 300 });
}

async function publish(app: App, post: WirePost): Promise<void> {
  await app.body(OVERVIEW).evalJS<boolean>(`window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(post))})`);
}

/** Type `text` a word at a time, each word after the last has landed: in the foreground the keystrokes go through the system queue, so two overlapping `nativeType` calls interleave their letters. */
async function typeSlowly(app: App, text: string, wordMs = 90): Promise<void> {
  const words = text.split(" ");
  for (let i = 0; i < words.length; i++) {
    await app.nativeType(i === 0 ? words[i]! : ` ${words[i]}`);
    await Bun.sleep(wordMs);
  }
}

describe.skipIf(!RUNS)("video: the sidebar cards", () => {
  test(
    "records the five sidebar cards at work, timed to the narration",
    async () => {
      const parent = realpathSync(mkdtempSync(join(tmpdir(), "vd-sidebar-")));
      onTestRunEnd(() => rmSync(parent, { recursive: true, force: true }));
      const scratch = arcRepository(parent);
      onTestRunEnd(() => rmArcScratchRepo(scratch));
      for (const s of [S1, S2]) stageArc(scratch, s.arc!);

      const settings = placeholderSettings();
      const harbor = settings.find(([, key]) => key === "default-project-path")![2];
      const app = await launchForMode("vd-sidebar-cards", deck(), undefined, {
        contentSize: CONTENT_SIZE,
        env: { ...railsEnv(JOTS_TEXT), TUG_DATA_DIR: scratch.dataRoot },
        cardStates: placeholderStates(FILES),
        settings,
        foreground: true,
      });
      try {
        const granted = await app.setWindowContentSize(CONTENT_SIZE);
        expect(granted, "the display grants the window").toEqual(CONTENT_SIZE);
        await app.setPageZoom(PAGE_ZOOM);
        await Bun.sleep(1_000);
        note("standing up the rails");
        await standUpRails(app, RAIL_PREFIX);

        // Stand the back cards up first, each fronted for its stand-up, then the front ones.
        const focus = (cardId: string) => () => app.dispatchControlAction("focus-pane", { paneId: `${cardId}-pane` });
        await focus(S2.id)();
        note("binding edge-insert");
        const sid2 = await bindSession(app, S2, scratch.repo);
        await focus(S3.id)();
        note("binding glyph-font");
        const sid3 = await bindSession(app, S3, scratch.repo);
        await focus(README.id)();
        note("standing up the files");
        await standUpPlaceholders(app, [README]);
        await focus(TIDES.id)();
        await standUpPlaceholders(app, [TIDES]);
        await focus(S1.id)();
        note("binding picker-keys");
        const sid1 = await bindSession(app, S1, scratch.repo);

        // Each arc's seat, with the stage line the wheel writes when it seats one.
        const log = arcLogPath(scratch.dataRoot);
        for (const [s, sid] of [[S1, sid1], [S2, sid2]] as const) {
          bindArc(scratch.repo, s.arc!.name, sid, scratch.cli);
          appendArcLogLine(log, s.arc!.name, "arc-stage", `implement ${sid} opus`);
        }
        for (const s of [S1, S2]) {
          await app.body(ARCS).waitForCondition<boolean>(`document.querySelector(${JSON.stringify(arcsRow(s.arc!))}) !== null`, { timeoutMs: 30_000 });
        }
        await app.body(OVERVIEW).waitForCondition<boolean>(`document.querySelector(${JSON.stringify(OVERVIEW_TRANSCRIPT)}) !== null`, { timeoutMs: 15_000 });

        // Under the app-test gate the Operator has no model, so a question sent from the composer is answered at once with a transient
        // "couldn't answer that"; the video's own answer is published instead, and the transient's row is kept off the screen.
        await app.body(OVERVIEW).evalJS<boolean>(`(function(){
          function hide(){
            document.querySelectorAll('[data-testid="overview-card"] .overview-cell').forEach(function(el){
              if (el.getAttribute("data-author") === "operator" && (el.textContent || "").indexOf("t answer that") !== -1) el.style.display = "none";
            });
          }
          new MutationObserver(hide).observe(document.body, { childList: true, subtree: true, characterData: true });
          return true;
        })()`);
        await focus(S1.id)();
        await Bun.sleep(1_500);
        const rest = await standIns(app);
        for (const id of [S1.id, TIDES.id]) expect(rest[id], `${id} stands in the deck`).toBeDefined();

        const now = Date.now();
        const post = (p: Omit<WirePost, "at_ms">, agoMs: number) => () => publish(app, { at_ms: now - agoMs, ...p });
        // The "here it is" ring: `focus-session-card` fronts a card and lights the accent ring on its whole border.
        const ring = (cardId: string) => () => app.dispatchControlAction("focus-session-card", { cardId });
        // The video's own wash: a brief accent-coloured veil over the card's frame, sized to the pane the card's page draws (never the
        // page, which runs past the frame), fading in about two thirds of a second.
        const face = (cardId: string, ring = false) => () =>
          app.body(cardId).evalJS<boolean>(`(function(){
            var pane = document.querySelector(".tug-pane");
            if (pane === null) return false;
            var r = pane.getBoundingClientRect();
            var el = document.getElementById("vd-face-flash");
            if (el === null) {
              el = document.createElement("div");
              el.id = "vd-face-flash";
              el.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;background:var(--tug7-element-global-border-normal-accent-rest,#ff8800);opacity:0;";
              document.body.appendChild(el);
            }
            el.style.left = r.left + "px";
            el.style.top = r.top + "px";
            el.style.width = r.width + "px";
            el.style.height = r.height + "px";
            el.style.borderRadius = getComputedStyle(pane).borderRadius;
            el.style.boxShadow = ${ring ? '"inset 0 0 0 2px var(--tug7-element-global-border-normal-accent-rest,#ff8800)"' : '"none"'};
            el.style.transition = "none";
            el.style.opacity = "0.5";
            requestAnimationFrame(function(){ requestAnimationFrame(function(){ el.style.transition = "opacity ${ring ? 900 : 650}ms ease-out"; el.style.opacity = "0"; }); });
            return true;
          })()`);
        // A sidebar card named in the narration gets both: the ring on its border and the wash over its face.
        const highlight = (cardId: string) => () => Promise.all([ring(cardId)(), face(cardId)()]).then(() => undefined);
        // All five at once, on "pin to the edges": the app rings one card at a time, so the wash carries its own ring here.
        const highlightAll = () => Promise.all(RAIL_CARDS.map((id) => face(id, true)())).then(() => undefined);

        // ---- Burst A: the rails, the Overview, Arcs, Jots ----
        const A = (audioSecs: number) => Math.round((audioSecs - CLIP_AT) * 1000);
        const a = scene().mark("loop-start", 0);
        // "Sidebar cards pin to the edges of the canvas": both rails stand from the first frame, and all five cards flash together.
        a.at(A(1.5), highlightAll);
        // "…keep track of everything going on in the app": the feed is already moving.
        a.at(A(5.0), post({ id: 9001, author: "observer", body: `^${S2.arc!.name} closed its third step: the edge defaults to Bottom now, and the slider's range is clamped to the frame.`, refs: [], session_id: sid2, wake_reason: "sitrep", project_dir: scratch.repo }, 900_000));
        // "Overview is a feed that narrates what every session is doing, across every project"
        a.at(A(6.9), highlight(OVERVIEW));
        a.at(A(7.7), post({ id: 9002, author: "observer", body: `^${S1.arc!.name} is on its third step: Return opens a folder row, and the walk no longer skips a collapsed branch.`, refs: [], session_id: sid1, wake_reason: "sitrep", project_dir: scratch.repo }, 600_000));
        a.at(A(9.5), post({ id: 9003, author: "observer", body: "edge-insert is verifying the template in Motion: the build-in lands on the Overlap value the slider sets.", refs: [], session_id: sid2, wake_reason: "sitrep", project_dir: scratch.repo }, 240_000));
        a.at(A(10.9), post({ id: 9004, author: "observer", body: "harbor: fetch_tides.py retries a failed NOAA fetch twice before it gives up, and the tide table rounds to the minute.", refs: [], wake_reason: "sitrep", project_dir: harbor }, 90_000));
        // "…and I can ask it questions": the question is typed in the Overview's composer and sent (the Operator echoes it as a post), then the answer.
        a.at(A(10.9), () => app.body(OVERVIEW).nativeClickAtElement(OVERVIEW_FIELD));
        a.at(A(11.1), () => typeSlowly(app, QUESTION));
        // Sent with the composer's own chord (⇧⏎ at the shipped `newline` setting), the keyboard path a person takes.
        a.at(A(12.5), () => app.nativeKey("Return", ["shift"]));
        // Stamped when it lands, so it reads after the question's echo.
        a.at(A(13.7), () => publish(app, { id: 9006, at_ms: Date.now(), author: "operator", body: ANSWER, refs: [], session_id: sid3, project_dir: scratch.repo, request_id: "vd-sb-a1", elapsed_ms: 1_200 }));
        // "Arcs is for long-running projects": a row folds open to its steps, then the other.
        a.at(A(14.4), highlight(ARCS));
        a.at(A(15.0), () => app.body(ARCS).nativeClickAtElement(foldCue(S2.arc!)));
        a.at(A(16.4), () => app.body(ARCS).nativeClickAtElement(foldCue(S1.arc!)));
        // "Jots is for reusable text fragments for prompts": the tokei jot is dragged from the Jots card into picker-keys' prompt composer, beside it.
        a.at(A(17.3), highlight(JOTS));
        a.at(A(18.0), async () => {
          const label = await app.elementRect(JOTS, jotLabel(DRAGGED_JOT));
          if (label === null) throw new Error(`${JOTS}: no row ${DRAGGED_JOT}`);
          const from = { x: label.x + Math.min(24, label.width / 2), y: label.y + label.height / 2 };
          const to = await centerOf(app, S1.id, PROMPT_INPUT);
          // The window capture does not include the system's drag image, so the video draws its own: a pill with the jot's text, moving on the
          // drag's own line at the drag's pace, in the Jots page and in the session's, each clipping it at its edge.
          const frames = Object.fromEntries((await app.bodies()).filter((b) => b.cardId === JOTS || b.cardId === S1.id).map((b) => [b.cardId, b.frame]));
          const font = await app.body(JOTS).evalJS<string>(`getComputedStyle(document.querySelector(${JSON.stringify(jotLabel(DRAGGED_JOT))})).font`);
          const travelMs = DRAG_STEPS * DRAG_STEP_MS;
          const ghost = (cardId: string) => {
            const f = frames[cardId]!;
            // A body page's CSS pixels are window points from the body's origin; the zoom does not enter.
            const css = (p: { x: number; y: number }) => ({ x: p.x - f.x, y: p.y - f.y });
            const [p0, p1] = [css(from), css(to)];
            const grab = from.x - label.x;
            return app.body(cardId).evalJS<boolean>(`(function(){
              var el = document.createElement("div");
              el.textContent = ${JSON.stringify(JOTS_TEXT[1])};
              el.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;white-space:nowrap;box-sizing:content-box;padding:4px 10px;border:1px solid var(--tug7-element-global-border-normal-default-rest);border-radius:6px;background:var(--tug7-surface-popover-primary-normal-default-rest);color:var(--tug7-element-global-text-normal-default-rest);transform-origin:left center;transform:translateY(-50%) scale(${PAGE_ZOOM});font:" + ${JSON.stringify(font)} + ";";
              el.style.left = "${p0.x - grab}px"; el.style.top = "${p0.y}px";
              document.body.appendChild(el);
              el.animate([{ left: "${p0.x - grab}px", top: "${p0.y}px" }, { left: "${p1.x - grab}px", top: "${p1.y}px" }], { duration: ${travelMs}, delay: ${PRESS_MS}, easing: "linear", fill: "forwards" });
              setTimeout(function(){ el.style.transition = "opacity 120ms"; el.style.opacity = "0"; setTimeout(function(){ el.remove(); }, 150); }, ${PRESS_MS + travelMs + 280});
              return true;
            })()`);
          };
          await Promise.all([ghost(JOTS), ghost(S1.id)]);
          await dragBetween(app, from, to);
          await Bun.sleep(800);
          note("s1 composer", await app.body(S1.id).evalJS<string>(`(document.querySelector(${JSON.stringify(PROMPT_INPUT)}) || { textContent: "" }).textContent`));
        });
        a.mark("loop-end", A(BURST_SPLIT));
        const readingA = await a.record(app, { outDir: outDirFor("sidebar-cards-a"), settleMs: 300 });
        expectRecorded(readingA);

        // ---- Burst B: Layout, the miniature, Workspaces ----
        const B = (audioSecs: number) => Math.round((audioSecs - BURST_SPLIT) * 1000);
        const b = scene().mark("loop-start", 0);
        // "Layout gives controls for the deck": Width to Comfy, and back to Slim.
        b.at(B(21.7), highlight(LAYOUT));
        b.at(B(21.9), () => app.body(LAYOUT).nativeClickAtElement(widthChoice("comfy")));
        b.at(B(23.2), () => app.body(LAYOUT).nativeClickAtElement(widthChoice("slim")));
        // "…a live interactive miniature of all my cards": a press flashes the lower session; the upper session is dragged onto slot 2, and the deck
        // follows (it stands in front of the files, and edge-insert has slot 1 to itself); then slot 2's front card is dragged home.
        b.at(B(24.4), () => app.body(LAYOUT).nativeClickAtElement(miniMember(0, 1)));
        const where = async (label: string): Promise<void> => {
          const r = await standIns(app);
          note(label, JSON.stringify(Object.fromEntries(Object.entries(r).map(([id, v]) => [id, v === undefined ? null : { x: Math.round((v as { x: number }).x), y: Math.round((v as { y: number }).y) }]))));
        };
        b.at(B(25.3), async () => {
          const from = await centerOf(app, LAYOUT, miniMember(0, 0));
          const to = await centerOf(app, LAYOUT, miniBlock(1));
          note("mini drag 1", JSON.stringify({ from, to }));
          await dragBetween(app, from, to);
          await Bun.sleep(900);
          await where("after mini drag 1");
        });
        b.at(B(27.0), async () => {
          const from = await centerOf(app, LAYOUT, miniBlock(1));
          const to = await centerOf(app, LAYOUT, miniSlot(0));
          note("mini drag 2", JSON.stringify({ from, to }));
          await dragBetween(app, from, to);
          await Bun.sleep(900);
          await where("after mini drag 2");
        });
        // "Workspaces is a list of everything open, with one row per card": rows clicked front their cards.
        b.at(B(29.3), highlight(CARDS));
        b.at(B(30.0), () => app.body(CARDS).nativeClickAtElement(workspaceRow(sid2)));
        b.at(B(31.6), () => app.body(CARDS).nativeClickAtElement(workspaceRow(README.id)));
        // "…the best way to jump around between cards and projects"
        b.at(B(34.4), () => app.body(CARDS).nativeClickAtElement(workspaceRow(sid1)));
        b.at(B(35.5), () => app.body(CARDS).nativeClickAtElement(workspaceRow(TIDES.id)));
        b.at(B(36.5), () => app.body(CARDS).nativeClickAtElement(workspaceRow(sid2)));
        b.mark("loop-end", B(CLIP_END));
        const readingB = await b.record(app, { outDir: outDirFor("sidebar-cards-b"), settleMs: 300 });
        expectRecorded(readingB);

        const after = await standIns(app);
        for (const id of [S2.id, TIDES.id]) expect(after[id], `${id} stands in front`).toBeDefined();
        for (const [name, reading, from, to] of [
          ["sidebar-cards-a", readingA, CLIP_AT, BURST_SPLIT],
          ["sidebar-cards-b", readingB, BURST_SPLIT, CLIP_END],
        ] as const) {
          writeFileSync(
            join(outDirFor(name), "shot.json"),
            JSON.stringify({ shot: name, mode: MODE, audioOffsetSecs: from, audioEndSecs: to, contentSize: await contentSize(app), marks: reading.marks, frames: reading.frames, scale: reading.scale }, null, 2),
          );
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
