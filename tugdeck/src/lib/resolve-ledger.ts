/**
 * The resolve ledger's pure view-model functions.
 *
 * Every decision the Changes shade's arc fold makes about what a line *says* —
 * as opposed to how it paints — lives here, as functions over data, so it is
 * testable without a DOM.
 *
 * @module lib/resolve-ledger
 */

import type { ToolResultSummary } from "@/components/tugways/blocks/tool-result-summary";
import type { ResolveFace } from "@/components/tugways/cards/session-changes/session-changes-arc-join";
import type {
  ArcConflictHistoryWire,
  ArcJoinLedgerEventWire,
  ArcJoinLedgerWire,
  ArcJoinQuestionWire,
  ArcJoinReportFileWire,
  ArcJoinStateWire,
  ArcResolvedBaseWire,
} from "@/lib/changeset-types";

/**
 * Whether the fold offers Resolve again (Spec S05).
 *
 * Only on the `offer` face — a run in flight or a candidate standing has
 * nothing to redo — and only over a ledger that no longer applies: a stale
 * note says the candidate stopped applying, and a durable ledger with the
 * face back at `offer` says a run was made and its candidate is gone. The
 * second is what keeps the moment alive after the board drops the stale
 * candidate and the note goes with it.
 */
export function offersResolveAgain(
  face: ResolveFace,
  join: ArcJoinStateWire | null,
): boolean {
  if (face !== "offer" || join === null) return false;
  const stale = typeof join.stale_note === "string" && join.stale_note !== "";
  return stale || join.ledger !== undefined;
}

/**
 * A document's path as the fold shows it: relative to the checkout when it
 * lies under it, absolute otherwise.
 *
 * The wire carries absolute paths because the open needs them; a reader needs
 * only the part that tells two documents apart. A path outside the checkout
 * keeps its full spelling, since a shortened one would name a file that is not
 * there.
 */
export function documentDisplayPath(abs: string, root: string | undefined): string {
  if (root === undefined || root === "") return abs;
  const trimmed = root.replace(/\/+$/, "");
  if (trimmed === "") return abs;
  const prefix = `${trimmed}/`;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
}

/** What a fold receipt says: the title row, and the sentence under it. */
export interface FoldReceiptText {
  title: string;
  sentence: string;
}

const plural = (n: number, one: string, many: string): string =>
  n === 1 ? one : many;

/**
 * The words on a fold's receipt.
 *
 * The title names what happened in the reader's terms — whose edit, which
 * file, on which base — and the sentence says what each of the receipt's two
 * answers does, so Keep and Undo are weighed before either is pressed.
 *
 * The user's own dirt folds with no holder, so the own-edit arm is the common
 * one; a single path held by another live session names its holder.
 */
export function foldReceiptText(rb: ArcResolvedBaseWire): FoldReceiptText {
  const folded = rb.folded ?? [];
  const dropped = rb.dropped ?? [];
  if (rb.commit === undefined) {
    const n = dropped.length;
    return {
      title: `Dropped ${n} identical ${plural(n, "file", "files")}`,
      sentence: `The arc already carries the same bytes, so the base's ${plural(n, "copy was", "copies were")} dropped rather than committed. Keep leaves it that way and the join proceeds; Undo restores the dropped ${plural(n, "copy", "copies")}.`,
    };
  }
  let title: string;
  if (folded.length === 1) {
    const path = folded[0]!;
    const holder = rb.folded_from?.[path];
    title =
      holder !== undefined
        ? `${holder}'s edit to ${path} is now a commit on ${rb.base}`
        : `Your edit to ${path} is now a commit on ${rb.base}`;
  } else {
    const n = folded.length;
    title = `Committed ${n} ${plural(n, "file", "files")} of base work on ${rb.base}`;
  }
  return {
    title,
    sentence: `Keep leaves the commit on ${rb.base} and the join proceeds. Undo takes it back off ${rb.base}, returns the ${plural(folded.length, "edit", "edits")} uncommitted, and blocks the join again.`,
  };
}

// ---------------------------------------------------------------------------
// The ledger: join facts and recorded events, folded into blocks
// ---------------------------------------------------------------------------

type EventOf<K extends ArcJoinLedgerEventWire["kind"]> = Extract<
  ArcJoinLedgerEventWire,
  { kind: K }
>;

/**
 * The live half of a ledger's input — the events and stream tails a run has
 * broadcast since this page started hearing it.
 *
 * Declared here rather than picked off the join store's state, so this module
 * stands on its own; the store's resolve state carries the same three fields
 * and is passed as it is.
 */
export interface LedgerLive {
  /** The run the live events belong to; absent before the first delta. */
  run?: string;
  /** Persisted-kind events heard live, in seq order. */
  events: readonly ArcJoinLedgerEventWire[];
  /** The latest live-only text per stream, replaced on each beat. */
  stream: {
    scribe?: { path: string; text: string };
    resolver?: { turn: number; text: string; tool?: string };
  };
}

/** No live run: nothing heard, nothing streaming. */
export const EMPTY_LIVE: LedgerLive = Object.freeze({
  events: Object.freeze([]) as readonly ArcJoinLedgerEventWire[],
  stream: Object.freeze({}),
}) as LedgerLive;

export interface LedgerInput {
  /** The arc's server-owned join facts. */
  join: ArcJoinStateWire | null;
  /** The durable ledger off the entry; null when none stands. */
  durable: ArcJoinLedgerWire | null;
  live: LedgerLive;
  /** The arc's base branch, for "conflicts with <base>". */
  base: string;
  /** Whether a resolve is running on this arc right now. */
  running: boolean;
}

export type LedgerBlockKind =
  | "probe"
  | "ladder"
  | "scribe"
  | "resolver"
  | "audit"
  | "candidate"
  | "stale";

/** A block's identity line: an optional sha and path, then the sentence. */
export interface LedgerIdentity {
  sha?: string;
  path?: string;
  text: string;
}

/** One conflicted path and what the base did to it. */
export interface LedgerConflict {
  path: string;
  history: ArcConflictHistoryWire | null;
}

/** One rung's verdict on one path (or on the arc, for the replay rung). */
export interface LedgerRungRow {
  rung: string;
  path?: string;
  outcome: "resolved" | "declined";
  said: string;
}

/** One file a candidate carries, and what decided it. */
export interface LedgerFileRow {
  path: string;
  fact: string;
}

/** What a block's body holds. */
export type LedgerBody =
  | { kind: "none" }
  | { kind: "commits"; conflicts: LedgerConflict[] }
  | { kind: "rungs"; rows: LedgerRungRow[] }
  | { kind: "scribe-tail"; text: string }
  | { kind: "words"; text: string }
  | { kind: "question"; question: ArcJoinQuestionWire; text?: string }
  | { kind: "audit"; files: ArcJoinReportFileWire[]; notes?: string }
  | { kind: "files"; files: LedgerFileRow[] };

export interface LedgerBlock {
  /** Stable React key: the kind, plus its path or turn. */
  key: string;
  kind: LedgerBlockKind;
  toolName: string;
  identity: LedgerIdentity;
  summary: ToolResultSummary | ToolResultSummary[];
  phase: "in_flight" | "awaiting" | "success" | "error";
  status: "streaming" | "ready" | "error";
  /** The live band's sentence — only on the one in-flight block. */
  live?: string;
  variant: "tool" | "receipt";
  body: LedgerBody;
}

/**
 * Which events stand: the durable ledger, plus whatever the live run has
 * added past it.
 *
 * A live run with a different id is a newer run, and its events replace the
 * durable ones outright — two runs' acts in one ledger would describe a
 * resolve that never happened.
 */
export function mergeLedgerEvents(
  input: Pick<LedgerInput, "durable" | "live">,
): readonly ArcJoinLedgerEventWire[] {
  const { durable, live } = input;
  if (durable === null) return live.events;
  if (live.run !== undefined && live.run !== durable.run) return live.events;
  if (live.run === undefined || live.events.length === 0) return durable.events;
  const last = durable.events.reduce((max, e) => Math.max(max, e.seq), -1);
  const extra = live.events.filter((e) => e.seq > last);
  return extra.length === 0 ? durable.events : [...durable.events, ...extra];
}

const filesWord = (n: number): string => (n === 1 ? "file" : "files");

const duration = (fromMs: number, toMs: number): string => {
  const secs = Math.max(0, Math.round((toMs - fromMs) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
};

/** The one block the in-flight band and the wave ride, while a run is live. */
interface Draft extends Omit<LedgerBlock, "phase" | "status" | "live"> {
  /** True while the block's terminal event has not arrived. */
  open: boolean;
  /** What the band says, if this block turns out to be the live one. */
  liveText?: string;
  /** A resolver asking a question it has had no answer to. */
  awaiting?: boolean;
  /** A candidate the run then took back — withheld by a stuck ending, or
   *  superseded by a head that moved — drawn as the failure it is. */
  withdrawn?: boolean;
}

function probeDraft(
  events: readonly ArcJoinLedgerEventWire[],
  join: ArcJoinStateWire | null,
  base: string,
): Draft | null {
  const event = events.find((e): e is EventOf<"probe"> => e.kind === "probe");
  const paths = event !== undefined ? event.paths : (join?.conflicts ?? []);
  if (paths.length === 0) return null;
  const archaeology =
    event !== undefined ? (event.archaeology ?? []) : (join?.archaeology ?? []);
  const conflicts = paths.map((path) => ({
    path,
    history: archaeology.find((h) => h.path === path) ?? null,
  }));
  const commits = conflicts.reduce((n, c) => n + (c.history?.total ?? 0), 0);
  const identity: LedgerIdentity =
    paths.length === 1
      ? {
          path: paths[0]!,
          text:
            commits > 0
              ? `conflicts with ${base} — ${commits} ${commits === 1 ? "commit" : "commits"} touched it since the fork`
              : `conflicts with ${base}`,
        }
      : { text: `${paths.length} files conflict with ${base}` };
  return {
    key: "probe",
    kind: "probe",
    toolName: "Probe",
    identity,
    summary:
      commits > 0
        ? { kind: "count", count: commits, noun: "commit" }
        : { kind: "count", count: paths.length, noun: "file" },
    variant: "tool",
    body: { kind: "commits", conflicts },
    open: false,
  };
}

function ladderDraft(
  events: readonly ArcJoinLedgerEventWire[],
): Draft | null {
  const rungs = events.filter((e): e is EventOf<"rung"> => e.kind === "rung");
  if (rungs.length === 0) return null;
  const paths = [...new Set(rungs.flatMap((r) => (r.path !== undefined ? [r.path] : [])))];
  const declined = rungs.filter((r) => r.outcome === "declined").length;
  const resolvedBy = [
    ...new Set(rungs.filter((r) => r.outcome === "resolved").map((r) => r.rung)),
  ];
  const handedOn = events.some((e) => e.kind === "scribe" || e.kind === "resolver");
  const over = events.some(
    (e) =>
      e.kind === "scribe" ||
      e.kind === "resolver" ||
      e.kind === "candidate" ||
      e.kind === "ended",
  );
  const distinct = new Set(rungs.map((r) => r.rung)).size;
  const last = rungs[rungs.length - 1]!;
  const replayed = rungs.some((r) => r.rung === "replay" && r.outcome === "resolved");
  const subject = paths.length === 1 ? undefined : paths.length === 0 ? "the arc" : `${paths.length} files`;
  const declinedText = `${declined} ${declined === 1 ? "rung" : "rungs"} declined`;
  // The spike's three readings: a whole-arc replay, a rung that settled it,
  // or every rung declining and handing on.
  const said = replayed
    ? "replayed clean"
    : resolvedBy.length > 0
      ? `resolved by ${resolvedBy.join(" · ")}`
      : handedOn
        ? `${declinedText}, handed to the scribe`
        : declinedText;
  return {
    key: "ladder",
    kind: "ladder",
    toolName: "Ladder",
    identity:
      replayed || subject !== undefined
        ? { text: `${replayed ? "the arc" : subject} — ${said}` }
        : { path: paths[0]!, text: `— ${said}` },
    summary: { kind: "text", text: distinct === 1 ? "rung 1" : `rungs 1–${distinct}` },
    variant: "tool",
    body: {
      kind: "rungs",
      rows: rungs.map((r) => ({
        rung: r.rung,
        ...(r.path !== undefined ? { path: r.path } : {}),
        outcome: r.outcome,
        said: r.said,
      })),
    },
    open: !over,
    liveText: `trying ${last.rung}${last.path !== undefined ? ` on ${last.path}` : ""}`,
  };
}

function scribeDrafts(
  events: readonly ArcJoinLedgerEventWire[],
  live: LedgerLive,
): Draft[] {
  const scribes = events.filter((e): e is EventOf<"scribe"> => e.kind === "scribe");
  const paths = [...new Set(scribes.map((s) => s.path))];
  return paths.map((path) => {
    const mine = scribes.filter((s) => s.path === path);
    const started = mine.find((s) => s.status === "started");
    const end = mine.find((s) => s.status === "resolved" || s.status === "declined");
    const summary: ToolResultSummary[] = [{ kind: "text", text: "rung 5" }];
    if (end?.added !== undefined && end.removed !== undefined) {
      summary.push({ kind: "diff", added: end.added, removed: end.removed });
    }
    if (started !== undefined && end !== undefined) {
      summary.push({ kind: "text", text: duration(started.at_ms, end.at_ms) });
    }
    const tail = live.stream.scribe?.path === path ? live.stream.scribe.text : "";
    return {
      key: `scribe:${path}`,
      kind: "scribe",
      toolName: "Scribe",
      identity: {
        path,
        text:
          end === undefined
            ? "— merging base, ours and theirs"
            : end.status === "resolved"
              ? `— ${end.said !== undefined && end.said !== "" ? end.said : "merged"}`
              : `— declined: ${end.said ?? "the scribe could not merge it"}`,
      },
      summary,
      variant: "tool",
      body:
        end === undefined && tail !== ""
          ? { kind: "scribe-tail", text: tail }
          : { kind: "none" },
      open: end === undefined,
      liveText: `merging ${path}`,
    };
  });
}

function resolverDraft(
  events: readonly ArcJoinLedgerEventWire[],
  join: ArcJoinStateWire | null,
  live: LedgerLive,
): Draft | null {
  const said = events.filter((e): e is EventOf<"resolver"> => e.kind === "resolver");
  const question = join?.question ?? null;
  if (said.length === 0 && question === null) return null;
  const turns = said.filter((e) => e.status === "turn");
  const asked = said.filter((e) => e.status === "asked").length;
  const answered = said.filter((e) => e.status === "answered").length;
  // An ask the run ended without answering — the question's deadline ran out
  // and the run went stuck — waits on nobody any more.
  const runEnded = events.some((e) => e.kind === "ended");
  const awaiting =
    (asked > answered && !runEnded) || (said.length === 0 && question !== null);
  const closed =
    said.some((e) => e.status === "reported") || events.some((e) => e.kind === "ended");
  const lastText = [...turns].reverse().find((e) => e.text !== undefined && e.text !== "")?.text;
  const streaming = live.stream.resolver;
  const text = !closed && streaming !== undefined && streaming.text !== "" ? streaming.text : lastText;
  const turnCount = Math.max(turns.length, streaming?.turn ?? 0);
  // What the resolver was handed: the files no machine rung settled are its to
  // finish; the ones a rung did settle are its to audit.
  const { unresolved, machineResolved } = ladderShare(events);
  return {
    key: "resolver",
    kind: "resolver",
    toolName: "Resolver",
    identity: {
      text: awaiting
        ? "the two sides want different things, and the brief does not decide it"
        : unresolved.length > 0
          ? `finishing ${unresolved.join(", ")}`
          : machineResolved > 0
            ? `auditing ${machineResolved} machine-resolved ${filesWord(machineResolved)} against the arc's intent`
            : "auditing the resolution against the arc's intent",
    },
    summary: {
      kind: "text",
      text: turnCount === 0 ? "turn 1" : `turn ${turnCount}`,
    },
    variant: "tool",
    body:
      awaiting && question !== null
        ? { kind: "question", question, ...(text !== undefined ? { text } : {}) }
        : text !== undefined
          ? { kind: "words", text }
          : { kind: "none" },
    open: !closed && !awaiting,
    awaiting,
    liveText: streaming?.tool ?? "reading the workshop",
  };
}

function auditDraft(
  events: readonly ArcJoinLedgerEventWire[],
  join: ArcJoinStateWire | null,
): Draft | null {
  const reported = [...events]
    .reverse()
    .find((e): e is EventOf<"resolver"> => e.kind === "resolver" && e.status === "reported");
  const fromReport =
    join?.report !== undefined && typeof join.candidate === "string" && join.candidate !== ""
      ? join.report
      : null;
  const files = reported !== undefined ? (reported.files ?? []) : (fromReport?.files ?? []);
  const notes = reported !== undefined ? reported.notes : fromReport?.notes;
  // The one escalation a resolve allows, kept in the account it shaped.
  const askedEvent = events.find(
    (e): e is EventOf<"resolver"> => e.kind === "resolver" && e.status === "asked",
  );
  const answeredEvent = events.find(
    (e): e is EventOf<"resolver"> => e.kind === "resolver" && e.status === "answered",
  );
  const exchange =
    askedEvent?.question !== undefined && answeredEvent?.answer !== undefined
      ? `Asked once — ${askedEvent.question} — and was told: ${answeredEvent.answer}.`
      : undefined;
  const words = [notes, exchange].filter((w): w is string => w !== undefined && w !== "").join("\n\n");
  const hasNotes = words !== "";
  if (files.length === 0 && !hasNotes) return null;
  const turns = events.filter((e) => e.kind === "resolver" && e.status === "turn").length;
  const only = files.length === 1 ? files[0]! : null;
  return {
    key: "audit",
    kind: "audit",
    toolName: "Resolver",
    identity:
      only !== null
        ? {
            path: only.path,
            text: `— audited${only.reconciliation !== undefined && only.reconciliation !== "" ? `: ${only.reconciliation}` : ""}`,
          }
        : { text: `audited ${files.length} ${filesWord(files.length)} against the arc's intent` },
    summary:
      turns > 0
        ? [
            { kind: "count", count: files.length, noun: "file" },
            { kind: "text", text: `${turns} ${turns === 1 ? "turn" : "turns"}` },
          ]
        : { kind: "count", count: files.length, noun: "file" },
    variant: "tool",
    body: { kind: "audit", files, ...(hasNotes ? { notes: words } : {}) },
    open: false,
  };
}

/**
 * What the machine rungs left the resolver: the conflicted paths no rung or
 * scribe settled, and how many they did settle. A whole-arc replay settles
 * every path at once.
 */
function ladderShare(events: readonly ArcJoinLedgerEventWire[]): {
  unresolved: string[];
  machineResolved: number;
} {
  const probe = events.find((e): e is EventOf<"probe"> => e.kind === "probe");
  const paths = probe?.paths ?? [];
  const replayed = events.some(
    (e) => e.kind === "rung" && e.rung === "replay" && e.outcome === "resolved",
  );
  if (replayed) return { unresolved: [], machineResolved: paths.length };
  const settled = new Set<string>();
  for (const e of events) {
    if (e.kind === "rung" && e.outcome === "resolved" && e.path !== undefined) settled.add(e.path);
    if (e.kind === "scribe" && e.status === "resolved") settled.add(e.path);
  }
  return {
    unresolved: paths.filter((p) => !settled.has(p)),
    machineResolved: settled.size,
  };
}

function candidateDraft(
  events: readonly ArcJoinLedgerEventWire[],
  join: ArcJoinStateWire | null,
  durable: ArcJoinLedgerWire | null,
  base: string,
): Draft | null {
  const event = [...events]
    .reverse()
    .find((e): e is EventOf<"candidate"> => e.kind === "candidate");
  const sha =
    event !== undefined
      ? event.sha
      : typeof join?.candidate === "string" && join.candidate !== ""
        ? join.candidate
        : null;
  if (sha === null) return null;
  const files = event !== undefined ? event.files : (join?.resolved ?? []);
  // A clean merge stands a candidate too, having resolved nothing. With no
  // ledger to say otherwise, a candidate that names no resolved file is not
  // evidence of anything, and a receipt over an empty list would say so.
  if (event === undefined && files.length === 0) return null;
  // The ladder tells the ledger "candidate" the moment it anchors, and a
  // moved head (or, in a ledger recorded before the join stopped examining
  // candidates, a stuck ending) can take it back afterwards; the run's ending
  // says so, and a row still reading "anchored" above a stuck line would be a
  // candidate the face vouches for and nothing else does.
  const ending =
    event !== undefined
      ? [...events]
          .reverse()
          .find(
            (e): e is EventOf<"ended"> =>
              e.kind === "ended" && e.seq > event.seq,
          )
      : undefined;
  const withdrawn =
    ending !== undefined && (ending.outcome === "stuck" || ending.outcome === "superseded");
  const summary: ToolResultSummary[] = [
    { kind: "count", count: files.length, noun: "file" },
  ];
  if (durable?.ended_ms !== undefined) {
    summary.push({ kind: "text", text: `${duration(durable.started_ms, durable.ended_ms)} in all` });
  }
  const text = withdrawn
    ? `${ending.outcome === "stuck" ? "withheld" : "superseded"}${
        ending.detail !== undefined && ending.detail !== "" ? ` — ${ending.detail}` : ""
      }`
    : `anchored on ${base} — Join lands it as one commit`;
  return {
    key: "candidate",
    kind: "candidate",
    toolName: "Candidate",
    identity: { sha, text },
    summary,
    variant: "receipt",
    body: {
      kind: "files",
      files: files.map((f) => ({ path: f.path, fact: f.resolved_by })),
    },
    open: false,
    ...(withdrawn ? { withdrawn: true } : {}),
  };
}

/**
 * The REPORT section's blocks, in reading order.
 *
 * One pure decision for every block's identity, summary, phase and body, so
 * the component that draws them maps data onto `BlockChrome` and decides
 * nothing. Exactly one block is in flight at a time — the last whose terminal
 * event has not arrived — and only while a run is live; a resolver waiting on
 * an answer is `awaiting` rather than in flight, because it is waiting on a
 * person and not working.
 *
 * With no ladder events yet (the run's first moments, or a server that does
 * not report its rungs) a live run still draws one Ladder block, so the press
 * has a receipt from the first frame. That holds over a ledger a previous run
 * left too: a live run this page has heard nothing of yet, over a durable
 * ledger that has already ended, is a new run — Resolve again, or the pilot
 * re-running a moved head pair — and the ended ledger is the last run's
 * account, which stands aside rather than being drawn as this run's with
 * nothing in flight.
 */
export function ledgerBlocks(input: LedgerInput): LedgerBlock[] {
  const { join, live, base, running } = input;
  const previous =
    running && live.run === undefined && input.durable?.ended_ms !== undefined;
  const durable = previous ? null : input.durable;
  const events = mergeLedgerEvents({ durable, live });
  const drafts: Draft[] = [];
  const probe = probeDraft(events, join, base);
  if (probe !== null) drafts.push(probe);
  const ladder = ladderDraft(events);
  if (ladder !== null) drafts.push(ladder);
  drafts.push(...scribeDrafts(events, live));
  const resolver = resolverDraft(events, join, live);
  if (resolver !== null) drafts.push(resolver);
  const audit = auditDraft(events, join);
  if (audit !== null) drafts.push(audit);
  const candidate = candidateDraft(events, join, durable, base);
  if (candidate !== null) drafts.push(candidate);

  if (running && ladder === null && !drafts.some((d) => d.open || d.awaiting)) {
    const n = join?.conflicts?.length ?? 0;
    drafts.splice(probe !== null ? 1 : 0, 0, {
      key: "ladder",
      kind: "ladder",
      toolName: "Ladder",
      identity: { text: `Resolving ${n} ${filesWord(n)}` },
      summary: { kind: "text", text: "rung 1" },
      variant: "tool",
      body: { kind: "none" },
      open: true,
      liveText: "working through the ladder",
    });
  }

  let liveIndex = -1;
  if (running) {
    for (let i = drafts.length - 1; i >= 0; i--) {
      if (drafts[i]!.open) {
        liveIndex = i;
        break;
      }
    }
  }

  const blocks: LedgerBlock[] = drafts.map((draft, i) => {
    const { open: _open, liveText, awaiting, withdrawn, ...rest } = draft;
    if (awaiting === true) return { ...rest, phase: "awaiting", status: "ready" };
    if (withdrawn === true) return { ...rest, phase: "error", status: "error" };
    if (i === liveIndex) {
      return {
        ...rest,
        phase: "in_flight",
        status: "streaming",
        ...(liveText !== undefined ? { live: liveText } : {}),
      };
    }
    return { ...rest, phase: "success", status: "ready" };
  });

  const staleNote =
    typeof join?.stale_note === "string" && join.stale_note !== "" ? join.stale_note : null;
  if (staleNote !== null) {
    blocks.push({
      key: "stale",
      kind: "stale",
      toolName: base,
      identity: { text: staleNote },
      summary: { kind: "text", text: "stale" },
      phase: "error",
      status: "error",
      variant: "tool",
      body: { kind: "none" },
    });
  }
  return blocks;
}
