/**
 * spike-join-arc.tsx — every state between "built" and "joined", redesigned.
 *
 * The question this spike asks: what does the dash/join arc look like when the
 * machine does its stretch first and the user is asked once, at a decision —
 * with every act confined to Z5 (or a summoned prompt), and the Changes shade
 * demoted to a glance that carries no controls at all?
 *
 * The status vocabulary is deliberately not new UI: every register and the
 * join progress line wear the transcript's own tool-call header chrome
 * (`BlockHeader` — the Quiet Line), so the lifecycle pulsing dot carries the
 * state and the strip itself stays calm. A red verdict is red (`danger`), on
 * the dot, the tier line, and the Z5 button alike.
 *
 * @module spikes/spike-join-arc
 */

import "./spike.css";
import "./spike-join-arc.css";

import React from "react";
import {
  ArrowUp,
  Check,
  EllipsisVertical,
  GitCommitHorizontal,
  MessageSquareText,
} from "lucide-react";

import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugChoiceGroup } from "@/components/tugways/tug-choice-group";
import { TugConfirmPopover } from "@/components/tugways/tug-confirm-popover";
import { TugEntryShell } from "@/components/tugways/tug-entry-shell";
import { PencilSparkles } from "@/components/tugways/tug-icons";
import { BlockHeader } from "@/components/tugways/blocks/block-header";
import type { ToolCallPhase } from "@/lib/code-session-store/tool-call-phase-visual";
import {
  QuestionWizard,
  type ParsedQuestion,
} from "@/components/tugways/chrome/session-question-dialog";
import { DashMetaLine } from "@/components/tugways/dash-meta-line";
import { DashSigil } from "@/components/tugways/dash-sigil";
import type { DashChangesetEntry } from "@/lib/changeset-types";
import type { SpikeDef } from "./spike-registry";

// ---------------------------------------------------------------------------
// Fixture data — one dash, mid-arc, shaped like the wire shapes it.
// ---------------------------------------------------------------------------

const ENTRY: DashChangesetEntry = {
  kind: "dash",
  owner_id: "tugdash/imposer2#spike",
  display_name: "imposer2",
  branch: "tugdash/imposer2",
  stage: "built",
  bound_sessions: [],
  step_current: 12,
  step_total: 12,
  step_title: "Integration checkpoint",
  last_activity: new Date(Date.now() - 9 * 60_000).toISOString(),
  plan_path: "roadmap/layout-imposer-plan-2.md",
  review: "reviewed",
  base: "main",
  rounds: 4,
  worktree: "/Users/kocienda/Mounts/u/src/tugtool/.tug/workshops/imposer2",
  worktree_dirty: false,
  files: [],
};

/** The prompt at built — the one ask, arriving with the facts already run. */
const PROMPT_QUESTIONS: ReadonlyArray<ParsedQuestion> = [
  {
    question: "imposer2 is built and reconciled with main — join it?",
    multiSelect: false,
    options: [
      {
        label: "Join now",
        description:
          "Lands the squash with the drafted message. The reconciled tree built clean.",
      },
      {
        label: "Review first",
        description:
          "Opens join mode: the message in the composer, the glance showing what lands. The composer's ⬆ joins.",
      },
      {
        label: "Not yet",
        description:
          "The dash stays built. Join later from the Lens row or /join.",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// The arc strip — who owns each stretch.
// ---------------------------------------------------------------------------

interface ArcStage {
  word: string;
  owner: "machine" | "user";
  note: string;
}

const ARC: readonly ArcStage[] = [
  { word: "built", owner: "machine", note: "the run marks it; the draft is written" },
  {
    word: "reconciling",
    owner: "machine",
    note: "merge preview · resolve if needed · build check — before any ask",
  },
  { word: "decision", owner: "user", note: "one prompt: join, review, or later" },
  { word: "joining", owner: "machine", note: "squash · teardown · unbind — narrated, never silent" },
  { word: "joined", owner: "machine", note: "the row leaves; the session says so" },
];

function ArcStrip(): React.ReactElement {
  return (
    <div className="sp-ja-arc">
      {ARC.map((stage) => (
        <div className="sp-ja-arc-stage" key={stage.word} data-owner={stage.owner}>
          <span className="sp-ja-arc-word">{stage.word}</span>
          <span className="sp-ja-arc-owner">
            {stage.owner === "machine" ? "machine" : "you"}
          </span>
          <span className="sp-ja-arc-note">{stage.note}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status registers — the tool-call header chrome, reused.
//
// Not new UI: each register is the transcript's own `BlockHeader` — the
// lifecycle dot carries the state (running action, running caution, settled
// success, settled danger), the sentence is the target, and the state word
// rides the trailing summary the way a tool result does. The strip surface is
// the header's own quiet one; no tinted bands.
// ---------------------------------------------------------------------------

interface StatusRow {
  state: string;
  phase: ToolCallPhase;
  line: string;
}

const STATUS_ROWS: readonly StatusRow[] = [
  {
    state: "reconciling",
    phase: "in_flight",
    line: "Reconciling with main — resolving 3 files",
  },
  {
    state: "checking",
    phase: "in_flight",
    line: "Building the joined tree — 40s",
  },
  { state: "ready", phase: "success", line: "Ready to join" },
  {
    state: "question",
    phase: "awaiting",
    line: "The resolver needs a decision — answer the prompt",
  },
  {
    state: "checks-red",
    phase: "error",
    line: "Build red on the joined tree — join is a decision now",
  },
  {
    state: "wire-drop",
    phase: "idle",
    line: "Connection dropped — the run continues on the server",
  },
];

function StatusRegister({ row }: { row: StatusRow }): React.ReactElement {
  return (
    <div className="sp-ja-register">
      <BlockHeader
        phase={row.phase}
        target={row.line}
        summary={{ kind: "text", text: row.state }}
      />
    </div>
  );
}

/**
 * The joining stretch, narrated — the same header chrome, in flight. One
 * line, mounted wherever the join was launched: it replaces the prompt's
 * body on a dialog join, and it rides the composer's status row on a Z5
 * join. The beats trail as pipe-sections the way a tool result's counts do;
 * the clock keeps honest time until the transcript row takes over.
 */
function JoinProgressLine(): React.ReactElement {
  return (
    <div className="sp-ja-register">
      <BlockHeader
        phase="in_flight"
        toolName="Join"
        target="imposer2 → main — tearing down the workshop"
        summary={[
          { kind: "text", text: "✓ squash" },
          { kind: "text", text: "✓ record" },
          { kind: "text", text: "▸ teardown" },
          { kind: "text", text: "release" },
          { kind: "text", text: "14s" },
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The disposition ledger — every control the shade carries today, judged.
// Editorial commentary on the redesign, not proposed chrome.
// ---------------------------------------------------------------------------

interface Disposition {
  control: string;
  verdict: "delete" | "move";
  where: string;
  why: string;
}

const DISPOSITIONS: readonly Disposition[] = [
  {
    control: "RESOLVE / RESOLVE AGAIN",
    verdict: "delete",
    where: "the machine runs it",
    why: "Reconciling starts itself at built and restarts itself when the base moves. A button asking the user to start machine work is the arc inverted.",
  },
  {
    control: "VERIFY",
    verdict: "delete",
    where: "the machine runs it",
    why: "The build check runs eagerly, before attention is requested. Nobody should ever see an 'unverified' state with a button.",
  },
  {
    control: "JOIN ANYWAY",
    verdict: "move",
    where: "becomes the Z5 confirm",
    why: "A red is a decision, not an error. The join press itself carries it: over a red verdict, ⬆ raises a confirm naming the failures.",
  },
  {
    control: "RESUME TEARDOWN",
    verdict: "delete",
    where: "the machine runs it",
    why: "The join journal is durable; an interrupted teardown resumes itself on reconnect. The glance reports it; nobody presses it.",
  },
  {
    control: "UNBIND",
    verdict: "move",
    where: "moves into the row's ⋯ menu",
    why: "A rare lifecycle verb, not a resting control. It keeps working; it stops shouting.",
  },
  {
    control: "DISCARD",
    verdict: "move",
    where: "moves into the row's ⋯ menu",
    why: "Destructive and rare. Keeps its confirm; loses its permanent red button.",
  },
];

// ---------------------------------------------------------------------------
// The composer in join mode, at shipped sizes.
// ---------------------------------------------------------------------------

/** The Z4B commit-cluster chips ([D119] Table T01), as the session card
 *  mounts them: `size="sm" emphasis="tinted" layout="label-top"`. */
function JoinClusterChips(): React.ReactElement {
  return (
    <>
      <TugPushButton size="sm" emphasis="tinted" role="action" layout="label-top" label="Project">
        tugtool
      </TugPushButton>
      <TugPushButton size="sm" emphasis="tinted" role="action" layout="label-top" label="Dash">
        ^imposer2 · 4 rounds
      </TugPushButton>
    </>
  );
}

/** The Z4A route group, exactly as the entry mounts it: two invariant
 *  segments, `value="changes"` while a landing mode is up. */
function JoinRouteGroup(): React.ReactElement {
  return (
    <TugChoiceGroup
      items={[
        {
          value: "prompt",
          label: "Prompt",
          icon: <MessageSquareText strokeWidth={2} />,
        },
        {
          value: "changes",
          label: "Changes",
          icon: <GitCommitHorizontal strokeWidth={2} />,
        },
      ]}
      value="changes"
      size="xs"
      aria-label="Route"
    />
  );
}

type JoinPose = "ready" | "red" | "joining";

/**
 * The composer, posed. Everything chrome-level is the shipped component at
 * its shipped size: `TugEntryShell` for the frame and toolbar geometry, the
 * route group at `xs`, the cluster chips at `sm`, and the Z5 rail's two
 * `size="lg"` icon buttons — `PencilSparkles size={16}` outlined accent,
 * `ArrowUp size={16}` filled — exactly as `tug-prompt-entry` mounts them in
 * a landing mode. Over a red verdict the join button takes the existing
 * `danger` role; the press raises the confirm. Only the editor substrate is
 * a static stand-in.
 *
 * There is no ✕ in Z5, matching shipping: cancel lives at the shade's header
 * and on ⎋ / ⌘. — the rail is auto-message + the act.
 */
function ComposerPose({ pose }: { pose: JoinPose }): React.ReactElement {
  const railRef = React.useRef<HTMLDivElement | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  return (
    <TugEntryShell
      className="sp-ja-shell"
      statusRow={
        pose === "joining" ? (
          <JoinProgressLine />
        ) : pose === "red" ? (
          <StatusRegister row={STATUS_ROWS[4]!} />
        ) : undefined
      }
      toolbarLeading={<JoinRouteGroup />}
      toolbarCenter={<JoinClusterChips />}
      toolbarTrailing={
        <div className="sp-ja-rail" ref={railRef}>
          <TugPushButton
            subtype="icon"
            size="lg"
            emphasis="outlined"
            role="accent"
            aria-label="Auto-message"
            disabled={pose === "joining"}
            icon={<PencilSparkles size={16} strokeWidth={2} />}
          />
          <TugPushButton
            subtype="icon"
            size="lg"
            emphasis="filled"
            role={pose === "red" ? "danger" : "action"}
            aria-label="Join"
            disabled={pose === "joining"}
            onClick={pose === "red" ? () => setConfirmOpen(true) : undefined}
            icon={<ArrowUp size={16} strokeWidth={2.5} />}
          />
          {pose === "red" ? (
            <TugConfirmPopover
              open={confirmOpen}
              anchorEl={railRef.current}
              side="top"
              arrow
              message="The build is red on the joined tree. Join anyway?"
              confirmLabel="Join anyway"
              confirmRole="danger"
              onConfirm={() => setConfirmOpen(false)}
              onCancel={() => setConfirmOpen(false)}
            />
          ) : null}
        </div>
      }
    >
      <div className="sp-ja-editor" data-joining={pose === "joining" ? "" : undefined}>
        tugdash(imposer2): remap round ids after base replay
        {"\n\n"}
        Repair the regression built into the layout imposer rollout: round ids
        are remapped after the base replay so a member pane never strands.
      </div>
    </TugEntryShell>
  );
}

// ---------------------------------------------------------------------------
// The spike body.
// ---------------------------------------------------------------------------

function SpikeJoinArc(): React.ReactElement {
  return (
    <div className="sp-content">
      <section className="sp-section">
        <h2 className="sp-section-title">The arc, and who owns each stretch</h2>
        <p className="sp-ja-prose">
          Today the arc ends with prose: a report whose last line is a slash
          command, a shade full of buttons, and a verification that starts only
          when the user opens it. The redesign is one rule applied five times:{" "}
          <strong>
            the machine works first, the user decides once, and every act lives
            in Z5 or a summoned prompt.
          </strong>{" "}
          Status is never a control. The shade is a glance. And nothing hides:
          every fact behind a decision is on screen when the decision is asked.
        </p>
        <ArcStrip />
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">The prompt at built</h2>
        <p className="sp-ja-prose">
          When a dash reaches built, the machine immediately reconciles: merge
          preview, the resolution ladder if the base moved, and the build check
          over the joined tree. Only then does it ask — with the shipped
          question surface, so the answer is one keypress. Every option states
          a fact that already happened, never a promise. If the resolver hit an
          intent conflict, <em>that</em> question arrives here instead, and the
          join prompt follows the answer.
        </p>
        <div className="sp-ja-prompt-frame">
          <QuestionWizard
            requestId="spike-join-arc-prompt"
            questions={PROMPT_QUESTIONS}
            isPending
            onSubmit={() => {}}
            onDecline={() => {}}
            onCancel={() => {}}
          />
        </div>
        <p className="sp-ja-prose sp-ja-fine">
          The gate for this prompt is deliberately minimal: reconcile + build.
          The test tier never blocks it — a background app-test sweep with an
          indeterminate clock is exactly the wait this design deletes. Tests
          ran on the dash's own checkpoints during the run; the join-time check
          answers "does the <em>merged</em> tree build", which is the question
          the checkpoints could not have asked.
        </p>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">The join is never silent</h2>
        <p className="sp-ja-prose">
          A join takes real seconds: the squash, the record, the workshop
          teardown, the release. Today that stretch is a void — the press
          lands, and nothing speaks until the durable commit message appears in
          the transcript. The repair is one progress line, fed by the join's
          own beats, mounted <strong>wherever the join was launched</strong>:
          on a dialog join it replaces the prompt's body in place, and on a Z5
          join it rides the composer's status row (shown in the Z5 section
          below). It is not new UI — it is the transcript's tool-call header,
          in flight: the pulsing dot carries the state, the line names the
          current beat, the beats trail as a result summary, and the clock
          keeps honest time until the transcript row takes over.
        </p>
        <div className="sp-ja-overlay-frame">
          <JoinProgressLine />
        </div>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">Status: the Quiet Line, reused</h2>
        <p className="sp-ja-prose">
          One register per state, wearing the tool-call header chrome the
          transcript already taught: the lifecycle dot carries the state — a
          pulsing action dot for work, caution for a wait on you, settled green
          and red for verdicts — the sentence is the target, and the state
          word rides the trailing summary. The strip itself stays calm. The
          client states only what it knows: what the server last said, and
          whether its own wire is up. Liveness is the server's to judge; its
          verdict arrives as a durable fact naming what fired.
        </p>
        <div className="sp-ja-status-stack">
          {STATUS_ROWS.map((row) => (
            <StatusRegister key={row.state} row={row} />
          ))}
        </div>
        <div className="sp-ja-banished">
          <span className="sp-ja-banished-title">Banished sentences</span>
          <s>
            No answer from the resolution ladder in 12 seconds — its result
            will appear on this row if it finished.
          </s>
          <s>
            sh scripts/verify-tier1.sh: Compiling idna v1.1.0 ⏎ Compiling
            tugrelaunch v0.8.0 … error: Recipe `app-test` failed with exit code 1
          </s>
          <span className="sp-ja-banished-note">
            The first guessed at liveness the client cannot see; the second put
            a build log where a verdict belongs. The register above replaces
            both; the log survives one level down, behind the verdict, for the
            reader who asks.
          </span>
        </div>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">A red is a decision, not an error</h2>
        <p className="sp-ja-prose">
          A red check on the joined tree is red — the existing <code>danger</code>{" "}
          role, on the dot, the tier line, and the Z5 button alike. What makes
          it a decision rather than an error is the grammar, not the hue: a
          calm check report at reading size, the failure open on arrival, and
          no button in the shade — the decision is the join press itself, one
          section down.
        </p>
        <div className="sp-ja-checks" data-verdict="red">
          <div className="sp-ja-checks-title">Checks on the joined tree</div>
          <div className="sp-ja-checks-tier" data-tone="success">
            <Check size={16} />
            <span className="sp-ja-checks-tier-name">Resolve</span>
            <span className="sp-ja-checks-tier-word">
              3 files reconciled against the dash's intent
            </span>
          </div>
          <div className="sp-ja-checks-tier" data-tone="danger">
            <span className="sp-ja-checks-x">✕</span>
            <span className="sp-ja-checks-tier-name">Build</span>
            <span className="sp-ja-checks-tier-word">
              vite build failed — 1 error
            </span>
          </div>
          <pre className="sp-ja-checks-tail">
            {"src/components/lens/sections/cards-section.tsx(1086,14):\n  error TS2339: Property 'unfilteredCount' does not exist on type 'CardsDataSource'."}
          </pre>
        </div>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">Z5, at shipped size</h2>
        <p className="sp-ja-prose">
          The composer in join mode, framed by the real{" "}
          <code>TugEntryShell</code>: the route group at its shipped{" "}
          <code>xs</code>, the Project / Dash cluster chips at their shipped{" "}
          <code>sm</code>, and the Z5 rail's two <code>lg</code> icon buttons
          exactly as <code>tug-prompt-entry</code> mounts them — auto-message,
          then the act. There is no ✕ in Z5, matching shipping: cancel lives at
          the shade's header and on ⎋. Only the editor text is a stand-in.
        </p>
        <div className="sp-ja-poses">
          <div className="sp-ja-pose">
            <div className="sp-ja-pose-label">
              ready — the blue ⬆ is the join; the message is the document
            </div>
            <ComposerPose pose="ready" />
          </div>
          <div className="sp-ja-pose">
            <div className="sp-ja-pose-label">
              checks-red — the register rides the status row; the ⬆ takes the
              existing danger role, and the press raises the confirm (try it)
            </div>
            <ComposerPose pose="red" />
          </div>
          <div className="sp-ja-pose">
            <div className="sp-ja-pose-label">
              joining — the progress line takes the status row; the rail
              stands down until the transcript row lands
            </div>
            <ComposerPose pose="joining" />
          </div>
        </div>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">The glance, disarmed</h2>
        <p className="sp-ja-prose">
          The dash row keeps its identity, its meta line, and the status
          register — the same Quiet Line as everywhere above, since the
          register <em>is</em> the glance's job. The only control left on the
          row is a ⋯ menu holding the rare lifecycle verbs (Unbind, Discard).
          Everything else the shade mounts today is dispositioned in the
          ledger below —{" "}
          <strong>
            which is commentary on this redesign, not proposed chrome
          </strong>
          : nothing in it renders in the app.
        </p>
        <div className="sp-ja-glance">
          <div className="sp-ja-glance-eyebrow">
            <DashSigil
              name={ENTRY.display_name}
              review={null}
              slot="sp-ja-glance-dash"
              atom
            />
            <span className="sp-ja-glance-rule" />
            <TugPushButton
              size="xs"
              emphasis="ghost"
              role="action"
              subtype="icon"
              aria-label="Dash actions"
              icon={<EllipsisVertical size={14} />}
            />
          </div>
          <div className="sp-ja-glance-meta">
            <DashMetaLine entry={ENTRY} />
          </div>
          <StatusRegister row={STATUS_ROWS[2]!} />
        </div>
        <div className="sp-ja-ledger">
          {DISPOSITIONS.map((d) => (
            <div className="sp-ja-ledger-row" key={d.control} data-verdict={d.verdict}>
              <div className="sp-ja-ledger-head">
                <span className="sp-ja-ledger-control">{d.control}</span>
                <span className="sp-ja-ledger-verdict">
                  {d.verdict === "delete" ? "deleted" : d.where}
                </span>
              </div>
              <div className="sp-ja-ledger-why">{d.why}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export const spike: SpikeDef = {
  name: "join-arc",
  title: "Join Arc",
  blurb:
    "Every state between built and joined: eager reconciling, one prompt, a narrated join, acts confined to Z5.",
  icon: "GitMerge",
  component: () => <SpikeJoinArc />,
};
