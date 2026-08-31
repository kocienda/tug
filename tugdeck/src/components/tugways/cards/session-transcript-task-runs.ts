/**
 * session-transcript-task-runs.ts — fold a run of consecutive, same-verb
 * `TaskCreate` / `TaskUpdate` markers into a single transcript row.
 *
 * The [D100] second surface renders one `TaskInlineToolBlock` per Task*
 * event, which reads well at the volume that decision assumed (a batch
 * of 4 creates, then creates and completes interleaved one at a time).
 * It does not read well at the volume long sessions actually produce.
 * The task store is scoped to the *session* but the model writes a
 * checklist per *turn*, so the list only grows; there is no bulk clear
 * on the wire, and the only cleanup available is
 * `TaskUpdate status:"deleted"` — one call per task. A session tidying
 * nineteen finished tasks therefore emits nineteen `Deleted` markers in
 * a row, and the transcript paints a wall of them. The cleanup is the
 * mess.
 *
 * A run of identical verbs is one event the reader cares about once, so
 * it becomes one row: `Deleted 19 tasks`, with every subject preserved
 * in the row's detail and tooltip (see `TaskInlineRunBlock`). Nothing is
 * dropped — the same facts occupy one line instead of nineteen.
 *
 * What groups. A member must be a *settled, top-level, non-error* Task*
 * call whose resolved marker state is a real one (never a `creating…` /
 * `updating…` placeholder — an in-flight row's verb is not yet known, so
 * folding it would let the group's identity change under the reader as
 * the input streams in). Members must carry the SAME state: `Created`
 * folds with `Created`, never with `Completed`.
 *
 * What breaks a run. Any other message, without exception — assistant
 * text, a thinking block, a different tool call, a Task* event with a
 * different verb. The rule is deliberately conservative: the transcript's
 * render loop skips a handful of message kinds (nested tool calls, ink
 * messages, a compaction acknowledgement), and rather than mirror that
 * skip list here — where it would silently rot the moment the loop's
 * list changes — a non-member simply ends the run. The cost is a missed
 * merge across an invisible message; the benefit is that a fold can
 * never span a boundary the reader can see.
 *
 * Runs shorter than {@link TASK_RUN_MIN_LENGTH} are left alone. Two
 * markers are not a wall, and two rows show both subjects in full.
 *
 * The module is pure over `Message[]` — no React, no store — so the
 * grouping is testable without mounting the transcript.
 *
 * @module components/tugways/cards/session-transcript-task-runs
 */

import type { Message, ToolUseMessage } from "@/lib/code-session-store";

import {
  composeMarker,
  deriveTaskInlineKind,
  type TaskMarkerState,
} from "./blocks/task-inline-tool-block";

/**
 * Shortest run that folds. A run of two paints two rows: both subjects
 * stay visible and the pair reads as the discrete events they are. At
 * three the column starts to look like a list of its own, which is the
 * shape this fold exists to prevent.
 */
export const TASK_RUN_MIN_LENGTH = 3;

/**
 * A message's place in the grouping. `lead` carries the whole run and
 * renders it; `member` renders nothing (the lead already spoke for it).
 * A message absent from the map is ungrouped and renders as it always
 * has.
 */
export type TaskRunPlacement =
  | {
      role: "lead";
      /** Shared marker state — drives the folded row's glyph. */
      state: TaskMarkerState;
      /** Shared verb — `"Deleted"`, `"Created"`, … */
      verb: string;
      /** Every call in the run, in transcript order, lead first. */
      members: readonly ToolUseMessage[];
    }
  | { role: "member" };

/** A groupable message plus the marker facts the run is keyed on. */
interface Groupable {
  message: ToolUseMessage;
  state: TaskMarkerState;
  verb: string;
}

/**
 * Placeholder states — an event whose verb is not yet settled. They
 * never group; see the module docstring.
 */
const PLACEHOLDER_STATES: ReadonlySet<TaskMarkerState> = new Set<TaskMarkerState>([
  "creating",
  "updating",
  "unknown",
]);

/**
 * Read a message's marker facts, or `null` when it cannot join a run.
 *
 * `tasks` is deliberately empty: the run's identity is its *verb*, and
 * `composeMarker` derives that from the call's own input. The subject
 * needs the fold and is resolved at render time by the row component,
 * which holds the live task list.
 */
function groupableOf(message: Message): Groupable | null {
  if (message.kind !== "tool_use") return null;
  if (message.parentToolUseId !== undefined) return null;
  if (message.status !== "done") return null;
  const kind = deriveTaskInlineKind(message.toolName);
  if (kind === null) return null;
  const { state, verb } = composeMarker({
    kind,
    input: message.input,
    // `ToolBlockProps.status` is the block vocabulary, not the
    // Message's; the `done` guard above is exactly its `ready`.
    status: "ready",
    tasks: [],
  });
  if (PLACEHOLDER_STATES.has(state)) return null;
  return { message, state, verb };
}

/**
 * Group a turn's messages into folded Task* runs, keyed by
 * `messageKey`.
 *
 * Returns an empty map when nothing folds, so the caller's common path
 * is a single `size === 0` check and no per-message lookup.
 */
export function groupTaskMarkerRuns(
  messages: readonly Message[],
): ReadonlyMap<string, TaskRunPlacement> {
  const placements = new Map<string, TaskRunPlacement>();
  let run: Groupable[] = [];

  const flush = (): void => {
    if (run.length >= TASK_RUN_MIN_LENGTH) {
      const [lead] = run;
      placements.set(lead.message.messageKey, {
        role: "lead",
        state: lead.state,
        verb: lead.verb,
        members: run.map((g) => g.message),
      });
      for (const g of run.slice(1)) {
        placements.set(g.message.messageKey, { role: "member" });
      }
    }
    run = [];
  };

  for (const message of messages) {
    const groupable = groupableOf(message);
    if (groupable === null) {
      flush();
      continue;
    }
    if (run.length > 0 && run[0].state !== groupable.state) flush();
    run.push(groupable);
  }
  flush();

  return placements;
}
