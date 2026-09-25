/**
 * at0625-type-baseline.test.ts — the tool-call header's runs sit on one
 * baseline, and here is the number.
 *
 * The header puts a bold sans name and a mono `<code>` detail in one row,
 * and it used to correct the disagreement between them with four hand-tuned
 * `position: relative; top: 1px` rules whose comments contradicted each
 * other about which run was the one riding high. This test is the
 * measurement that replaced them: a zero-height strut in each run's own
 * inline context, and the spread between the baselines it reads.
 *
 * **The assertion was born inverted, on purpose, and has since turned
 * over.** Against the unmodified stylesheet it asserted the spread was
 * *greater* than 0.5px — that the runs disagreed — because a probe that
 * could not see the misalignment could not have proven the deletion sound
 * either. The family-A sweep then deleted the eleven nudges and the
 * assertion inverted to `<= 0.5`, which is where it stands. That
 * inversion is the arc's evidence, and the before-figures it turned over
 * are `note()`d beside every reading so the two are in one report.
 *
 * Asserts:
 *  - **the runs share one baseline**: spread `<= 0.5px` across the header's
 *    runs *set at the row's own size*, with no nudge anywhere in the
 *    stylesheet holding them there. The sweep is what taught the test to
 *    read it that way: once the offsets were gone the sans name and the
 *    mono `<code>` coincided exactly, and the only run still off the line
 *    was the timing badge, two size steps smaller — a rule (i) size
 *    disagreement, which is `note()`d rather than asserted because no
 *    baseline mechanism can close one;
 *  - **the instrument is stable**: two consecutive reads of an untouched
 *    header agree to within a tenth of a pixel. A jittering instrument is
 *    not an instrument, and every later step's before/after rests on this.
 *
 * Both readings are `note()`d in full — every run's slot, text, face, size
 * and baseline — so the census in the step after this one reads the report
 * rather than re-deriving anything. The collapsed and expanded readings are
 * both taken, which answers whether `-webkit-line-clamp`'s
 * `display: -webkit-box` lets a strut report a baseline at all.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * The third case is the **census** — one instrument run over the family-A
 * surfaces, asserting only that each mounts and reports. Its output is the
 * `Diagnostics:` section, transcribed into the arc's `census.md`.
 *
 * The fourth is rule (iv)'s: the inline glyph's offset resolves from one
 * declared token, and does not move the text beside it.
 *
 * The fifth is rule (v)'s, and it asserts in two axes at once because the
 * one rule carried two unrelated corrections. Horizontally, a `0.18em`
 * track with nothing after the last glyph to absorb it left the legend
 * 0.81px off its own box's centre; a trailing negative margin of exactly
 * one track brings that to 0.00px. Vertically, a `translateY(0.5px)`
 * claimed to seat the label on the rule it captions and measurably did the
 * reverse — 0.73px below the rule with it, 0.23px without. Both readings
 * are `note()`d before either is asserted on, so a red run still carries
 * the other number into the report.
 *
 * **The usage sheet is not here, and that is a recorded hole rather than
 * an omission.** Its rows are Table T02 — dotted leaders, boxes with no
 * text in them — and the arc touches none of them, so the reading was
 * only ever going to be a `note()`. The sheet's one door is a slash
 * command on the prompt path, which needs a live engine, and a
 * non-asserting reading is not worth a second engine-backed mount in this
 * file. The arc's `census.md` names it with that reason.
 *
 * @covers tugdeck/src/components/tugways/blocks/block-header.css
 * @covers tugdeck/src/components/tugways/blocks/block-header.tsx
 * @covers tugdeck/src/components/tugways/blocks/block-strip.tsx
 * @covers tugdeck/styles/tug-line-box.css
 * @covers tugdeck/src/components/tugways/cards/blocks/skill-tool-block.tsx
 * @covers tugdeck/src/components/tugways/blocks/block-chrome.css
 * @covers tugdeck/src/components/tugways/cards/blocks/bash-tool-block.tsx
 * @covers tugdeck/src/components/tugways/cards/blocks/task-tool-block.css
 * @covers tugdeck/src/components/tugways/tug-quiet-line.css
 * @covers tugdeck/src/components/tugways/tug-status-cell.css
 * @covers tugdeck/src/components/tugways/tug-atom-ref.css
 * @covers tugdeck/src/components/tugways/tug-separator.css
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";
import {
  rowBaselinesJS,
  trackCompensationJS,
  inkVsRuleJS,
  type RowBaselines,
  type RunBaseline,
  type TrackCompensation,
  type InkVsRule,
} from "./baseline-probes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const SID = "test-session-A";

const CARD = '[data-card-id="A"]';
const HEADER = `${CARD} .tool-call-header`;
const DETAIL_CODE = `${CARD} .tool-call-header-detail code`;
const DISCLOSURE = `${HEADER} [data-slot="tool-call-header-disclosure"]`;

/** The skill whose header this measures, and the args giving it a body. */
const SKILL_NAME = "tugplug:draft";
const SKILL_ARGS = "write the landing draft";

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 640 },
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

const replayStarted = () => ({ type: "replay_started", tug_session_id: SID });
const replayComplete = () => ({
  type: "replay_complete",
  tug_session_id: SID,
  count: 1,
  firstLoadedTurnIndex: 0,
  totalTurns: 1,
  hasOlder: false,
});
const userMsg = (text: string) => ({
  type: "add_user_message",
  tug_session_id: SID,
  content: [{ type: "text", text }],
});
const turnDone = (msgId: string) => ({
  type: "turn_complete",
  tug_session_id: SID,
  msg_id: msgId,
  result: "success",
});

type Harness = Awaited<ReturnType<typeof launchTugApp>>;

/** Seed one Session card, bind it, and ingest a completed `Skill` call. */
async function mountSkillHeader(app: Harness): Promise<void> {
  const ingest = (decoded: unknown) =>
    app.driveSession("A", { op: "ingestFrame", feedId: CODE_OUTPUT_FEED, decoded });

  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
  await app.bindSession("A", { tugSessionId: SID, sessionMode: "resume" });

  await ingest(replayStarted());
  await ingest(userMsg("run the skill"));
  await ingest({
    type: "tool_use",
    tug_session_id: SID,
    msg_id: "m1",
    tool_use_id: "tc-1",
    tool_name: "Skill",
    input: { skill: SKILL_NAME, args: SKILL_ARGS },
    seq: 1,
  });
  await ingest({
    type: "tool_result",
    tug_session_id: SID,
    tool_use_id: "tc-1",
    output: "done",
  });
  await ingest(turnDone("m1"));
  await ingest(replayComplete());

  // The mono detail is the run the name is being measured against, so the
  // header is not ready until it is in the DOM.
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(DETAIL_CODE)}) !== null`,
    { timeoutMs: 12_000 },
  );
}

/** Read the header's runs, and render the reading as one diagnostic line. */
async function readHeader(app: Harness): Promise<RowBaselines> {
  return JSON.parse(await app.evalJS<string>(rowBaselinesJS(HEADER))) as RowBaselines;
}

/** Read any row's runs. */
async function readRow(app: Harness, selector: string): Promise<RowBaselines> {
  return JSON.parse(await app.evalJS<string>(rowBaselinesJS(selector))) as RowBaselines;
}

/** The Z2 telemetry row's letterspaced legend — `[F05]`'s subject. */
const ENDCAP_LABEL = `${CARD} .session-telemetry-endcap-label`;

/** The hairline the legend is seated on, found beside the label it captions. */
const ENDCAP_RULE_FILL = ".session-telemetry-endcap-rule-fill";

/**
 * `centredBy` on the endcap legend before family C, off the arc's census:
 * a 0.18em track at 9px is 1.62px, and half of it is how far left of its
 * own box's centre the glyphs sat.
 */
const BEFORE_CENTRED_BY = 0.81;

/**
 * The spreads this same probe read **before** the family-A sweep, off the
 * arc's census. They are here so a failure reads as a movement rather than
 * as a bare number, and so the report carries the before and the after in
 * one place. A reading that drifts from these without the stylesheet
 * changing is the instrument, not the app.
 */
const BEFORE: Readonly<Record<string, number>> = {
  skill: 1.13,
  "skill-tool-header": 1.13,
  "bash-tool-header": 1.13,
  "task-tool-header": 1.13,
  "wake-quiet-line": 0.0,
};

/** A block's header, addressed by the tool call that produced it. */
const blockHeader = (toolUseId: string) =>
  `${CARD} [data-tool-use-id="${toolUseId}"] .tool-call-header`;

/**
 * The family-A surfaces this census reaches, and the Table T01 rows each
 * one puts in play. A surface not on this list is a hole `census.md` names
 * with its reason — the probe reads baselines of *text*, so a row whose
 * only nudged element is an SVG glyph or an `<input>` has nothing for a
 * strut to sit beside, and no amount of mounting changes that.
 */
const CENSUS: readonly { key: string; selector: string; declarations: string }[] = [
  {
    key: "skill-tool-header",
    selector: blockHeader("tc-skill"),
    declarations: "header dot+name, detail column, detail `code`, timing",
  },
  {
    key: "bash-tool-header",
    selector: blockHeader("tc-bash"),
    declarations: "header dot+name, detail column, detail `code`, summary+timing",
  },
  {
    key: "task-tool-header",
    selector: blockHeader("tc-task"),
    declarations: "header dot+name, detail `code`, task description (0.5px)",
  },
  {
    key: "wake-quiet-line",
    selector: `${CARD} [data-slot="wake-trigger-chip"] [data-slot="tug-quiet-line"]`,
    declarations: "quiet-line icon (+1px) and head (+1px); no counter-nudge on this host",
  },
  {
    key: "z2-telemetry-row",
    selector: `${CARD} [data-slot="session-telemetry-status-row"]`,
    declarations: "endcap label translateY(0.5px) and its 0.18em track",
  },
  {
    key: "read-tool-header",
    selector: blockHeader("tc-read"),
    declarations: "the inline atom-ref glyph's host row (rule (iv)'s token)",
  },
];

/** Mount one Session card carrying every {@link CENSUS} surface at once. */
async function mountCensusSurfaces(app: Harness): Promise<void> {
  const ingest = (decoded: unknown) =>
    app.driveSession("A", { op: "ingestFrame", feedId: CODE_OUTPUT_FEED, decoded });

  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
  await app.bindSession("A", { tugSessionId: SID, sessionMode: "resume" });

  await ingest(replayStarted());
  await ingest(userMsg("census the surfaces"));
  await ingest({
    type: "tool_use",
    tug_session_id: SID,
    msg_id: "m1",
    tool_use_id: "tc-skill",
    tool_name: "Skill",
    input: { skill: SKILL_NAME, args: SKILL_ARGS },
    seq: 1,
  });
  await ingest({
    type: "tool_result",
    tug_session_id: SID,
    tool_use_id: "tc-skill",
    output: "done",
  });
  await ingest({
    type: "tool_use",
    tug_session_id: SID,
    msg_id: "m1",
    tool_use_id: "tc-bash",
    tool_name: "Bash",
    input: { command: "git status --porcelain" },
    seq: 2,
  });
  await ingest({
    type: "tool_result",
    tug_session_id: SID,
    tool_use_id: "tc-bash",
    output: "M tugdeck/src/app.tsx\n",
  });
  await ingest({
    type: "tool_use",
    tug_session_id: SID,
    msg_id: "m1",
    tool_use_id: "tc-task",
    tool_name: "Task",
    input: {
      subagent_type: "Explore",
      description: "find the nudge corpus",
      prompt: "look for position: relative in the stylesheets",
    },
    seq: 3,
  });
  await ingest({
    type: "tool_result",
    tug_session_id: SID,
    tool_use_id: "tc-task",
    output: "found 15",
  });
  // A `Read` header renders its file ref as a `TugAtomRef` — an inline SVG
  // glyph beside a text label, which is rule (iv)'s subject and the one
  // place `--tug-glyph-cap-offset` is consumed.
  await ingest({
    type: "tool_use",
    tug_session_id: SID,
    msg_id: "m1",
    tool_use_id: "tc-read",
    tool_name: "Read",
    input: { file_path: "/tmp/at0625/notes.md" },
    seq: 4,
  });
  await ingest({
    type: "tool_result",
    tug_session_id: SID,
    tool_use_id: "tc-read",
    output: "alpha\nbravo\n",
  });
  await ingest(turnDone("m1"));
  // The wake chip opens its own assistant-originated turn, so it is
  // ingested after the tool turn completes rather than inside it.
  await ingest({
    type: "wake_started",
    tug_session_id: SID,
    wake_trigger: {
      task_id: "wake-1",
      tool_use_id: "tc-wake",
      status: "completed",
      summary: "loop pacing",
      output_file: null,
    },
  });
  await ingest(replayComplete());

  // Wait for the last surface to arrive rather than sleeping: if the wake
  // chip is up, every block ingested before it is up too.
  await app.waitForCondition<boolean>(
    `document.querySelector('${CARD} [data-slot="wake-trigger-chip"]') !== null &&
     document.querySelector(${JSON.stringify(ENDCAP_LABEL)}) !== null`,
    { timeoutMs: 15_000 },
  );
}

/**
 * The spread among the runs set at the row's own size, and the runs that
 * are not.
 *
 * The whole-row spread turned out to be the wrong number to assert on, and
 * finding out why is what the family-A sweep bought. With every nudge
 * deleted, the tool-call header's sans name and its mono `<code>` detail
 * land on *exactly* the same baseline — one size in one line box is
 * already one baseline, as `block-header.css`'s own docstring always said.
 * What is left over is the timing badge, set at 10px in a 13px row: a
 * `font-size` disagreement, which is rule (i)'s subject and which no
 * amount of deleting offsets could ever close.
 *
 * So the claim this sweep proves is about the runs that share the row's
 * size, and `offSize` is what carries the rule (i) observation into the
 * report rather than burying it inside a spread.
 */
function spreadAtRowSize(runs: readonly RunBaseline[]): {
  size: string;
  spread: number;
  counted: number;
  offSize: RunBaseline[];
} {
  const bySize = new Map<string, RunBaseline[]>();
  for (const run of runs) {
    const at = bySize.get(run.fontSize);
    if (at === undefined) bySize.set(run.fontSize, [run]);
    else at.push(run);
  }
  let size = "";
  let best: RunBaseline[] = [];
  for (const [px, group] of bySize) {
    if (group.length > best.length) {
      size = px;
      best = group;
    }
  }
  const ys = best.map((r) => r.baseline);
  return {
    size,
    spread: best.length === 0 ? 0 : Math.max(...ys) - Math.min(...ys),
    counted: best.length,
    offSize: runs.filter((r) => r.fontSize !== size),
  };
}

/** One line naming the off-size runs, for the report. */
function offSizeNote(
  label: string,
  at: ReturnType<typeof spreadAtRowSize>,
): string {
  if (at.offSize.length === 0) return `${label}: every run is set at ${at.size}`;
  const off = at.offSize
    .map((r) => `${r.slot} "${r.text}" at ${r.fontSize}`)
    .join("; ");
  return (
    `${label}: ${at.counted} run(s) at the row's ${at.size} spread ` +
    `${at.spread.toFixed(2)}px; ${at.offSize.length} run(s) off that size — ${off}. ` +
    `A size disagreement is rule (i)'s subject, not a baseline defect`
  );
}

function summarize(label: string, r: RowBaselines): string {
  if (r.found !== true) return `${label}: not found (${r.why ?? "no reason given"})`;
  const runs = (r.runs ?? [])
    .map(
      (run) =>
        `${run.slot} "${run.text}" @${run.baseline.toFixed(2)} ` +
        `[${run.fontSize} ${run.fontFamily.split(",")[0]}]`,
    )
    .join("; ");
  return `${label}: spread ${(r.spread ?? 0).toFixed(2)}px over ${
    (r.runs ?? []).length
  } run(s) — ${runs}`;
}

describe.skipIf(!SHOULD_RUN)("AT0624: the tool-call header's type baseline", () => {
  test(
    "the tool-call header's runs share one baseline",
    async () => {
      const app = await launchTugApp({ testName: "at0625-type-baseline-spread" });
      try {
        await mountSkillHeader(app);

        const collapsedAttr = await app.evalJS<string | null>(
          `(document.querySelector(${JSON.stringify(HEADER)}) || {getAttribute:function(){return null;}})
             .getAttribute("data-collapsed")`,
        );
        const asMounted = await readHeader(app);
        note(summarize(`at0625 as-mounted (data-collapsed=${collapsedAttr})`, asMounted));

        expect(asMounted.found, asMounted.why ?? "").toBe(true);
        const runs = asMounted.runs ?? [];
        expect(
          runs.length,
          "the header must give up more than one run to compare",
        ).toBeGreaterThan(1);

        // The inverted assertion, and the arc's central claim: with every
        // nudge deleted the header's runs agree, because one font size in
        // one line box is already one baseline. Read over the runs at the
        // row's own size — the timing badge is set two steps smaller, and
        // that is rule (i)'s business, reported rather than asserted here.
        const atSize = spreadAtRowSize(runs);
        note(offSizeNote("at0625 by size", atSize));
        expect(
          atSize.spread,
          `the header's runs share one baseline (was ${BEFORE.skill}px with the nudges in)`,
        ).toBeLessThanOrEqual(0.5);

        // --- the other fold state, which is [Q01] --------------------------
        // Does a strut inside `-webkit-line-clamp`'s `display: -webkit-box`
        // still report a baseline? Read the opposite state and say so; the
        // answer bounds every later step that measures a collapsed header.
        await app.click(DISCLOSURE);
        await app.waitForCondition<boolean>(
          `(function(){
             var h = document.querySelector(${JSON.stringify(HEADER)});
             return h !== null && h.getAttribute("data-collapsed") !== ${JSON.stringify(collapsedAttr)};
           })()`,
          { timeoutMs: 6000 },
        );
        const toggledAttr = await app.evalJS<string | null>(
          `document.querySelector(${JSON.stringify(HEADER)}).getAttribute("data-collapsed")`,
        );
        const toggled = await readHeader(app);
        note(summarize(`at0625 toggled (data-collapsed=${toggledAttr})`, toggled));
        note(
          `at0625 [Q01] strut under -webkit-line-clamp: ${
            toggled.found === true && (toggled.runs ?? []).length > 1
              ? "reports baselines in both fold states"
              : "did NOT report in the clamped state — later steps must expand first"
          }`,
        );

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0625] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the reading is stable across two consecutive reads",
    async () => {
      const app = await launchTugApp({ testName: "at0625-type-baseline-stable" });
      try {
        await mountSkillHeader(app);

        const first = await readHeader(app);
        const second = await readHeader(app);
        note(summarize("at0625 read 1", first));
        note(summarize("at0625 read 2", second));

        expect(first.found, first.why ?? "").toBe(true);
        expect(second.found, second.why ?? "").toBe(true);

        const a = first.runs ?? [];
        const b = second.runs ?? [];
        expect(b.length, "the same runs are found both times").toBe(a.length);
        for (let i = 0; i < a.length; i += 1) {
          expect(b[i].slot, `run ${i} is the same run`).toBe(a[i].slot);
          expect(
            Math.abs(b[i].baseline - a[i].baseline),
            `run ${i} (${a[i].slot}) reads the same baseline twice`,
          ).toBeLessThanOrEqual(0.1);
        }
        expect(
          Math.abs((second.spread as number) - (first.spread as number)),
          "the spread is the same number twice — a jittering instrument is not one",
        ).toBeLessThanOrEqual(0.1);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0625] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // --- the census ------------------------------------------------------
  // One instrument run over the family-A surfaces Table T01 names, whose
  // output is the report's `Diagnostics:` section and, transcribed, the
  // arc's `census.md`. It asserts only that each surface it claims to
  // census actually mounted and reported — a surface with no reading is a
  // hole in the census, and a hole nobody notices is the failure mode this
  // assertion exists against. What each number *means* is argued in the
  // census, not here: this case makes no claim about which spread is
  // acceptable, because deciding that before the law is written would be
  // the eye judgement the arc is replacing.
  test(
    "every censused surface mounts and reports a reading",
    async () => {
      const app = await launchTugApp({ testName: "at0625-type-baseline-census" });
      try {
        await mountCensusSurfaces(app);

        for (const surface of CENSUS) {
          const reading = await readRow(app, surface.selector);
          const before = BEFORE[surface.key];
          note(
            summarize(`at0625 census ${surface.key}`, reading) +
              (before === undefined
                ? ""
                : ` — was ${before.toFixed(2)}px before the sweep`),
          );
          expect(
            reading.found,
            `census surface ${surface.key} (${surface.selector}) reported nothing: ` +
              `${reading.why ?? "no reason given"}`,
          ).toBe(true);
          // Every family-A surface the probe can reach agrees after the
          // sweep. The Z2 row is excluded by having no `BEFORE` entry: its
          // spread is legend-band against value-band, two lines rather than
          // one, and family C is what answers for it.
          if (before !== undefined) {
            const atSize = spreadAtRowSize(reading.runs ?? []);
            note(offSizeNote(`at0625 census ${surface.key} by size`, atSize));
            expect(
              atSize.spread,
              `${surface.key} shares one baseline (was ${before.toFixed(2)}px)`,
            ).toBeLessThanOrEqual(0.5);
          }
        }

        // [F05] is horizontal, so the strut is the wrong instrument for it:
        // the endcap label is uppercase and tracked at 0.18em with nothing
        // after the last glyph to absorb the track, and the flex container
        // centres the box the track widened.
        const track = JSON.parse(
          await app.evalJS<string>(trackCompensationJS(ENDCAP_LABEL)),
        ) as TrackCompensation;
        note(
          track.found === true
            ? `at0625 census endcap track: rect ${track.rectWidth?.toFixed(2)}px vs advance ` +
              `${track.advance?.toFixed(2)}px, trailing track ${track.trailingTrack?.toFixed(2)}px, ` +
              `left of centre by ${track.centredBy?.toFixed(2)}px`
            : `at0625 census endcap track: not found (${track.why ?? "no reason given"})`,
        );
        expect(track.found, track.why ?? "").toBe(true);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0625] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // --- rule (iv): the inline glyph ------------------------------------
  // A length `vertical-align` on an inline glyph is the one correction the
  // law sanctions, and only through one declared token. Two things have to
  // hold, and neither is visible in a spread alone: the token must actually
  // resolve — a misspelled custom property makes `vertical-align` invalid
  // and silently falls back to `baseline`, which looks like a working
  // stylesheet and is a dropped glyph — and the offset must not disturb the
  // baseline of the text it sits beside, which is what a length
  // `vertical-align` can do by growing the line box.
  test(
    "the inline glyph rides one declared token, and its host row keeps one baseline",
    async () => {
      const app = await launchTugApp({ testName: "at0625-type-baseline-glyph" });
      try {
        await mountCensusSurfaces(app);

        const ICON = `${CARD} [data-tool-use-id="tc-read"] .tug-atom-ref-icon`;
        const glyph = JSON.parse(
          await app.evalJS<string>(`JSON.stringify((function(){
            var el = document.querySelector(${JSON.stringify(ICON)});
            if (el === null) return { found: false };
            var root = getComputedStyle(document.documentElement);
            return {
              found: true,
              verticalAlign: getComputedStyle(el).verticalAlign,
              token: root.getPropertyValue("--tug-glyph-cap-offset").trim(),
            };
          })())`),
        ) as { found: boolean; verticalAlign?: string; token?: string };
        note(
          `at0625 glyph offset: --tug-glyph-cap-offset = "${glyph.token ?? ""}", ` +
            `computed vertical-align = "${glyph.verticalAlign ?? ""}"`,
        );

        expect(
          glyph.found,
          "the Read header renders its file ref as an atom ref",
        ).toBe(true);
        // The token is read back through `getPropertyValue`, which returns the
        // browser's normalised text — `-.15em` for the `-0.15em` the stylesheet
        // writes — so the assertion is on the number, not on the spelling.
        expect(
          parseFloat(glyph.token ?? ""),
          "the token is declared in :root at the adopted calibration",
        ).toBeCloseTo(-0.15, 5);
        // Then the RESOLVED value, which is the thing that matters: an
        // unresolved `var()` makes `vertical-align` invalid and it silently
        // falls back to `baseline`. That reads as a working stylesheet and is
        // a dropped glyph, so the used length is what gets asserted — 13px of
        // host type times −0.15.
        expect(
          glyph.verticalAlign,
          "the token resolved — an unresolved var() computes to `baseline`",
        ).not.toBe("baseline");
        expect(
          parseFloat(glyph.verticalAlign ?? ""),
          "the used offset is the token applied to the row's own type size",
        ).toBeCloseTo(-1.95, 2);

        // And the row it sits in still agrees with itself.
        const row = await readRow(app, blockHeader("tc-read"));
        note(summarize("at0625 glyph host row", row));
        expect(row.found, row.why ?? "").toBe(true);
        const atSize = spreadAtRowSize(row.runs ?? []);
        note(offSizeNote("at0625 glyph host row by size", atSize));
        expect(
          atSize.spread,
          "the glyph's offset does not move the text beside it off the line",
        ).toBeLessThanOrEqual(0.5);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0625] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // --- rule (v): the letterspaced legend -------------------------------
  // The Z2 endcap legend is uppercase and tracked at 0.18em inside a flex
  // row that centres it between two hairlines. CSS puts a track after the
  // LAST glyph too, with nothing after it to absorb one, so the box the
  // container centres is a track wider than the glyphs in it and the
  // glyphs sit half a track to the left. Two numbers say whether the
  // compensation works, and they are orthogonal: `centredBy` is the
  // horizontal one the track builder measures off the laid-out boxes, and
  // `offBy` is the vertical one — where the legend's ink sits against the
  // rule it captions, which is what the deleted `translateY(0.5px)`
  // claimed to be fixing.
  test(
    "the letterspaced legend is centred on its own track, and seated on its rule",
    async () => {
      const app = await launchTugApp({ testName: "at0625-type-baseline-track" });
      try {
        await mountCensusSurfaces(app);

        const track = JSON.parse(
          await app.evalJS<string>(trackCompensationJS(ENDCAP_LABEL)),
        ) as TrackCompensation;
        note(
          track.found === true
            ? `at0625 endcap track: rect ${track.rectWidth?.toFixed(2)}px, advance ` +
              `${track.advance?.toFixed(2)}px, trailing track ${track.trailingTrack?.toFixed(2)}px, ` +
              `margin-end ${track.marginEnd?.toFixed(2)}px → centredBy ` +
              `${track.centredBy?.toFixed(2)}px (was ${BEFORE_CENTRED_BY.toFixed(2)}px uncompensated)`
            : `at0625 endcap track: not found (${track.why ?? "no reason given"})`,
        );
        expect(track.found, track.why ?? "").toBe(true);

        // The vertical claim the deleted nudge made. This is recorded
        // rather than asserted tightly: the ink band is derived from the
        // face's cap ratio rather than measured off pixels, so it answers
        // "did the nudge move the legend toward the rule or away from it"
        // and does not pretend to a tolerance it has not earned.
        const ink = JSON.parse(
          await app.evalJS<string>(inkVsRuleJS(ENDCAP_LABEL, ENDCAP_RULE_FILL)),
        ) as InkVsRule;
        note(
          ink.found === true
            ? `at0625 endcap ink vs rule: baseline @${ink.baseline?.toFixed(2)} at ` +
              `${ink.fontSize?.toFixed(2)}px → cap-band centre @${ink.inkCentre?.toFixed(2)}, ` +
              `rule centre @${ink.ruleCentre?.toFixed(2)}, off by ${ink.offBy?.toFixed(2)}px ` +
              `(positive = ink below the rule)`
            : `at0625 endcap ink vs rule: not found (${ink.why ?? "no reason given"})`,
        );
        expect(ink.found, ink.why ?? "").toBe(true);

        // Both readings are `note()`d above before either is asserted on,
        // so a run that fails one still carries the other into the report.
        // The step that wrote this case needed exactly that: the before
        // and after of two orthogonal numbers, from runs where one of them
        // was red by construction.

        // The compensation is a trailing negative margin of exactly one
        // track, so the margin box the container centres is the glyph band
        // again. A run that is still displaced is one whose two numbers
        // disagree — and the assertion is on the DISPLACEMENT rather than
        // on the declaration, so a `margin-inline-end` that is present and
        // wrong fails here rather than reading as compliance.
        expect(
          Math.abs(track.centredBy as number),
          `the legend's glyphs sit on their box's centre ` +
            `(was ${BEFORE_CENTRED_BY.toFixed(2)}px left of it)`,
        ).toBeLessThanOrEqual(0.25);

        expect(
          Math.abs(ink.offBy as number),
          "the legend's ink is seated on the rule it captions " +
            "(it read 0.73px low with the translateY in place)",
        ).toBeLessThanOrEqual(0.5);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0625] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
