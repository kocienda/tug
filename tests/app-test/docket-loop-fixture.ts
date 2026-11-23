/**
 * docket-loop-fixture.ts — a live arc whose brief has moved on, built on the
 * authoring fixture's scratch: an idea on a docket, its kept sketch, brief v1
 * written from it, and a plain arc opened on v1 whose first two steps are
 * done, stopped by the user, then brief v2 changing a decision a done step
 * carries. Follow-ups are recorded on it through `tugtool arc follow-up`, as
 * an audit records them.
 *
 * {@link makeJoinedArc} makes a landed arc instead: its own idea and kept
 * sketch, one round adding a file, joined onto the base through
 * `tugtool arc join`.
 *
 * Every record a verb writes goes through this checkout's `tugtool` against
 * the scratch data root (`arc create`, `arc step`, `arc commit`, `idea`,
 * `sketch`); the lines only a card writes — the arc's `arc-start` and
 * `arc-kind`, and its `arc-stop implement stopped by user` — are appended to
 * the scratch log in its own four-field grammar. Nothing touches a real arc
 * or a real card.
 *
 * The arc is stopped before anything binds it, so no wheel ever finds it
 * running and seats a stage on the test's Session card.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  appendArcLogLine,
  arcLogPath,
  arcWorktreePath,
  bindArc,
  commitRound,
  createArc,
  gitRetry,
} from "./arc-fixture";
import { CHECKOUT } from "./arcs-card-fixture";
import {
  cli,
  ideaId,
  keepSketch,
  type AuthoringScratch,
} from "./docket-authoring-fixture";
import type { App } from "./_harness";

/** A brief with two decisions, the second in words `second` gives. */
export function briefText(second: string): string {
  return [
    "# Rail",
    "",
    "## Decisions",
    "",
    "**[B01] The first.** Lay the first rail.",
    "",
    `**[B02] The second.** ${second}`,
    "",
  ].join("\n");
}

/** The arc's task list: three steps, the second carrying `[B02]`. */
const TASKS = [
  "# Rail {#tasks}",
  "",
  "Lay the rail in three pieces.",
  "",
  "### Execution Steps {#execution-steps}",
  "",
  "#### Step Status Ledger {#step-status-ledger}",
  "",
  "| Step | Title | Status | Commit |",
  "|---|---|---|---|",
  "| #step-1 | First | pending | — |",
  "| #step-2 | Second | pending | — |",
  "| #step-3 | Third | pending | — |",
  "",
  "#### Step 1: First {#step-1}",
  "",
  "Lay the first rail.",
  "",
  "Carries: [B01].",
  "",
  "#### Step 2: Second {#step-2}",
  "",
  "Lay the second rail.",
  "",
  "Carries: [B02].",
  "",
  "#### Step 3: Third {#step-3}",
  "",
  "Join them.",
  "",
  "Carries: none.",
  "",
].join("\n");

/** What {@link makeStaleArc} made. */
export interface StaleArc {
  arc: string;
  idea: string;
  sketch: string;
  /** The brief's path, relative to the repository. */
  brief: string;
  /** The commits steps 1 and 2 closed on. */
  steps: [string, string];
}

/**
 * Make the stale arc on the docket the test already created and captured
 * `ideaText` on. Returns what it made.
 */
export function makeStaleArc(s: AuthoringScratch, arc: string, ideaText: string): StaleArc {
  const repo = s.scratch.repo;
  const env = s.scratch.cli;
  const idea = ideaId(s, ideaText);
  const want = "Want the rail laid in three pieces.";
  const sketch = keepSketch(s, idea, want, "1–2");

  // Brief v1, recorded on the sketch.
  const brief = "briefs/rail-brief.md";
  mkdirSync(join(repo, "briefs"), { recursive: true });
  writeFileSync(join(repo, brief), briefText("Lay the second rail beside the first."));
  cli(s, ["sketch", "record-brief", sketch, "--path", brief, "--from-version", "1"]);

  // The arc, opened on v1 and continuing the sketch, as the door opens one.
  createArc(repo, arc, "docket-loop fixture", env);
  const log = arcLogPath(s.scratch.dataRoot);
  appendArcLogLine(log, arc, "arc-start", `.tug/arcs/${arc}/brief.md`);
  appendArcLogLine(log, arc, "arc-kind", "plain");
  const docs = join(repo, ".tug", "arcs", arc);
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "brief.md"), briefText("Lay the second rail beside the first."));
  writeFileSync(join(docs, "tasks.md"), TASKS);
  writeFileSync(join(docs, "sketch.md"), `# Sketch\n\n${want}\n\nSource: session ${s.sid}, turns 1–2\n`);
  cli(s, ["sketch", "record", arc, "--sketch", sketch]);

  // Steps 1 and 2 done, each on its own round.
  const worktree = arcWorktreePath(repo, arc);
  const steps: string[] = [];
  for (const n of [1, 2]) {
    cli(s, ["arc", "step", arc, "start", String(n), "--through", "3"]);
    writeFileSync(join(worktree, `rail-${n}.txt`), `rail ${n}\n`);
    commitRound(repo, arc, `Step ${n}`, env);
    const head = gitRetry(worktree, "rev-parse", "HEAD").trim();
    cli(s, ["arc", "step", arc, "done", String(n), "--commit", head]);
    steps.push(head);
  }

  // Stopped by the user before anything binds it.
  appendArcLogLine(log, arc, "arc-stop", "implement stopped by user");

  // Brief v2 changes the decision step 2 carries.
  reviseBrief(s, { sketch, brief, second: "Lay the second rail on the far side.", from: 1 });

  return { arc, idea, sketch, brief, steps: [steps[0]!, steps[1]!] };
}

/** Write a new version of the brief and record it on the sketch. */
export function reviseBrief(
  s: AuthoringScratch,
  opts: { sketch: string; brief: string; second: string; from: number },
): void {
  writeFileSync(join(s.scratch.repo, opts.brief), briefText(opts.second));
  cli(s, ["sketch", "record-brief", opts.sketch, "--path", opts.brief, "--from-version", String(opts.from)]);
}

/** Record follow-up `line` on `arc` as an audit does; answers its k. */
export function recordFollowUp(s: AuthoringScratch, arc: string, line: string): number {
  const out = JSON.parse(cli(s, ["arc", "follow-up", arc, line, "--json"])) as {
    data: { k: number };
  };
  return out.data.k;
}

/** A proposal row the Docket card's Inbox draws. */
export interface ProposalReading {
  from: string;
  text: string;
  /** The row sits under the Inbox label. */
  inInbox: boolean;
}

/** Every proposal row the Docket card draws, in list order. */
export async function readProposals(app: App): Promise<ProposalReading[]> {
  return app.body("D").evalJS<ProposalReading[]>(
    `(function(){
      var label = document.querySelector('[data-slot="docket-inbox-label"]');
      return Array.from(document.querySelectorAll('[data-slot="docket-proposal-row"]')).map(function (r) {
        return {
          from: ((r.querySelector('[data-slot="docket-proposal-from"]') || {}).textContent || "").trim(),
          text: ((r.querySelector('[data-slot="docket-proposal-text"]') || {}).textContent || "").trim(),
          inInbox: label !== null && (label.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        };
      });
    })()`,
  );
}

/** A JS expression for the proposal row whose line reads `text`, or null. */
export function proposalRow(text: string): string {
  return `(Array.from(document.querySelectorAll('[data-slot="docket-proposal-row"]')).find(function (r) {
    var t = r.querySelector('[data-slot="docket-proposal-text"]');
    return t !== null && (t.textContent || "").trim() === ${JSON.stringify(text)};
  }) || null)`;
}

/** Bind the stale arc to the test's Session card, so its shade shows it. */
export function bindStaleArc(s: AuthoringScratch, arc: string): void {
  bindArc(s.scratch.repo, arc, s.sid, { binaryRoot: CHECKOUT, env: s.scratch.cli.env });
}

/** A JS expression for the Docket card's row holding arc `arc`, or null. */
export function arcRow(arc: string): string {
  return `(Array.from(document.querySelectorAll('[data-slot="docket-thread-row"]')).find(function (r) {
    var a = r.querySelector('[data-slot="docket-arc-cell"]');
    return a !== null && (a.textContent || "").indexOf(${JSON.stringify(arc)}) !== -1;
  }) || null)`;
}

/** What the Docket card shows of the arc's row: its notice, and where the row sits. */
export interface RowReading {
  notice: { summary: string; offer: string | null; parked: string | null; suggested: string | null } | null;
  stale: boolean;
  parkedGroup: boolean;
  parkedNote: string | null;
}

export async function readArcRow(app: App, arc: string): Promise<RowReading | null> {
  return app.body("D").evalJS<RowReading | null>(
    `(function(){
      var r = ${arcRow(arc)};
      if (r === null) return null;
      var n = r.querySelector('[data-slot="arc-revision-notice"]');
      var cell = r.querySelector('[data-slot="docket-arc-cell"]');
      var label = document.querySelector('[data-slot="docket-parked-label"]');
      var note = r.querySelector('[data-slot="docket-parked-note"]');
      var parkedGroup = label !== null
        && (label.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      return {
        notice: n === null ? null : {
          summary: (n.querySelector('[data-slot="arc-revision-summary"]') || { textContent: "" }).textContent.trim(),
          offer: n.getAttribute("data-offer"),
          parked: n.getAttribute("data-parked"),
          suggested: n.getAttribute("data-suggested"),
        },
        stale: cell !== null && cell.getAttribute("data-stale") === "true",
        parkedGroup: parkedGroup,
        parkedNote: note === null ? null : (note.textContent || "").trim(),
      };
    })()`,
  );
}

/**
 * Make an arc on the idea reading `ideaText`, continuing its kept sketch, whose
 * one round adds `file`, and join it onto the scratch base through the CLI.
 * Returns the join commit.
 */
export function makeJoinedArc(s: AuthoringScratch, arc: string, ideaText: string, file: string): string {
  const repo = s.scratch.repo;
  const env = s.scratch.cli;
  const idea = ideaId(s, ideaText);
  const want = `Want ${ideaText}.`;
  const sketch = keepSketch(s, idea, want, "1–2");
  createArc(repo, arc, "docket-loop fixture", env);
  const docs = join(repo, ".tug", "arcs", arc);
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "sketch.md"), `# Sketch\n\n${want}\n\nSource: session ${s.sid}, turns 1–2\n`);
  cli(s, ["sketch", "record", arc, "--sketch", sketch]);
  writeFileSync(join(arcWorktreePath(repo, arc), file), `${arc}\n`);
  commitRound(repo, arc, `Add ${file}`, env);
  const out = JSON.parse(
    cli(s, ["arc", "join", arc, "--message", `Land ${arc}`, "--unaudited", "--json"]),
  ) as { data: { commit_hash?: string } };
  const sha = out.data.commit_hash;
  if (typeof sha !== "string") throw new Error(`arc join named no commit: ${JSON.stringify(out)}`);
  return sha;
}

/** What the Docket card's Landed group shows of one row, in list order. */
export interface LandedReading {
  arc: string;
  /** The join commit atom is drawn. */
  join: boolean;
  /** The revert commit atom is drawn. */
  reverted: boolean;
  /** Revert is offered. */
  revert: boolean;
}

/** Every row under the Landed label, in list order. */
export async function readLanded(app: App): Promise<LandedReading[]> {
  return app.body("D").evalJS<LandedReading[]>(
    `(function(){
      var label = document.querySelector('[data-slot="docket-landed-label"]');
      if (label === null) return [];
      return Array.from(document.querySelectorAll('[data-slot="docket-thread-row"]')).filter(function (r) {
        return (label.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      }).map(function (r) {
        var cell = r.querySelector('[data-slot="docket-arc-cell"]');
        return {
          arc: cell === null ? "" : cell.getAttribute("data-arc") || "",
          join: r.querySelector('[data-slot="docket-arc-join"]') !== null,
          reverted: r.querySelector('[data-slot="docket-landed-revert"]') !== null,
          revert: r.querySelector('[data-slot="docket-landed-revert-button"]') !== null,
        };
      });
    })()`,
  );
}
