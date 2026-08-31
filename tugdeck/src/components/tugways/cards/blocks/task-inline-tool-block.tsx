/**
 * `TaskInlineToolBlock` — Layer-2 marker for `TaskCreate` and
 * `TaskUpdate` events.
 *
 * The [D100] task list has two complementary surfaces. The TASKS
 * status-bar cell on `Z2` is the canonical surface for *current
 * state* (the assembled list, one fixed glance away). This wrapper
 * is the second surface — a per-call inline marker in the
 * transcript so a reader scrolling back can see *when in the
 * conversation flow* each task action happened. The two surfaces
 * never duplicate work: the cell answers "what's on the list now?";
 * the marker answers "when did this happen?".
 *
 * Folded runs. One marker per event is the right grain at the volume
 * [D100] assumed and the wrong one at the volume long sessions reach:
 * the task store is scoped to the session but the model writes a
 * checklist per turn, so the list only grows, and there is no clear
 * event on the wire — tidying it means one
 * `TaskUpdate status:"deleted"` per task. A sweep of nineteen therefore
 * painted nineteen rows saying the same thing. A run of same-verb
 * markers now folds into one {@link TaskInlineRunBlock} row
 * (`Deleted 19 tasks`, every subject in the detail and the tooltip);
 * `groupTaskMarkerRuns` in `session-transcript-task-runs.ts` decides
 * which runs qualify, and short runs still render per event.
 *
 * Presentation. The wrapper composes `TugQuietLine` — the shared
 * Voice-3 event row — in the `primary` tone: a per-state icon, the
 * verb as the label, and the subject as the muted detail. It opts
 * out of `BlockChrome` (no frame, no status stripe, no actions
 * cluster); `TugQuietLine` gives it the tool-call header's line
 * geometry so a run of markers reads in the transcript's row rhythm
 * while staying lighter than a real tool-call card. The icon carries
 * the state by *shape* (a static glyph, not the header's animated
 * lifecycle dot) — task events are discrete, terminal state changes,
 * not live phases. The error row switches `TugQuietLine` to the
 * `danger` tone; the wrapper owns only the inter-row margin.
 *
 * Per-event reading. The row is `[icon] Verb subject` — the verb is
 * the bold header "name", the subject the muted detail (the
 * block-header name/detail mapping). The icon carries the state by
 * shape:
 *  - `TaskCreate` → `ListPlus` + `"Created"` + subject (subject is
 *    in the input — narrowed via `narrowTaskCreateInput`).
 *  - `TaskUpdate → in_progress` → `Wrench` + `"Started"`.
 *  - `TaskUpdate → completed` → `CircleCheck` + `"Completed"`.
 *  - `TaskUpdate → pending` → `RotateCcw` + `"Reset"` (rare —
 *    explicit revert from a non-pending status; defensive coverage
 *    of a valid wire value the design didn't specify a verb for).
 *  - `TaskUpdate → deleted` → `CircleMinus` + `"Deleted"`. The task
 *    is removed from the fold, so the subject resolves by id.
 *  - `TaskUpdate` with no `status` → `Pencil` + `"Edited"` — a rename
 *    or description change. The subject is the update's own new
 *    `subject` when it carries one, since the fold still holds the
 *    pre-edit text.
 *  - `TaskUpdate` with unknown `taskId` → subject falls back to
 *    `"Task #<taskId>"` (the matching `TaskCreate` may have arrived
 *    out of order in replay; the bare id is the least-misleading
 *    thing we can render).
 *  - Streaming (input still arriving) → `ListChecks` + `"Creating…"`
 *    / `"Updating…"` placeholder, no subject.
 *  - Errored event → `CircleAlert` + error text, both danger-tinted
 *    (`data-tone="danger"`). A recognised `InputValidationError`
 *    condenses to `Rejected` + a one-line parameter summary with the
 *    full paragraph in the tooltip — see
 *    {@link composeTaskInlineErrorRow}; any other error text rides the
 *    subject slot verbatim.
 *
 * Why muted-icon, not role-colored. An earlier draft proposed
 * `role="action"` for Created / Started and `role="success"` for
 * Completed — colored accents per event. The audit volume of these
 * events in a real session is high enough (often 8–12 per turn for
 * a multi-task plan) that role-coloring pulls weight away from the
 * TASKS cell. So the state is carried by icon *shape*, not hue: the
 * icon stays muted and the verb reads in the header's normal text
 * tone. Color is reserved for the rare error case, where it earns
 * the visual interrupt.
 *
 * `subject` lookup for `TaskUpdate`. The wire only carries
 * `taskId`. The wrapper resolves `subject` by reading the
 * `useTaskListState(session)` reducer state and indexing by
 * `taskId`. When `session` is unavailable (the gallery card
 * supplies none), the wrapper falls back to the `Task #<id>` form
 * — no React-hook violation because the conditional split happens
 * at the component level (outer routes to an inner component that
 * unconditionally calls the hook), not inside a single component
 * with a conditional hook call.
 *
 * Laws:
 *  - [L02] external state enters React through `useSyncExternalStore`
 *    — via `useTaskListState` (which already conforms).
 *  - [L06] no React state for appearance — every visible variant
 *    is a JSX choice driven by props + the reducer-resolved
 *    subject.
 *  - [L19] file pair (`.tsx` + `.css`), exported props interface,
 *    `data-slot="task-inline-tool-block"`, this module docstring.
 *  - [L20] component-token sovereignty — owns only the
 *    `--tugx-task-inline-row-margin` slot (inter-row spacing);
 *    the row's geometry + color come from `TugQuietLine`.
 *
 * Decisions:
 *  - [D05] two-layer hybrid — but the chrome layer is intentionally
 *    absent here; the wrapper IS the body.
 *  - [D100] two-surface task list — this wrapper is the second
 *    surface (TASKS cell is the first); D100's prose was amended to
 *    acknowledge both.
 *  - [D101] visibility policy — `taskcreate` / `taskupdate` move
 *    from `hidden` to bespoke when this wrapper ships; the policy
 *    entries are removed in the same change.
 *
 * @module components/tugways/cards/blocks/task-inline-tool-block
 */

import "./task-inline-tool-block.css";

import React from "react";
import {
  CircleAlert,
  CircleCheck,
  CircleMinus,
  ListChecks,
  ListPlus,
  Pencil,
  RotateCcw,
  Wrench,
} from "lucide-react";

import {
  narrowTaskCreateInput,
  narrowTaskUpdateInput,
  type TaskItem,
  type TaskWireStatus,
} from "@/lib/code-session-store/select-task-list";
import { useTaskListState } from "@/lib/code-session-store/hooks/use-task-list-state";
import type { CodeSessionStore, ToolUseMessage } from "@/lib/code-session-store";
import { TugQuietLine } from "@/components/tugways/tug-quiet-line";
import { TugTooltip } from "@/components/tugways/tug-tooltip";

import type { ToolBlockProps } from "../../blocks/types";

// ---------------------------------------------------------------------------
// Verb derivation
// ---------------------------------------------------------------------------

/** Marker event kind — which Task* tool produced this row. */
export type TaskInlineKind = "create" | "update";

/**
 * Pick the kind from the original tool name. Returns `null` for an
 * unrecognised name (defensive — keeps the wrapper from crashing on
 * a future Task* variant). Case-insensitive.
 *
 * Exported for the gallery card and the tests.
 */
export function deriveTaskInlineKind(toolName: string): TaskInlineKind | null {
  const normalised = toolName.toLowerCase();
  if (normalised === "taskcreate") return "create";
  if (normalised === "taskupdate") return "update";
  return null;
}

// ---------------------------------------------------------------------------
// Label composition — the user-visible string for each event variant.
// Exported as a pure helper so the test suite can pin every branch
// without rendering.
// ---------------------------------------------------------------------------

/**
 * What the marker says for a `TaskCreate` event with subject and
 * status. The status is always the wire's default of `pending` at
 * create time, so the helper takes only the subject.
 */
export function composeCreatedLabel(subject: string): string {
  return `Created: ${subject}`;
}

/**
 * What the marker says for a `TaskUpdate` event. The verb tracks
 * the new status (`Started` for `in_progress`, `Completed` for
 * `completed`, `Reset` for `pending`, `Deleted` for `deleted`), the
 * subject comes from the reducer's lookup, and the helper formats
 * them together. A status-free update — a rename or a description
 * edit — reads as `Edited`.
 */
export function composeUpdatedLabel(
  status: TaskWireStatus | undefined,
  subjectOrId: string,
): string {
  return `${updateVerb(status)}: ${subjectOrId}`;
}

function updateVerb(status: TaskWireStatus | undefined): string {
  switch (status) {
    case "in_progress":
      return "Started";
    case "completed":
      return "Completed";
    case "pending":
      return "Reset";
    case "deleted":
      return "Deleted";
    case undefined:
      return "Edited";
  }
}

/**
 * The resolved marker state — drives both the per-state icon and
 * (with `verb`) the row's text. A single enum keeps the icon and
 * the verb from drifting: every render reads both off the one
 * `composeMarker` result.
 */
export type TaskMarkerState =
  | "created"
  | "started"
  | "completed"
  | "reset"
  | "deleted"
  | "edited"
  | "creating"
  | "updating"
  | "unknown";

function updateState(status: TaskWireStatus | undefined): TaskMarkerState {
  switch (status) {
    case "in_progress":
      return "started";
    case "completed":
      return "completed";
    case "pending":
      return "reset";
    case "deleted":
      return "deleted";
    case undefined:
      return "edited";
  }
}

/**
 * Resolve a `subject` for a `TaskUpdate`'s `taskId` against the
 * reducer's task list. Falls back to `Task #<taskId>`.
 *
 * The fallback covers two cases. The rare one is replay-out-of-order,
 * where the matching `TaskCreate` hasn't been folded yet. The routine
 * one is a `deleted` update: the list handed here is the *settled*
 * fold, and the task it names is by then removed from it — so a
 * `Deleted` marker reads by id rather than by subject.
 *
 * Exported for tests.
 */
export function resolveUpdateSubject(
  taskId: string,
  tasks: readonly TaskItem[],
): string {
  const item = tasks.find((t) => t.taskId === taskId);
  return item !== undefined ? item.subject : `Task #${taskId}`;
}

// ---------------------------------------------------------------------------
// Error-row composition
// ---------------------------------------------------------------------------

/** The error row's two text parts plus the untruncated text for the tooltip. */
export interface TaskInlineErrorRow {
  /** The bold verb — `"Rejected"` for a parsed validation error, absent otherwise. */
  label?: string;
  /** The muted detail — the condensed summary, or the raw text when unparsed. */
  subject: string;
  /** The full original error text; `undefined` when `subject` already is it. */
  full?: string;
}

/** `The required parameter \`x\` is missing` — one match per offending field. */
const MISSING_PARAM_RE = /required parameter `([^`]+)` is missing/g;

/** `An unexpected parameter \`x\` was provided` — one match per offending field. */
const UNEXPECTED_PARAM_RE = /unexpected parameter `([^`]+)` was provided/g;

/** `InputValidationError: TaskCreate failed due to the following issues:` */
const VALIDATION_TOOL_RE = /InputValidationError:\s*([A-Za-z][A-Za-z0-9_]*) failed/;

function collectAll(re: RegExp, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(re)) out.push(m[1]);
  return out;
}

/**
 * Condense an errored task event into one scannable line.
 *
 * Claude Code's `InputValidationError` is prose: it names the tool,
 * enumerates every offending parameter, then restates the tool's
 * contract and the correct alternative. That paragraph is written for
 * the model that must repair the call, and the model has already read
 * it by the time the row paints. What the reader needs is the fact of
 * the rejection and which parameters were wrong — four lines of red
 * body copy for a call the assistant re-issues correctly on the next
 * turn reads as a system fault it isn't.
 *
 * So a recognised validation error collapses to
 * `Rejected  TaskCreate — missing subject, description; unexpected prompt`,
 * with the full paragraph preserved in the row's tooltip. Anything
 * that doesn't parse falls through to the raw text unchanged: an
 * unrecognised error is exactly the case where truncation would hide
 * the one detail that mattered.
 *
 * Exported for tests.
 */
export function composeTaskInlineErrorRow(
  textOutput: string | undefined,
): TaskInlineErrorRow {
  if (textOutput === undefined || textOutput.length === 0) {
    return { subject: "Failed" };
  }
  if (!textOutput.includes("InputValidationError")) {
    return { subject: textOutput };
  }

  const toolName = VALIDATION_TOOL_RE.exec(textOutput)?.[1];
  const missing = collectAll(MISSING_PARAM_RE, textOutput);
  const unexpected = collectAll(UNEXPECTED_PARAM_RE, textOutput);

  const issues: string[] = [];
  if (missing.length > 0) issues.push(`missing ${missing.join(", ")}`);
  if (unexpected.length > 0) issues.push(`unexpected ${unexpected.join(", ")}`);

  // A validation error we can name but not itemise still condenses —
  // the generic "invalid parameters" beats the full paragraph, and the
  // tooltip keeps the specifics one hover away.
  const detail = issues.length > 0 ? issues.join("; ") : "invalid parameters";
  const subject =
    toolName !== undefined ? `${toolName} — ${detail}` : detail;

  return { label: "Rejected", subject, full: textOutput };
}

// ---------------------------------------------------------------------------
// Component — outer / inner split so the optional `session` doesn't
// drive a conditional hook call.
// ---------------------------------------------------------------------------

export const TaskInlineToolBlock: React.FC<ToolBlockProps> = (props) => {
  // Rules-of-hooks discipline: the inner component always calls
  // `useTaskListState` unconditionally. We pick the inner component
  // based on whether `session` is defined, so the chosen subtree's
  // hook chain stays uniform across renders within the same subtree.
  if (props.session !== undefined) {
    return (
      <TaskInlineWithSession
        baseProps={props}
        session={props.session}
      />
    );
  }
  return <TaskInlineRow baseProps={props} tasks={EMPTY_TASKS} />;
};

const EMPTY_TASKS: readonly TaskItem[] = Object.freeze([]);

interface WithSessionProps {
  baseProps: ToolBlockProps;
  session: CodeSessionStore;
}

const TaskInlineWithSession: React.FC<WithSessionProps> = ({
  baseProps,
  session,
}) => {
  const { tasks } = useTaskListState(session);
  return <TaskInlineRow baseProps={baseProps} tasks={tasks} />;
};

interface RowProps {
  baseProps: ToolBlockProps;
  tasks: readonly TaskItem[];
}

/** Source size for every marker glyph — see {@link markerIcon}. */
const MARKER_ICON_SIZE = 16;

/**
 * The per-state glyph. State is carried by *shape*, not color (the
 * icon stays muted via CSS — see "Why muted-icon" in the module
 * docstring); the error glyph is the one exception, danger-tinted
 * via the row's `data-tone`. The streaming / unknown placeholders
 * keep the original `ListChecks` so an in-flight row reads as
 * "a task event, kind not yet known".
 */
function markerIcon(state: TaskMarkerState): React.ReactNode {
  switch (state) {
    case "created":
      return <ListPlus size={MARKER_ICON_SIZE} aria-hidden="true" />;
    case "started":
      return <Wrench size={MARKER_ICON_SIZE} aria-hidden="true" />;
    case "completed":
      return <CircleCheck size={MARKER_ICON_SIZE} aria-hidden="true" />;
    case "reset":
      return <RotateCcw size={MARKER_ICON_SIZE} aria-hidden="true" />;
    case "deleted":
      return <CircleMinus size={MARKER_ICON_SIZE} aria-hidden="true" />;
    case "edited":
      return <Pencil size={MARKER_ICON_SIZE} aria-hidden="true" />;
    case "creating":
    case "updating":
    case "unknown":
      return <ListChecks size={MARKER_ICON_SIZE} aria-hidden="true" />;
  }
}

const TaskInlineRow: React.FC<RowProps> = ({ baseProps, tasks }) => {
  const { toolName, input, textOutput, status } = baseProps;
  const kind = deriveTaskInlineKind(toolName);

  // Error branch: surface the error with a danger tint carried by the
  // row's `data-tone` (icon + text both tint via CSS). A recognised
  // `InputValidationError` condenses to a verb + one-line summary with
  // the full paragraph in the tooltip; anything else rides the subject
  // slot verbatim, with no verb, as it always has. When `textOutput` is
  // missing on an errored event (rare — `tool_result.is_error` true
  // without an output body), the composer yields a generic "Failed" so
  // the marker isn't a blank danger row.
  if (status === "error") {
    const { label, subject, full } = composeTaskInlineErrorRow(textOutput);
    const subjectNode =
      full !== undefined ? (
        <TugTooltip content={full} side="bottom">
          <span data-slot="task-inline-tool-block-error-detail">{subject}</span>
        </TugTooltip>
      ) : (
        subject
      );
    return (
      <div
        className="task-inline-tool-block"
        data-slot="task-inline-tool-block"
        data-kind={kind ?? undefined}
      >
        <TugQuietLine
          icon={<CircleAlert size={MARKER_ICON_SIZE} aria-hidden="true" />}
          label={label}
          subject={subjectNode}
          tone="danger"
        />
      </div>
    );
  }

  // Steady / streaming branch — block-header geometry: a leading
  // per-state icon slot, the verb as the bold header "name", and
  // the subject as the muted detail. Placeholder rows (streaming /
  // unknown) carry a verb but no subject.
  const { state, verb, subject } = composeMarker({ kind, input, status, tasks });
  return (
    <div
      className="task-inline-tool-block"
      data-slot="task-inline-tool-block"
      data-kind={kind ?? undefined}
      data-state={state}
    >
      <TugQuietLine
        icon={markerIcon(state)}
        label={verb}
        subject={subject.length > 0 ? subject : undefined}
        tone="primary"
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Folded run — one row for a run of same-verb markers.
// ---------------------------------------------------------------------------

/**
 * A run of consecutive same-verb markers, folded into one row.
 *
 * The per-event marker is the right grain for the volume [D100]
 * assumed. It is the wrong grain for a bulk sweep: there is no clear
 * event on the wire, so tidying nineteen finished tasks means nineteen
 * `TaskUpdate status:"deleted"` calls, and nineteen marker rows — a wall
 * whose whole content is "the assistant emptied the list." The fold
 * turns that into `Deleted 19 tasks`, subjects intact in the detail and
 * the tooltip. Which runs qualify is decided upstream by
 * `groupTaskMarkerRuns` (`session-transcript-task-runs.ts`); this
 * component only draws one.
 *
 * The row is the marker's own grammar — same `TugQuietLine`, same
 * state glyph, same `primary` tone — so a folded row and a single row
 * read as the same kind of thing at different counts. The only
 * addition is `data-run`, which the stylesheet uses to clip the
 * subject list to one line; the tooltip carries what the ellipsis hid,
 * exactly as the error row does.
 */
export interface TaskInlineRunBlockProps {
  /** Shared marker state — every member resolved to this one. */
  state: TaskMarkerState;
  /** Shared verb — `"Deleted"`, `"Created"`, … */
  verb: string;
  /** The run's calls, in transcript order. */
  members: readonly ToolUseMessage[];
  /** Session store for the subject lookup; absent in the gallery. */
  session?: CodeSessionStore;
}

/**
 * The folded row's bold label — the shared verb over the count.
 *
 * Always plural: the fold's minimum length is 3, so the singular can
 * never arise, and spelling a branch for it would be dead code that
 * reads as though a one-member run were possible. Exported for tests.
 */
export function composeTaskRunLabel(verb: string, count: number): string {
  return `${verb} ${count} tasks`;
}

/**
 * Resolve each member's subject, in run order, exactly as the
 * per-event row would have.
 *
 * A `deleted` run resolves to `Task #<id>` for every member and that is
 * correct, not a degradation: the fold handed here is the settled one,
 * and a deleted task is gone from it — the same fallback the single
 * marker takes for the same reason ({@link resolveUpdateSubject}).
 *
 * Exported for tests.
 */
export function resolveTaskRunSubjects(
  members: readonly ToolUseMessage[],
  tasks: readonly TaskItem[],
): string[] {
  return members.map((m) => {
    const { subject } = composeMarker({
      kind: deriveTaskInlineKind(m.toolName),
      input: m.input,
      // Every member is a settled call — `groupTaskMarkerRuns` admits
      // no other — so the block vocabulary's `ready` is exact.
      status: "ready",
      tasks,
    });
    return subject;
  });
}

export const TaskInlineRunBlock: React.FC<TaskInlineRunBlockProps> = (props) => {
  // Same outer / inner split as the single marker: the optional
  // `session` picks the subtree, never a conditional hook call.
  if (props.session !== undefined) {
    return <TaskInlineRunWithSession baseProps={props} session={props.session} />;
  }
  return <TaskInlineRunRow baseProps={props} tasks={EMPTY_TASKS} />;
};

interface RunWithSessionProps {
  baseProps: TaskInlineRunBlockProps;
  session: CodeSessionStore;
}

const TaskInlineRunWithSession: React.FC<RunWithSessionProps> = ({
  baseProps,
  session,
}) => {
  const { tasks } = useTaskListState(session);
  return <TaskInlineRunRow baseProps={baseProps} tasks={tasks} />;
};

interface RunRowProps {
  baseProps: TaskInlineRunBlockProps;
  tasks: readonly TaskItem[];
}

const TaskInlineRunRow: React.FC<RunRowProps> = ({ baseProps, tasks }) => {
  const { state, verb, members } = baseProps;
  const detail = resolveTaskRunSubjects(members, tasks)
    .filter((s) => s.length > 0)
    .join(" · ");
  return (
    <div
      className="task-inline-tool-block"
      data-slot="task-inline-tool-block"
      data-kind={deriveTaskInlineKind(members[0].toolName) ?? undefined}
      data-state={state}
      data-run="true"
    >
      <TugQuietLine
        icon={markerIcon(state)}
        label={composeTaskRunLabel(verb, members.length)}
        subject={
          detail.length > 0 ? (
            <TugTooltip content={detail} side="bottom">
              <span data-slot="task-inline-tool-block-run-detail">{detail}</span>
            </TugTooltip>
          ) : undefined
        }
        tone="primary"
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Marker-text composition — the per-event branching, kept as a pure
// helper so the test suite can pin every label without mounting.
// ---------------------------------------------------------------------------

interface ComposeArgs {
  kind: TaskInlineKind | null;
  input: unknown;
  status: ToolBlockProps["status"];
  tasks: readonly TaskItem[];
}

/** The marker's resolved state + its two text parts. */
export interface TaskMarker {
  state: TaskMarkerState;
  /** The bold header "name" — `Created` / `Started` / a placeholder. */
  verb: string;
  /** The muted detail — the task subject; empty for placeholder rows. */
  subject: string;
}

/**
 * Resolve a non-error event to its state + verb + subject. The one
 * pure surface every non-error row reads: the component maps
 * `state` → icon and renders `verb` + `subject` as the header
 * name + detail. Exported for tests.
 */
export function composeMarker({
  kind,
  input,
  status,
  tasks,
}: ComposeArgs): TaskMarker {
  // Streaming branch — input is still arriving; we may not yet have
  // a subject (TaskCreate) or a taskId (TaskUpdate). Fall back to
  // the streaming placeholder (verb only, no subject).
  if (status === "streaming") {
    if (kind === "create") return { state: "creating", verb: "Creating…", subject: "" };
    if (kind === "update") return { state: "updating", verb: "Updating…", subject: "" };
    return { state: "unknown", verb: "…", subject: "" };
  }
  if (kind === "create") {
    const narrowed = narrowTaskCreateInput(input);
    if (narrowed === undefined) return { state: "creating", verb: "Creating…", subject: "" };
    return { state: "created", verb: "Created", subject: narrowed.subject };
  }
  if (kind === "update") {
    const narrowed = narrowTaskUpdateInput(input);
    if (narrowed === undefined) return { state: "updating", verb: "Updating…", subject: "" };
    // A rename carries the new subject in its own input, and that is
    // what the row should say — the fold's copy is the pre-edit text.
    const subject =
      narrowed.subject ?? resolveUpdateSubject(narrowed.taskId, tasks);
    return { state: updateState(narrowed.status), verb: updateVerb(narrowed.status), subject };
  }
  // Defensive — an unrecognised kind shouldn't reach here, but the
  // wrapper renders a neutral placeholder rather than crashing.
  return { state: "unknown", verb: "Task event", subject: "" };
}

/**
 * The marker's visible text as one string (`"Verb: subject"`, or
 * just the verb for a placeholder row). Derived from
 * {@link composeMarker} so the verb words have one source. Exported
 * for tests.
 */
export function composeMarkerText(args: ComposeArgs): string {
  const { verb, subject } = composeMarker(args);
  return subject.length > 0 ? `${verb}: ${subject}` : verb;
}
