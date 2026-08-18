/**
 * spike-transcript-registers.tsx — design spike for the Code-route
 * transcript's Voice-3 content register.
 *
 * The transcript stacks several kinds of content inside one turn: the
 * assistant's prose, tool-call blocks, the two inline dialogs, task
 * lifecycle updates (Created / Started / Completed), and background /
 * system notices (a background command finishing, a scheduled wake, an
 * agent completing). Prose, tool blocks, and the dialogs have had design
 * attention and read as a family. The task updates and the background
 * notices did not — each was styled on its own and rode along beside the
 * prose in ad-hoc styles.
 *
 * This card has narrowed to ONE candidate for those two problem children
 * — the "Quiet line" register: a leading state icon, a label, a muted
 * subject, and an optional trailing meta, one row per event, sharing the
 * tool-call header's line geometry so a run of notices reads in the
 * transcript's row rhythm. Both families — background/system notices and
 * task lifecycle — flow through the one grammar; the background family
 * reads one step quieter (a lighter label in the subtle tone), and the
 * rare error row is the one place danger color is spent. The register
 * reads color from the real muted / subtle text tokens rather than the
 * `opacity: 0.55` fade the current background lines use, so it is
 * theme-correct and scannable.
 *
 * Two zones:
 *   1. REFERENCE — the real neighbors mounted live (prose, a tool block,
 *      the permission dialog, and the CURRENT task-update + background
 *      renderings) so the register is judged against what ships.
 *   2. QUIET LINE — the candidate: two in-situ scenarios reconstructing
 *      the screenshots (a background-origin turn + a mid-turn task batch)
 *      against real prose, then a catalog of real-world event types in
 *      the grammar.
 *
 * @module components/tugways/cards/gallery-transcript-registers
 */

import "./spike.css";
import type { SpikeDef } from "./spike-registry";
import "./spike-transcript-registers.css";

import React from "react";
import {
  AlarmClock,
  Bot,
  CalendarClock,
  CircleAlert,
  CircleCheck,
  Clock,
  History,
  ListPlus,
  RotateCcw,
  Scissors,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";

import { BashToolBlock } from "@/components/tugways/cards/blocks/bash-tool-block";
import { TaskInlineToolBlock } from "@/components/tugways/cards/blocks/task-inline-tool-block";
import type { ToolBlockProps } from "@/components/tugways/blocks/types";
import { PermissionDialog } from "@/components/tugways/chrome/session-permission-dialog";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugMarkdownBlock } from "@/components/tugways/tug-markdown-block";
import { TugQuietLine, type TugQuietLineTone } from "@/components/tugways/tug-quiet-line";
import { TugSeparator } from "@/components/tugways/tug-separator";
import type {
  CodeSessionSnapshot,
  CodeSessionStore,
  ControlRequestForward,
} from "@/lib/code-session-store";

// ---------------------------------------------------------------------------
// Shared fixture text — the two screenshots this spike reconstructs.
// ---------------------------------------------------------------------------

const PROSE_WAKE =
  "The re-run is green across the board — the chain-FR wait plus the settle delays fixed the flake. Committing Step 7.";
const PROSE_TASKS_LEAD =
  "While the build runs, let me update task states and write a test covering the new behaviors — the saveAs-outcome propagation and the danger-default seed are exactly the kind of thing the audit flagged as untested.";
const PROSE_TASKS_TAIL =
  "Let me look at the store test's fake to write a faithful saveAs-failure test.";

/** The tasks the mock session "knows about", so `TaskUpdate` rows resolve
 *  real subjects instead of the bare `Task #<id>` fallback. */
const TASK_DEFS: ReadonlyArray<{ id: number; subject: string }> = [
  { id: 1, subject: "Route tab-× close through the close guard" },
  { id: 2, subject: "Resolve sheet preemption instead of orphaning promises" },
  { id: 3, subject: "Propagate saveAs failure outcome" },
  { id: 4, subject: "Make conflict-sheet Return default non-destructive" },
  { id: 5, subject: "Goal-turn lifecycle plumbing" },
];

// ---------------------------------------------------------------------------
// Event data for the candidate rows — hand-authored markup (a NEW design;
// the reference zone shows the real current rendering).
// ---------------------------------------------------------------------------

type EventTone = TugQuietLineTone;

interface EventDatum {
  icon: React.ReactNode;
  /** The bold verb / notice ("Completed", "Background command completed").
   *  Omitted for the error row, whose message rides the subject slot. */
  label?: string;
  subject?: string;
  meta?: string;
  tone?: EventTone;
}

const ICON = 16;
const ic = (I: typeof Terminal): React.ReactNode => (
  <I size={ICON} aria-hidden="true" />
);

const BG_EVENT: EventDatum = {
  icon: ic(Terminal),
  label: "Background command completed",
  subject: '"Re-run at0212 with chain-FR wait + settles"',
  meta: "exit 0",
  tone: "quiet",
};

const WAKE_EVENT: EventDatum = {
  icon: ic(AlarmClock),
  label: "Scheduled wake-up",
  subject: "loop pacing",
  tone: "quiet",
};

const TASK_EVENTS: ReadonlyArray<EventDatum> = [
  {
    icon: ic(CircleCheck),
    label: "Completed",
    subject: "Route tab-× close through the close guard",
    tone: "primary",
  },
  {
    icon: ic(CircleCheck),
    label: "Completed",
    subject: "Resolve sheet preemption instead of orphaning promises",
    tone: "primary",
  },
  {
    icon: ic(Wrench),
    label: "Started",
    subject: "Goal-turn lifecycle plumbing",
    tone: "primary",
  },
];

// A catalog of real-world Voice-3 events, both families, exercising the
// grammar's slots: label-only, subject, trailing meta, danger tone, and a
// long subject that wraps below row 1.
const CATALOG_SYSTEM: ReadonlyArray<EventDatum> = [
  {
    icon: ic(Terminal),
    label: "Background command completed",
    subject: '"cargo nextest run"',
    meta: "exit 0",
    tone: "quiet",
  },
  {
    icon: ic(Terminal),
    label: "Background command failed",
    subject: '"bunx vite build"',
    meta: "exit 1",
    tone: "danger",
  },
  {
    icon: ic(AlarmClock),
    label: "Scheduled wake-up",
    subject: "loop pacing",
    meta: "every 20m",
    tone: "quiet",
  },
  {
    icon: ic(Clock),
    label: "Wake scheduled",
    subject: "watching CI run",
    meta: "in 4m",
    tone: "quiet",
  },
  {
    icon: ic(CalendarClock),
    label: "Cron fired",
    subject: "babysit-prs",
    tone: "quiet",
  },
  {
    icon: ic(Bot),
    label: "Agent finished",
    subject: "Map transcript content renderers",
    meta: "49K tokens",
    tone: "quiet",
  },
  {
    icon: ic(Search),
    label: "Searched for a tool",
    tone: "quiet",
  },
  {
    icon: ic(Scissors),
    label: "Context compacted",
    subject: "freed ~48% of the window",
    tone: "quiet",
  },
  {
    icon: ic(History),
    label: "Session resumed",
    subject: "39 turns restored",
    tone: "quiet",
  },
];

const CATALOG_TASK: ReadonlyArray<EventDatum> = [
  {
    icon: ic(ListPlus),
    label: "Created",
    subject: "Goal-turn lifecycle plumbing",
    tone: "primary",
  },
  {
    icon: ic(Wrench),
    label: "Started",
    subject: "Probe /loop modes and retest resume scheduler",
    tone: "primary",
  },
  {
    icon: ic(CircleCheck),
    label: "Completed",
    subject:
      "Make conflict-sheet Return default non-destructive so a stray keypress never overwrites the file on disk",
    tone: "primary",
  },
  {
    icon: ic(RotateCcw),
    label: "Reset",
    subject: "Decision gate — resolve Q01–Q04",
    tone: "primary",
  },
  {
    icon: ic(CircleAlert),
    subject: "TaskUpdate failed: task #9 not found",
    tone: "danger",
  },
];

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

function Prose({ text }: { text: string }): React.ReactElement {
  return <TugMarkdownBlock initialText={text} className="gtr-prose" />;
}

/** Faux turn frame — a muted identifier line + a body column, so a run of
 *  candidate events can be judged in a transcript-like context. */
function TurnFrame({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="gtr-turn">
      <div className="gtr-turn-id">{id}</div>
      <div className="gtr-turn-body">{children}</div>
    </div>
  );
}

/** One event as a quiet line — the real `TugQuietLine` primitive. */
function EventLine({ d }: { d: EventDatum }): React.ReactElement {
  return (
    <TugQuietLine
      icon={d.icon}
      label={d.label}
      subject={d.subject}
      meta={d.meta}
      tone={d.tone}
    />
  );
}

/** A group of quiet lines with the wider Voice-3 inter-item margin. */
function EventGroup({
  items,
}: {
  items: ReadonlyArray<EventDatum>;
}): React.ReactElement {
  return (
    <div className="gtr-group">
      {items.map((d, i) => (
        <EventLine key={i} d={d} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// In-situ scenarios — the two screenshots in the quiet-line register.
// ---------------------------------------------------------------------------

function InSitu(): React.ReactElement {
  return (
    <div className="gtr-panel">
      <TurnFrame id="Opus 4.8 · 1M">
        <EventGroup items={[BG_EVENT, WAKE_EVENT]} />
        <Prose text={PROSE_WAKE} />
      </TurnFrame>
      <TurnFrame id="Fable 5 · 11:41:23">
        <Prose text={PROSE_TASKS_LEAD} />
        <EventGroup items={TASK_EVENTS} />
        <Prose text={PROSE_TASKS_TAIL} />
      </TurnFrame>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reference zone — real components on mock data.
// ---------------------------------------------------------------------------

/** A mock `CodeSessionStore` whose snapshot carries the `TASK_DEFS` as
 *  committed `TaskCreate` events, so `TaskInlineToolBlock`'s `TaskUpdate`
 *  rows resolve real subjects through `useTaskListState`. Only the two
 *  fields that hook reads (`transcript`, `activeTurn`) are populated. */
function makeMockTaskSession(): CodeSessionStore {
  const messages = TASK_DEFS.map((t, i) => ({
    kind: "tool_use" as const,
    toolUseId: `mock-create-${i}`,
    toolName: "TaskCreate",
    input: { subject: t.subject },
    status: "done" as const,
    result: `Task #${t.id} created successfully: ${t.subject}`,
    structuredResult: null,
    toolWallMs: null,
    messageKey: `mk-${i}`,
    createdAt: 0,
  }));
  const snapshot = {
    transcript: [{ messages }],
    activeTurn: null,
  } as unknown as CodeSessionSnapshot;
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  } as unknown as CodeSessionStore;
}

function taskProps(partial: Partial<ToolBlockProps>): ToolBlockProps {
  return {
    toolUseId: "ref-task",
    toolName: "TaskUpdate",
    seq: 0,
    status: "ready",
    ...partial,
  } as ToolBlockProps;
}

const REF_COMMAND: ToolBlockProps = {
  toolUseId: "ref-bash",
  toolName: "Bash",
  seq: 0,
  input: { command: "bunx vite build 2>&1 | tail -8" },
  structuredResult: {
    stdout:
      "vite v5.4.0 building for production...\n✓ 1421 modules transformed.\n✓ built in 2.14s\n",
    stderr: "",
    interrupted: false,
  },
  isError: false,
  status: "ready",
  durationMs: 2140,
};

const REF_PERMISSION: ControlRequestForward = {
  request_id: "gtr-perm",
  is_question: false,
  tool_name: "Bash",
  input: { command: "git commit -am 'settle killed shell exchange'" },
  permission_suggestions: [
    {
      behavior: "allow",
      destination: "project",
      rules: [{ ruleContent: "Bash(git commit)", toolName: "Bash" }],
      type: "addRule",
    },
  ],
};

interface PermSnapshot {
  pendingApproval: ControlRequestForward | null;
}

/** Minimal permission store double — mirrors the pattern in
 *  `gallery-tug-inline-dialog.tsx`. */
class MockPermissionStore {
  private _snapshot: PermSnapshot;
  constructor(initial: ControlRequestForward) {
    this._snapshot = { pendingApproval: initial };
  }
  subscribe = (): (() => void) => () => {};
  getSnapshot = (): PermSnapshot => this._snapshot;
  respondApproval = (): void => {};
}

function ReferenceZone(): React.ReactElement {
  const session = React.useMemo(makeMockTaskSession, []);
  const permStore = React.useMemo(
    () => new MockPermissionStore(REF_PERMISSION),
    [],
  );

  return (
    <div className="gtr-panel">
      <div className="gtr-ref-label">Assistant prose</div>
      <Prose text={PROSE_TASKS_LEAD} />

      <div className="gtr-ref-label">Tool block</div>
      <BashToolBlock {...REF_COMMAND} />

      <div className="gtr-ref-label">
        Task updates — current (<code>TaskInlineToolBlock</code>)
      </div>
      <TaskInlineToolBlock
        {...taskProps({
          toolName: "TaskCreate",
          input: { subject: "Goal-turn lifecycle plumbing" },
        })}
      />
      <TaskInlineToolBlock
        {...taskProps({
          input: { taskId: "5", status: "in_progress" },
          session,
        })}
      />
      <TaskInlineToolBlock
        {...taskProps({
          input: { taskId: "1", status: "completed" },
          session,
        })}
      />
      <TaskInlineToolBlock
        {...taskProps({
          input: { taskId: "2", status: "pending" },
          session,
        })}
      />
      <TaskInlineToolBlock
        {...taskProps({
          input: { taskId: "3", subject: "Propagate saveAs failure to the caller" },
          session,
        })}
      />
      <TaskInlineToolBlock
        {...taskProps({
          input: { taskId: "4", status: "deleted" },
          session,
        })}
      />
      <TaskInlineToolBlock
        {...taskProps({
          status: "error",
          textOutput: "TaskUpdate failed: task #9 not found",
          session,
        })}
      />
      <TaskInlineToolBlock
        {...taskProps({
          toolName: "TaskCreate",
          status: "error",
          textOutput:
            "InputValidationError: TaskCreate failed due to the following " +
            "issues: The required parameter `subject` is missing The required " +
            "parameter `description` is missing An unexpected parameter " +
            "`prompt` was provided This call used Agent-tool parameters " +
            "(`prompt`/`subagent_type`). TaskCreate adds an item to the task " +
            "list and takes `subject` and `description` string parameters. To " +
            "delegate work to a subagent, use the Agent tool instead.",
          session,
        })}
      />

      <div className="gtr-ref-label">
        Background notice — before this rollout (wake-trigger,{" "}
        <code>opacity: 0.55</code> + trailing rule; the live transcript now
        uses the Quiet line below)
      </div>
      <div className="gtr-current-wake">
        <span className="gtr-current-wake-label">
          Background command "Re-run at0212 with chain-FR wait + settles"
          completed (exit code 0)
        </span>
      </div>

      <div className="gtr-ref-label">Permission dialog</div>
      <PermissionDialog
        input={{ kind: "permission", request: REF_PERMISSION }}
        context={{ session: permStore as unknown as CodeSessionStore }}
      />
      <div className="gtr-ref-note">
        The full <code>QuestionDialog</code> walkthrough lives in the{" "}
        <code>TugInlineDialog</code> gallery card — it is out of scope here
        (already designed).
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export function SpikeTranscriptRegisters(): React.ReactElement {
  return (
    <div className="sp-content" data-testid="gallery-transcript-registers">
      <div className="sp-section">
        <TugLabel className="sp-section-title">Reference — the neighbors</TugLabel>
        <div className="gtr-blurb">
          Real components on mock data. The candidate below is judged against
          these. The two problem children — task updates and background
          notices — are shown here in their CURRENT form.
        </div>
        <ReferenceZone />
      </div>

      <TugSeparator />

      <div className="sp-section">
        <TugLabel className="sp-section-title">Quiet line — in situ</TugLabel>
        <div className="gtr-blurb">
          The candidate: icon · label · muted subject · trailing meta, one row
          per event, sharing the tool-call header's line geometry. Both
          families flow through it — background/system notices read one step
          quieter than task steps. Real muted / subtle tokens, no card, wider
          inter-item margin, and prose at the transcript's own body size.
        </div>
        <InSitu />
      </div>

      <TugSeparator />

      <div className="sp-section">
        <TugLabel className="sp-section-title">
          Quiet line — real-world catalog
        </TugLabel>
        <div className="gtr-blurb">
          The grammar across the event types it has to carry — with and
          without a subject, with a trailing meta, the danger row, and a long
          subject that wraps while the icon + label stay pinned to row 1.
        </div>
        <div className="gtr-ref-label">Background &amp; system notices</div>
        <EventGroup items={CATALOG_SYSTEM} />
        <div className="gtr-ref-label">Task lifecycle</div>
        <EventGroup items={CATALOG_TASK} />
      </div>
    </div>
  );
}

export const spike: SpikeDef = {
  name: "transcript-registers",
  title: "Transcript Registers",
  blurb: "Can task updates and background notices join the transcript's content family instead of each being styled on its own?",
  component: () => <SpikeTranscriptRegisters />,
};
