/**
 * at0561-narration-annotation.test.ts — a file named in the Session
 * masthead's narration line is a reference, not ink.
 *
 * The masthead's middle line carries the Observer's post during a turn, and a
 * post is prose written about the session — which means it names the files the
 * work touched. It used to render as a plain string: the path was inert, its
 * backticks were three literal characters, and the one surface most likely to
 * name a file was the one surface that could not open one.
 *
 * Three claims, in the order they build on each other:
 *
 *  1. The path in the post is a real annotation, and hovering it raises the
 *     app's file bubble carrying the RESOLVED absolute path. The post names
 *     the file relative to the project, exactly as an agent writes it, so the
 *     bubble states the fact the prose elided rather than repeating what it
 *     said.
 *  2. The bubble that stands is the RUN's, not the line's. The description
 *     line wraps itself in a full-text tooltip for when it elides, so the run
 *     sits inside a trigger — and `lib/open-tooltip-registry` arbitrates on
 *     specificity, so the bubble describing the smaller thing the pointer is
 *     actually on wins. That rule is at0458's; this is a second instance of
 *     it, and the reason the masthead needed no gate of its own.
 *  3. A primary click opens the file. The masthead has mounted the delegated
 *     annotation layer since at0498 pinned the beat line's reference, so the
 *     marks the description now carries are serviced by the same listener.
 *
 * The post is long enough that the line cannot show it whole — that is what
 * arms the outer tooltip under claim 2, since it only opens over an element
 * that is actually clipped. Seeded through `publishOverviewPost` and a kinded
 * `publishDigestFrame`, the same doors at0551 uses: no live Observer, and the
 * turn in flight is what makes the post the rung the ladder climbs to.
 *
 * @covers tugdeck/src/components/tugways/session-identity-row.tsx
 * @covers tugdeck/src/components/tugways/session-masthead.tsx
 * @covers tugdeck/src/components/tugways/tug-markdown-text.tsx
 * @covers tugdeck/src/components/tugways/annotation-scope.tsx
 * @covers tugdeck/src/components/tugways/use-annotation-context.ts
 * @covers tugdeck/src/components/tugways/file-tip-portals.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

// UUID-shaped so the bound session reads as a real one.
const SID = "a7c0d1ea-0000-4000-8000-000000000561";

const PANE = '.tug-pane[data-pane-id="p1"]';
const MASTHEAD = `${PANE} [data-slot="session-masthead"]`;
const DESCRIPTION = `${PANE} .session-masthead-row .tug-session-row-description`;
/** The path run the annotator marked inside the narration line. */
const DESC_REF = `${DESCRIPTION} [data-tug-annotation="file-path"]`;
const TEXT_CARD = '[data-slot="tug-text-card-editor"] .cm-content';

/** How the post names the file: project-relative, as an agent writes it. */
const REL_PATH = "docs/narration-target.md";
const FILE_BODY = ["alpha", "the-narration-target-body", "omega"].join("\n");

/**
 * A post no single line of the tier can show whole — the clipping is what
 * lets the line's own full-text tooltip open at all, and claim 2 is empty
 * without a competitor. The path rides the middle of the sentence, where a
 * reader would meet it.
 */
const POST_BODY = `Resolved the tape-centring question by rewriting ${REL_PATH} so the strip's lift can learn the group's true height, then re-ran the column tests at both slim and wide widths.`;

/** A beat with a kind, which is what puts the turn in flight. */
const BEAT_TEXT = "Running the column tests";

let projectDir = "";
let filePath = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0561-proj-")));
  mkdirSync(join(projectDir, "docs"), { recursive: true });
  filePath = join(projectDir, REL_PATH);
  writeFileSync(filePath, FILE_BODY, "utf8");
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session A", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 820, height: 620 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/** One DIGEST frame body, scoped to this session, as the emitter writes it. */
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

/** One Observer post about this session, as the OVERVIEW feed carries it. */
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

/**
 * How many bubbles are showing. A closing Radix tooltip stays mounted for its
 * exit animation, so the count is of bubbles NOT in the closed state — at0458's
 * reading, for the same reason.
 */
const OPEN_BUBBLES =
  'document.querySelectorAll(\'[data-slot="tug-tooltip"]:not([data-state="closed"])\').length';

/** Whether any open Text card is showing `needle`. */
const textCardShowsJS = (needle: string) => `(function(){
  return Array.from(document.querySelectorAll(${JSON.stringify(TEXT_CARD)}))
    .some(function(el){ return (el.textContent || "").indexOf(${JSON.stringify(needle)}) !== -1; });
})()`;

/**
 * Well past the open delay (900ms), because claim 2's interesting half is a
 * NEGATIVE one — a shorter wait would prove only that the line's bubble had
 * not arrived yet.
 */
const PAST_THE_DELAY_MS = 2500;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

describe.skipIf(!SHOULD_RUN)(
  "AT0561: the narration line's file reference hovers and opens",
  () => {
    test(
      "a path in the Observer's post raises its own bubble and opens the file",
      async () => {
        const app = await launchTugApp({
          testName: "at0561-narration-annotation",
        });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", { tugSessionId: SID, projectDir });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(MASTHEAD)}) !== null`,
            { timeoutMs: 20_000 },
          );

          // A turn in flight, then the post that takes the description line.
          await app.evalJS<boolean>(
            `window.__tug.publishDigestFrame(${JSON.stringify(
              digestFrame(BEAT_TEXT, 1, "tool"),
            )})`,
          );
          await app.evalJS<boolean>(
            `window.__tug.publishOverviewPost(${JSON.stringify(
              observerPost(POST_BODY, 1),
            )})`,
          );

          // 1. The path becomes a real annotation. The verdict arrives from
          //    the host a beat after the ink is painted, so the wait is for the
          //    CONFIRMED mark rather than merely for the line to carry the
          //    sentence.
          await app.waitForCondition<boolean>(
            `(function(){
               var el = document.querySelector(${JSON.stringify(DESC_REF)});
               return el !== null && el.getAttribute('data-path') === ${JSON.stringify(filePath)};
             })()`,
            { timeoutMs: 20_000 },
          );
          const ref = JSON.parse(
            await app.evalJS<string>(`JSON.stringify((function(){
              var el = document.querySelector(${JSON.stringify(DESC_REF)});
              var line = document.querySelector(${JSON.stringify(DESCRIPTION)});
              return {
                path: el.getAttribute('data-path'),
                ink: (el.textContent || ""),
                clipped: line.scrollWidth > line.clientWidth ||
                         line.scrollHeight > line.clientHeight,
              };
            })())`),
          ) as Record<string, unknown>;
          note("at0561 narration ref", JSON.stringify(ref));
          expect(ref.path).toBe(filePath);
          // The ink is what the post wrote; the absolute path is the bubble's.
          expect(ref.ink).toBe(REL_PATH);
          // The competitor for claim 2 is only armed over a clipped line.
          expect(ref.clipped, "the narration line is showing less than it holds").toBe(
            true,
          );

          // Hover the run. Its `pointermove` bubbles to the description line's
          // own tooltip trigger too, arming both open timers in one tick.
          await app.evalJS<null>(
            `(function () {
              var host = document.querySelector(${JSON.stringify(DESC_REF)});
              // The portal put the run's words back inside a span of its own,
              // and that span is the tooltip's trigger.
              var run = host.firstElementChild || host;
              run.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
              run.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
              return null;
            })()`,
          );
          await wait(PAST_THE_DELAY_MS);

          // 2. One bubble, and it is the run's — the specificity rule, met
          //    here rather than built here.
          expect(
            await app.evalJS<number>(OPEN_BUBBLES),
            "bubbles standing after hovering the path in the narration line",
          ).toBe(1);
          const bubble = JSON.parse(
            await app.evalJS<string>(`JSON.stringify((function(){
              var host = document.querySelector(${JSON.stringify(DESC_REF)});
              var run = host.firstElementChild || host;
              var id = run.getAttribute("aria-describedby");
              var announced = id === null ? null : document.getElementById(id);
              var standing = document.querySelector(
                '[data-slot="tug-tooltip"]:not([data-state="closed"])');
              return {
                runOwnsIt: announced !== null &&
                  announced.closest('[data-slot="tug-tooltip"]') !== null,
                text: standing === null ? "" : (standing.textContent || ""),
              };
            })())`),
          ) as Record<string, unknown>;
          note("at0561 standing bubble", JSON.stringify(bubble));
          expect(bubble.runOwnsIt, "the standing bubble is the path run's").toBe(true);
          // And it states the resolved absolute path — the fact the prose elided.
          expect(bubble.text).toContain(filePath);

          // 3. A primary click opens what the run names.
          await app.click(DESC_REF);
          await app.waitForCondition<boolean>(
            textCardShowsJS("the-narration-target-body"),
            { timeoutMs: 20_000 },
          );

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0561] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
