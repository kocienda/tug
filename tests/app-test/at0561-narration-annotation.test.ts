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
 * Claims, in the order they build on each other:
 *
 *  1. The path in the post is a real annotation, and hovering it raises the
 *     app's file bubble carrying the RESOLVED absolute path. The post names
 *     the file relative to the project, exactly as an agent writes it, so the
 *     bubble states the fact the prose elided rather than repeating what it
 *     said.
 *  1b. A path the post BACKTICKED is a `<code>` run, and no literal backtick
 *     survives anywhere in the line's text. The line renders through the same
 *     `TugMarkdownBlock` the Overview post does ([B01] of the narration-one
 *     brief), so the backticks are CONSUMED rather than spelled out. A styler
 *     that keeps syntax visible passes every other claim here and fails this
 *     one, which is the difference the arc was about.
 *
 *     The post names two paths for that reason: the claims above need a run
 *     the annotator WRAPPED (only a wrapped span is emptied and given the
 *     file tip — `file-tip-portals` skips a mark it merely adopted, because
 *     emptying an element the author wrote would take its content with it),
 *     and this claim needs one the markdown pipeline built. Both are paths in
 *     one sentence, which is how an agent writes about work anyway.
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
 * Then two claims about what else can stand in that line, in a second test
 * bound to this checkout — a real repository, where a sha resolves:
 *
 *  4. A post naming a commit renders the PILL, whole: its rect sits inside
 *     the line's rect, top and bottom. The line is set in the loose band for
 *     exactly this ([B06], [B07]) — an atom is 22px tall and the tight band
 *     is 15.6, so the pill used to be cut at both ends on the one surface
 *     most likely to name a commit.
 *  5. A beat carrying a raw ESC byte draws none of it. The digester scrubs
 *     the sequences at the source ([B04]) and the deck strips what the ledger
 *     already holds at both ingress doors ([B05]), so what reaches the line is
 *     text — no `U+001B`, and no CSI residue reading as tofu.
 *
 * The post is long enough that the line cannot show it whole — that is what
 * arms the outer tooltip under claim 2, since it only opens over an element
 * that is actually clipped — and what it has to be too long for is the
 * tier's TWO lines, set in the loose band ([B07] of the narration-one
 * brief), which is a line tall enough to hold a commit pill whole. The post
 * grew when that band landed, for that reason and no other: the shorter one
 * fit the pair and left the competitor unarmed.
 * Seeded through `publishOverviewPost` and a kinded
 * `publishDigestFrame`, the same doors at0551 uses: no live Observer, and the
 * turn in flight is what makes the post the rung the ladder climbs to.
 *
 * @covers tugdeck/src/components/tugways/session-identity-row.tsx
 * @covers tugdeck/src/components/tugways/session-masthead.tsx
 * @covers tugdeck/src/components/tugways/tug-markdown-block.tsx
 * @covers tugdeck/src/components/tugways/tug-session-row.css
 * @covers tugdeck/src/components/tugways/annotation-scope.tsx
 * @covers tugdeck/src/components/tugways/use-annotation-context.ts
 * @covers tugdeck/src/components/tugways/file-tip-portals.tsx
 * @covers tugdeck/src/lib/digest-store.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
/** The commit pill the annotator mounted inside the narration line. */
const DESC_PILL = `${DESCRIPTION} [data-slot="tug-commit-atom"]`;
/** The beat, under the description — the run a digest line lands on. */
const BEAT = `${PANE} .session-masthead-row [data-slot="tug-activity-line-activity"]`;
const TEXT_CARD = '[data-slot="tug-text-card-editor"] .cm-content';

/**
 * How the post names the file the bubble is about: project-relative and bare,
 * so the annotator WRAPS it in a span of its own and the file tip can portal
 * into it. The backticked path claim 1b reads is the constant below.
 */
const REL_PATH = "docs/narration-target.md";
/**
 * A second path, this one BACKTICKED, for claim 1b. It names nothing on disk
 * in the temp project and does not need to: what is under test is that the
 * pipeline built a code run and ate the backticks.
 */
const CODE_PATH = "tests/app-test/at0551-session-fold-form.test.ts";
const FILE_BODY = ["alpha", "the-narration-target-body", "omega"].join("\n");

/**
 * A post no single line of the tier can show whole — the clipping is what
 * lets the line's own full-text tooltip open at all, and claim 2 is empty
 * without a competitor. The path rides the middle of the sentence, where a
 * reader would meet it.
 */
const POST_BODY = `Resolved the tape-centring question by rewriting ${REL_PATH} so the strip's lift can learn the group's true height, then re-ran \`${CODE_PATH}\` at both slim and wide widths, walked the wall's packing at three folds, and left the imposition's ceiling ladder alone until the allocator's own numbers can be read beside it.`;

/** A beat with a kind, which is what puts the turn in flight. */
const BEAT_TEXT = "Running the column tests";

/**
 * This checkout — the app-test bootstrap workspace, and a real git repo, so a
 * sha written into a post is one the resolver can confirm. The temp project
 * the first test owns has no history and no commit to name.
 */
const CHECKOUT = resolve(import.meta.dir, "..", "..");
const HEAD_SHA = execSync("git rev-parse HEAD", { cwd: CHECKOUT })
  .toString()
  .trim();
/** The short form prose uses — deliberately not the label's eight. */
const WRITTEN_SHA = HEAD_SHA.slice(0, 9);

/** A post that names a commit, the way an agent reports a landed step. */
const COMMIT_POST = `Landed the leading floor as \`${WRITTEN_SHA}\` after re-running the column tests at both widths.`;

/** ESC, spelled rather than pasted, so this file carries no control byte. */
const ESC = String.fromCharCode(27);
/**
 * A beat as a colouring producer emits one: SGR in, SGR out, and a sentence
 * between them. What must reach the line is the sentence.
 */
const ESC_BEAT = `Running ${ESC}[35mcargo nextest run${ESC}[0m`;

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
                // The backticked path's run, whatever else the line holds.
                codeInk: (function(){
                  var code = line.querySelector('code');
                  return code === null ? null : (code.textContent || "");
                })(),
                // Counted with a spelled backtick: this probe is a template
                // literal, and a written one would end it.
                backticks: (line.textContent || "")
                  .split(String.fromCharCode(96)).length - 1,
                clipped: line.scrollWidth > line.clientWidth ||
                         line.scrollHeight > line.clientHeight,
              };
            })())`),
          ) as Record<string, unknown>;
          note("at0561 narration ref", JSON.stringify(ref));
          expect(ref.path).toBe(filePath);
          // The ink is what the post wrote; the absolute path is the bubble's.
          expect(ref.ink).toBe(REL_PATH);
          // 1b. The backticked path is a `<code>` run and the line CONSUMED
          //     the backticks — none survives anywhere in its text. This is
          //     the whole difference between the pipeline the Overview reads
          //     in and the styler this line used to use, which showed the
          //     syntax on purpose ([B01], [B03]).
          expect(ref.codeInk, "the backticked path is a <code> run").toBe(CODE_PATH);
          expect(ref.backticks, "the line spells no backtick").toBe(0);
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

    test(
      "a commit in the post stands whole in the line, and an ESC byte draws nothing",
      async () => {
        const app = await launchTugApp({
          testName: "at0561-narration-annotation-atoms",
        });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          // Bound to THIS repository, where the sha below is a commit rather
          // than a hex word the resolver declines.
          await app.bindSession("A", { tugSessionId: SID, projectDir: CHECKOUT });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(MASTHEAD)}) !== null`,
            { timeoutMs: 20_000 },
          );

          // The beat carries the escapes; the post carries the sha. One frame
          // each, and the turn the beat puts in flight is what lets the post
          // take the description line.
          await app.evalJS<boolean>(
            `window.__tug.publishDigestFrame(${JSON.stringify(
              digestFrame(ESC_BEAT, 1, "tool"),
            )})`,
          );
          await app.evalJS<boolean>(
            `window.__tug.publishOverviewPost(${JSON.stringify(
              observerPost(COMMIT_POST, 1),
            )})`,
          );

          // 4. The pill arrives — the verdict is a round trip to the git feed,
          //    so the wait is for the mounted atom rather than for the prose.
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(DESC_PILL)}) !== null`,
            { timeoutMs: 20_000 },
          );
          const pill = JSON.parse(
            await app.evalJS<string>(`JSON.stringify((function(){
              var line = document.querySelector(${JSON.stringify(DESCRIPTION)});
              var atom = document.querySelector(${JSON.stringify(DESC_PILL)});
              var lr = line.getBoundingClientRect();
              var ar = atom.getBoundingClientRect();
              return {
                label: (atom.textContent || ""),
                band: getComputedStyle(line).lineHeight,
                atomHeight: Math.round(ar.height * 10) / 10,
                // Positive on both means the pill's box is INSIDE the line's,
                // which is the whole claim: the line clips its own overflow,
                // so a pill taller than the band is cut at one end or both.
                roomAbove: Math.round((ar.top - lr.top) * 10) / 10,
                roomBelow: Math.round((lr.bottom - ar.bottom) * 10) / 10,
              };
            })())`),
          ) as Record<string, number | string>;
          note("at0561 commit pill", JSON.stringify(pill));
          // The label is the app's own spelling, not the nine characters the
          // post wrote.
          expect(pill.label).toContain(`commit:${HEAD_SHA.slice(0, 8)}`);
          expect(pill.roomAbove, "the pill's top is inside the line").toBeGreaterThanOrEqual(0);
          expect(pill.roomBelow, "the pill's bottom is inside the line").toBeGreaterThanOrEqual(0);

          // 5. The beat says the sentence and nothing of the escapes.
          await app.waitForCondition<boolean>(
            `(document.querySelector(${JSON.stringify(
              BEAT,
            )})?.textContent || "").indexOf("cargo nextest run") !== -1`,
            { timeoutMs: 20_000 },
          );
          const beat = await app.evalJS<string>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(BEAT)});
              return el === null ? "" : (el.textContent || "");
            })()`,
          );
          note("at0561 beat ink", JSON.stringify(beat));
          expect(beat).toContain("Running cargo nextest run");
          // Neither the byte nor the residue a half-strip leaves behind.
          expect(beat).not.toContain(ESC);
          expect(beat).not.toContain("[35m");
          expect(beat).not.toContain("[0m");

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
