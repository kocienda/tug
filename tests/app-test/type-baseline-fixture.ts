/**
 * type-baseline-fixture.ts — the mounts, readers and before-figures the
 * at0625-type-baseline-* files share: the tool-call header's runs sit on one
 * baseline, and here is the number.
 *
 * The header puts a bold sans name and a mono `<code>` detail in one row,
 * and it used to correct the disagreement between them with four hand-tuned
 * `position: relative; top: 1px` rules whose comments contradicted each
 * other about which run was the one riding high. These tests are the
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
 *  - **the runs share one baseline** (`-spread`): spread `<= 0.5px` across
 *    the header's runs *set at the row's own size*, with no nudge anywhere
 *    in the stylesheet holding them there. The sweep is what taught the test
 *    to read it that way: once the offsets were gone the sans name and the
 *    mono `<code>` coincided exactly, and the only run still off the line
 *    was the timing badge, two size steps smaller — a rule (i) size
 *    disagreement, which is `note()`d rather than asserted because no
 *    baseline mechanism can close one;
 *  - **the instrument is stable** (`-stable`): two consecutive reads of an
 *    untouched header agree to within a tenth of a pixel. A jittering
 *    instrument is not an instrument, and every later step's before/after
 *    rests on this.
 *
 * Both readings are `note()`d in full — every run's slot, text, face, size
 * and baseline — so the census in the step after this one reads the report
 * rather than re-deriving anything. The collapsed and expanded readings are
 * both taken, which answers whether `-webkit-line-clamp`'s
 * `display: -webkit-box` lets a strut report a baseline at all.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * The third case (`-census`) is the **census** — one instrument run over
 * the family-A surfaces, asserting only that each mounts and reports. Its
 * output is the `Diagnostics:` section, transcribed into the arc's
 * `census.md`.
 *
 * The fourth (`-glyph`) is rule (iv)'s: the inline glyph's offset resolves
 * from one declared token, and does not move the text beside it.
 *
 * The fifth (`-track`) is rule (v)'s, and it asserts in two axes at once
 * because the one rule carried two unrelated corrections. Horizontally, a
 * `0.18em` track with nothing after the last glyph to absorb it left the
 * legend 0.81px off its own box's centre; a trailing negative margin of
 * exactly one track brings that to 0.00px. Vertically, a
 * `translateY(0.5px)` claimed to seat the label on the rule it captions and
 * measurably did the reverse — 0.73px below the rule with it, 0.23px
 * without. Both readings are `note()`d before either is asserted on, so a
 * red run still carries the other number into the report.
 *
 * **The usage sheet is not here, and that is a recorded hole rather than
 * an omission.** Its rows are Table T02 — dotted leaders, boxes with no
 * text in them — and the arc touches none of them, so the reading was
 * only ever going to be a `note()`. The sheet's one door is a slash
 * command on the prompt path, which needs a live engine, and a
 * non-asserting reading is not worth a second engine-backed mount. The
 * arc's `census.md` names it with that reason.
 *
 * Split out of `at0625-type-baseline.test.ts` when that file was cut one
 * test to a file so each launch fits its own budget.
 *
 * @module tests/app-test/type-baseline-fixture
 */

import { launchTugApp } from "./_harness";
import { sessionCardShape, SESSION_CARD_SIZE_SHORT } from "./_harness/shapes";
import {
  rowBaselinesJS,
  type RowBaselines,
  type RunBaseline,
} from "./baseline-probes";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const SID = "test-session-A";

export const CARD = '[data-card-id="A"]';
export const HEADER = `${CARD} .tool-call-header`;
const DETAIL_CODE = `${CARD} .tool-call-header-detail code`;
export const DISCLOSURE = `${HEADER} [data-slot="tool-call-header-disclosure"]`;

/** The skill whose header this measures, and the args giving it a body. */
const SKILL_NAME = "tugplug:draft";
const SKILL_ARGS = "write the landing draft";

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
  seq: 0,
  tug_session_id: SID,
  msg_id: msgId,
  result: "success",
});

export type Harness = Awaited<ReturnType<typeof launchTugApp>>;

/** Seed one Session card, bind it, and ingest a completed `Skill` call. */
export async function mountSkillHeader(app: Harness): Promise<void> {
  const ingest = (decoded: unknown) =>
    app.driveSession("A", { op: "ingestFrame", feedId: CODE_OUTPUT_FEED, decoded });

  await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_SHORT), focusCardId: "A" });
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
    is_error: false,
    tug_session_id: SID,
    tool_use_id: "tc-1",
    output: "done",
  });
  await ingest(turnDone("m1"));
  await ingest(replayComplete());

  // The mono detail is the run the name is being measured against, so the
  // header is not ready until it is in the DOM.
  await app.body("A").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(DETAIL_CODE)}) !== null`,
    { timeoutMs: 12_000 },
  );
}

/** Read the header's runs, and render the reading as one diagnostic line. */
export async function readHeader(app: Harness): Promise<RowBaselines> {
  return JSON.parse(await app.body("A").evalJS<string>(rowBaselinesJS(HEADER))) as RowBaselines;
}

/** Read any row's runs. */
export async function readRow(app: Harness, selector: string): Promise<RowBaselines> {
  return JSON.parse(await app.body("A").evalJS<string>(rowBaselinesJS(selector))) as RowBaselines;
}

/** The Z2 telemetry row's letterspaced legend — `[F05]`'s subject. */
export const ENDCAP_LABEL = `${CARD} .session-telemetry-endcap-label`;

/** The hairline the legend is seated on, found beside the label it captions. */
export const ENDCAP_RULE_FILL = ".session-telemetry-endcap-rule-fill";

/**
 * `centredBy` on the endcap legend before family C, off the arc's census:
 * a 0.18em track at 9px is 1.62px, and half of it is how far left of its
 * own box's centre the glyphs sat.
 */
export const BEFORE_CENTRED_BY = 0.81;

/**
 * The spreads this same probe read **before** the family-A sweep, off the
 * arc's census. They are here so a failure reads as a movement rather than
 * as a bare number, and so the report carries the before and the after in
 * one place. A reading that drifts from these without the stylesheet
 * changing is the instrument, not the app.
 */
export const BEFORE: Readonly<Record<string, number>> = {
  skill: 1.13,
  "skill-tool-header": 1.13,
  "bash-tool-header": 1.13,
  "task-tool-header": 1.13,
  "wake-quiet-line": 0.0,
};

/** A block's header, addressed by the tool call that produced it. */
export const blockHeader = (toolUseId: string) =>
  `${CARD} [data-tool-use-id="${toolUseId}"] .tool-call-header`;

/**
 * The family-A surfaces this census reaches, and the Table T01 rows each
 * one puts in play. A surface not on this list is a hole `census.md` names
 * with its reason — the probe reads baselines of *text*, so a row whose
 * only nudged element is an SVG glyph or an `<input>` has nothing for a
 * strut to sit beside, and no amount of mounting changes that.
 */
export const CENSUS: readonly { key: string; selector: string; declarations: string }[] = [
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
export async function mountCensusSurfaces(app: Harness): Promise<void> {
  const ingest = (decoded: unknown) =>
    app.driveSession("A", { op: "ingestFrame", feedId: CODE_OUTPUT_FEED, decoded });

  await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_SHORT), focusCardId: "A" });
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
    is_error: false,
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
    is_error: false,
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
    is_error: false,
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
    is_error: false,
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
      output_file: "",
    },
  });
  await ingest(replayComplete());

  // Wait for the last surface to arrive rather than sleeping: if the wake
  // chip is up, every block ingested before it is up too.
  await app.body("A").waitForCondition<boolean>(
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
export function spreadAtRowSize(runs: readonly RunBaseline[]): {
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
export function offSizeNote(
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

export function summarize(label: string, r: RowBaselines): string {
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
