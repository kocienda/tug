/**
 * `TodoListBlock` — Layer-1 body kind for a Claude Code task list.
 *
 * The user-facing concept is "todo list", which is why the component
 * keeps that name; the data it consumes follows the wire vocabulary
 * Anthropic's `claude` ≥ `v2.1.148` ships — {@link TaskListState} /
 * {@link TaskItem}, assembled by the
 * `code-session-store/select-task-list` reducer over the
 * `TaskCreate` / `TaskUpdate` event stream ([D100]).
 *
 * A list-shaped body kind ([#bk-conformance] item 9): rows are
 * rendered via `TugListView` (in `inline` mode for now — task lists
 * are typically a handful of items; the row count never warrants
 * windowing in practice). Building on `TugListView` anyway keeps the
 * data-source contract and cell vocabulary in step with the other
 * list-shaped body kinds (`PathListBlock`, `SearchResultBlock`), so
 * a future windowing opt-in is a flip of one prop.
 *
 * Composition (mirrors `PathListBlock`):
 *  - Header (standalone only) — an optional identity `label`, the
 *    item-count summary, and a trailing actions cluster (Copy). In
 *    `embedded` mode the header is suppressed and the cluster portals
 *    into the host `BlockChrome`'s actions slot.
 *  - Body — a `TugListView` in `inline` mode. The block grows to its
 *    natural height and the outer transcript scrolls; no inner
 *    scroller. Each row is `[status-icon] [text]` with the status
 *    driving the icon, text decoration, and (for `in_progress`) the
 *    activeForm rendering. When a task carries a `description`, the
 *    row trigger is wrapped in a `TugTooltip` so the longer prose
 *    surfaces on hover without growing the row's vertical footprint
 *    ([D100]).
 *
 * Status states:
 *  - `pending` — circle icon; default colour.
 *  - `in_progress` — spinner-style icon; **highlighted** background
 *    band so the active task is immediately distinguishable. The row
 *    renders `activeForm` (present-continuous, e.g. "Running tests")
 *    when present; otherwise falls back to `subject`.
 *  - `completed` — check icon; strikethrough text + muted colour so
 *    finished work fades into the row history.
 *
 * What this body kind does NOT do:
 *  - Render a text-entry / edit surface. A card has at most one
 *    text-entry surface ([#bk-conformance] item 2); editing a task is
 *    the assistant's job, not the renderer's. TodoListBlock renders
 *    zero `<input>` / `<textarea>` elements.
 *  - Persist the list itself — the reducer over the wire event
 *    stream is the source of truth.
 *  - Animate transitions between status changes — the next reducer
 *    snapshot remounts the row with its new status; that's enough.
 *
 * Laws:
 *  - [L06] no React state for visual state — status colours / text
 *    decoration are pure CSS keyed off the row's `data-status`.
 *  - [L11] no responder; Copy is a `BlockCopyButton` (self-contained
 *    control).
 *  - [L19] file pair (`.tsx` + `.css`), exported props interface,
 *    `data-slot="todo-list-body"` on the root, this docstring.
 *  - [L20] component-token sovereignty — owns `--tugx-todo-*`;
 *    consumes `--tugx-block-*` for the shared block scaffold.
 *
 * Decisions:
 *  - [D05] two-layer split: this body kind owns the list rendering;
 *    the pinned `Z2A` renderer (`SessionCardPinnedTodo`) is its sole
 *    consumer post-[D100].
 *  - [D100] pinned `Z2A` slot; standalone composition; per-row
 *    description in a tooltip.
 *
 * @module components/tugways/body-kinds/todo-list-block
 */

import "./todo-list-block.css";

import React from "react";
import { createPortal } from "react-dom";

import { useChromeActionsTarget } from "@/components/tugways/blocks/block-chrome";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import {
  TugProgressIndicator,
} from "@/components/tugways/tug-progress-indicator";
import {
  TugListView,
  type TugListViewCellProps,
  type TugListViewCellRenderer,
  type TugListViewDataSource,
} from "@/components/tugways/tug-list-view";
import { taskRowState } from "@/lib/code-session-store/indicator-liveness";
import type {
  TaskItem,
  TaskListState,
  TaskStatus,
} from "@/lib/code-session-store/select-task-list";

import { BlockActionsCluster, BlockCopyButton } from "./affordances";

// Re-export so consumers needing the shape don't reach across layers.
export type { TaskItem, TaskListState, TaskStatus };

// ---------------------------------------------------------------------------
// Public props
// ---------------------------------------------------------------------------

export interface TodoListBlockProps {
  /**
   * The task list — assembled by `reduceTaskListState` and passed
   * down by the pinned `Z2A` renderer (or any standalone caller).
   * When undefined or `tasks` is empty, the block renders an empty
   * `data-slot="todo-list-body"` marker for layout consistency.
   */
  data?: TaskListState;

  /**
   * Optional identity label shown at the leading edge of the
   * standalone header. Ignored in `embedded` mode — the host owns
   * identity there.
   */
  label?: string;

  /**
   * "Embedded" mode — composed inside a host that already paints a
   * container and a header (e.g. `BlockChrome`). When `true` the
   * standalone frame + header are dropped and the actions cluster
   * portals into the host chrome's actions slot. MUST be used under a
   * `BlockChrome`.
   *
   * Today the only intended caller is the standalone pinned
   * (`embedded={false}`) renderer for `Z2A`; the embedded path is
   * preserved for future wrappers that might compose the list inside
   * their own chrome.
   *
   * @default false
   */
  embedded?: boolean;

  /**
   * Quiescent gate — when `true`, the in_progress row's progress
   * indicator renders in its `stopped` state instead of the default
   * running animation. Use to keep the row visually quiet when the
   * surrounding session is idle (matching the status-bar TASKS
   * ring's stopped gate). Pending and completed rows are unaffected.
   * @default false
   */
  idle?: boolean;

  /** Forwarded class name for cascade-scoped customization. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported because tests pin them
// ---------------------------------------------------------------------------

/** Per-status counts derived from a task array. */
export interface TaskCounts {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
}

/**
 * Tally tasks by status. Items whose `status` falls outside the
 * known vocabulary count toward `total` but not toward any bucket,
 * so the counts always sum to ≤ `total` — drift surfaces visibly
 * (the progress bar doesn't lie about progress).
 */
export function countTasks(tasks: readonly TaskItem[]): TaskCounts {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  for (const t of tasks) {
    if (t.status === "pending") pending += 1;
    else if (t.status === "in_progress") inProgress += 1;
    else if (t.status === "completed") completed += 1;
  }
  return { total: tasks.length, pending, inProgress, completed };
}

/**
 * Compose a one-liner summary of the counts for the standalone
 * header. Format: `"3 done, 1 in progress, 2 pending"` — drops zero
 * buckets so the summary stays short. Returns the empty string when
 * the list is empty.
 */
export function composeTaskSummary(counts: TaskCounts): string {
  if (counts.total === 0) return "";
  const parts: string[] = [];
  if (counts.completed > 0) parts.push(`${counts.completed} done`);
  if (counts.inProgress > 0) parts.push(`${counts.inProgress} in progress`);
  if (counts.pending > 0) parts.push(`${counts.pending} pending`);
  return parts.join(", ");
}

/**
 * Progress fraction in `[0, 1]` — `completed / total`. Returns `0`
 * for an empty list. In-progress items intentionally do NOT count
 * as partial credit; the bar reads as the share of *finished* work,
 * which matches the assistant's mental model and the spoken summary.
 */
export function taskProgressFraction(counts: TaskCounts): number {
  if (counts.total === 0) return 0;
  return counts.completed / counts.total;
}

/**
 * Build the plain-text representation of a task list — used by the
 * Copy affordance. Each line: `[ ] subject` / `[~] activeForm` /
 * `[x] subject`. The pending / in-progress / completed glyphs mirror
 * GitHub-flavored markdown task list conventions with a `~` for
 * in-progress (no markdown equivalent, but readable).
 *
 * `preferActiveForm` (default `true`) renders an in-progress task's
 * present-continuous `activeForm` when present — the pinned
 * `TodoListBlock` behaviour. Pass `false` to copy the stable `subject`
 * for every row, matching the Tasks popover which shows `subject`
 * uniformly so the copied text never diverges from what's on screen.
 */
export function composeTaskCopyText(
  tasks: readonly TaskItem[],
  preferActiveForm = true,
): string {
  return tasks
    .map((t) => {
      const glyph =
        t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]";
      const text =
        preferActiveForm &&
        t.status === "in_progress" &&
        t.activeForm !== undefined
          ? t.activeForm
          : t.subject;
      return `${glyph} ${text}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TASK_CELL_KIND = "task";
const DATA_SLOT_ROOT = "todo-list-body";
const DATA_SLOT_HEADER = "todo-list-header";
const DATA_SLOT_ACTIONS = "todo-list-actions";

// ---------------------------------------------------------------------------
// Data source — immutable per instance
// ---------------------------------------------------------------------------

const NOOP_UNSUBSCRIBE = (): void => {};

/**
 * A `TugListView` data source over an immutable task array. A fresh
 * instance is built every time `data.tasks` identity changes — the
 * source never mutates in place, so `subscribe` is a no-op and
 * `getVersion` returns the array reference (stable per instance,
 * distinct across instances).
 */
class TaskListDataSource implements TugListViewDataSource {
  constructor(
    private readonly tasks: readonly TaskItem[],
    /**
     * Mirrors the session's idle gate so the in_progress row can
     * pass `state="stopped"` into its progress indicator. The
     * `useMemo` keying TodoListBlock's data source includes `idle`,
     * so an idle flip produces a fresh instance and re-renders the
     * cells with the new indicator state.
     */
    readonly idle: boolean,
  ) {}

  numberOfItems(): number {
    return this.tasks.length;
  }

  idForIndex(index: number): string {
    // The server-assigned `taskId` is the stable React key; tasks
    // are never re-keyed once created.
    return this.tasks[index].taskId;
  }

  kindForIndex(): string {
    return TASK_CELL_KIND;
  }

  subscribe(): () => void {
    return NOOP_UNSUBSCRIBE;
  }

  getVersion(): unknown {
    return this.tasks;
  }

  taskAt(index: number): TaskItem {
    return this.tasks[index];
  }
}

// ---------------------------------------------------------------------------
// Cell renderer
// ---------------------------------------------------------------------------

function TaskRowIcon({
  status,
  idle,
}: {
  status: TaskStatus;
  idle: boolean;
}): React.ReactElement {
  return (
    <TugProgressIndicator
      variant="pulsing-dot"
      size={14}
      state={taskRowState(status, idle)}
      aria-hidden="true"
    />
  );
}

/**
 * One task row — `[status-icon] [text]`. The status drives the icon,
 * the text variant (subject vs. activeForm), and the visual
 * treatment via the row's `data-status` attribute (CSS owns colour,
 * weight, and strikethrough — pure [L06]). The in_progress row's
 * icon is a {@link TugProgressIndicator} ring driven by
 * `dataSource.idle` so it stops cleanly when the surrounding session
 * is idle. When
 * `description` is present, the row is wrapped in a `TugTooltip` so
 * the longer prose surfaces on hover; the row body stays
 * single-line.
 *
 * Sanctioned custom cell (not `TugListRow`) per the list-view house
 * rules (`tuglaws/list-view-usage.md`): the per-status background band,
 * strikethrough-on-completed decoration, live progress-ring icon, and
 * per-status wrap behavior are not the title/subtitle row model, and
 * expressing them through `TugListRow` would mean overriding the
 * primitive's internals ([L20]) and losing the checklist's density.
 */
const TaskCell: TugListViewCellRenderer<TaskListDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<TaskListDataSource>) => {
  const task = dataSource.taskAt(index);
  const text =
    task.status === "in_progress" && task.activeForm !== undefined
      ? task.activeForm
      : task.subject;

  const row = (
    <div
      className="tugx-todo-row"
      data-slot="todo-list-row"
      data-status={task.status}
    >
      <span className="tugx-todo-row-icon" aria-hidden="true">
        <TaskRowIcon status={task.status} idle={dataSource.idle} />
      </span>
      <span className="tugx-todo-row-text">{text}</span>
    </div>
  );

  if (task.description === undefined) return row;
  return (
    <TugTooltip content={task.description} side="top" align="start">
      {row}
    </TugTooltip>
  );
};

/** Cell-renderer dispatch map — module-scope, one entry. */
const CELL_RENDERERS: Record<string, TugListViewCellRenderer<TaskListDataSource>> = {
  [TASK_CELL_KIND]: TaskCell,
};

// ---------------------------------------------------------------------------
// React component
// ---------------------------------------------------------------------------

export const TodoListBlock: React.FC<TodoListBlockProps> = ({
  data,
  label,
  embedded = false,
  idle = false,
  className,
}) => {
  const tasks = data?.tasks ?? EMPTY_TASKS;
  const dataSource = React.useMemo(
    () => new TaskListDataSource(tasks, idle),
    [tasks, idle],
  );

  // ---- Copy source ---------------------------------------------------
  //
  // `tasksRef` carries the live list so the `BlockCopyButton`
  // `getText` closure reads the freshest items at fire time ([L07]).
  const tasksRef = React.useRef<readonly TaskItem[]>(tasks);
  React.useLayoutEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);
  const getCopyText = React.useCallback(
    () => composeTaskCopyText(tasksRef.current),
    [],
  );

  // ---- Chrome actions target (embedded composition) ------------------
  const chromeActionsTarget = useChromeActionsTarget();

  // Dev-mode misconfiguration check — `embedded={true}` requires a
  // parent `BlockChrome` or the actions cluster has nowhere to
  // portal. Mirrors `PathListBlock`'s deferred-warn pattern.
  React.useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (!embedded) return;
    if (chromeActionsTarget !== null) return;
    const handle = window.setTimeout(() => {
      console.warn(
        "TodoListBlock: `embedded={true}` requires a parent " +
          "`BlockChrome`. Without one the actions cluster (Copy) " +
          "has nowhere to portal and the user loses access to it " +
          "silently. Either compose under a chrome or set " +
          "`embedded={false}`.",
      );
    }, 0);
    return () => {
      window.clearTimeout(handle);
    };
  }, [embedded, chromeActionsTarget]);

  // ---- Empty data: layout-consistent marker --------------------------
  if (tasks.length === 0) {
    return (
      <div
        data-slot={DATA_SLOT_ROOT}
        data-empty="true"
        data-embedded={embedded ? "true" : undefined}
        className={
          className === undefined ? "tugx-todo" : `tugx-todo ${className}`
        }
      />
    );
  }

  const rootClass =
    "tugx-todo" + (className === undefined ? "" : ` ${className}`);

  // The actions cluster — Copy only (no sort: task order is
  // producer-assigned and meaningful, not user-tunable like
  // PathList's "found" vs. "name").
  // Under a chrome the header owns Copy; with no body-specific controls,
  // the todo list portals nothing. The standalone header still carries Copy.
  const actions = embedded ? null : (
    <BlockCopyButton
      data-slot="todo-list-copy"
      aria-label="Copy todo list"
      getText={getCopyText}
    />
  );

  const portaledActions =
    embedded && chromeActionsTarget !== null && actions !== null
      ? createPortal(
          <BlockActionsCluster data-slot={DATA_SLOT_ACTIONS}>
            {actions}
          </BlockActionsCluster>,
          chromeActionsTarget,
        )
      : null;

  const counts = countTasks(tasks);
  const summary = composeTaskSummary(counts);

  return (
    <div
      data-slot={DATA_SLOT_ROOT}
      data-empty="false"
      data-embedded={embedded ? "true" : undefined}
      className={rootClass}
    >
      {embedded ? null : (
        <div className="tugx-todo-header" data-slot={DATA_SLOT_HEADER}>
          {label !== undefined ? (
            <span className="tugx-todo-label" data-slot="todo-list-label">
              {label}
            </span>
          ) : null}
          <span className="tugx-todo-summary" data-slot="todo-list-summary">
            {summary}
          </span>
          <span className="tugx-todo-header-spacer" />
          <BlockActionsCluster data-slot={DATA_SLOT_ACTIONS}>
            {actions}
          </BlockActionsCluster>
        </div>
      )}
      {portaledActions}

      {/* `inline` — every row in document order, no windowing. The
       * block grows to its natural height; the outer transcript owns
       * the scroll. */}
      <TugListView<TaskListDataSource>
        dataSource={dataSource}
        cellRenderers={CELL_RENDERERS}
        className="tugx-todo-list"
        inline
      />
    </div>
  );
};

/** Stable empty-array sentinel so the empty-data path doesn't create
 *  a fresh `[]` per render. */
const EMPTY_TASKS: readonly TaskItem[] = Object.freeze([]);
