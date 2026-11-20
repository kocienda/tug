/**
 * spike-arc-panels.tsx — what if the arc shade stopped being a free canvas of
 * movable, expandable cards and became four fixed panels in a 2×2 grid, read
 * the way a page is: 1 Idea top-left → 2 Sketch top-right, return, 3 Brief
 * bottom-left → 4 Arc bottom-right?
 *
 * **What is the app's and what is new.** Everything that already ships is
 * the shipping component, fed wire-shaped fixtures, so nothing here is a
 * drawing of it:
 *
 *  - the shade's header is `SessionArcShade`'s, in its own classes;
 *  - the Arc panel is `ArcPopoverContent` whole: the lifecycle block (arc
 *    atom, hairline, worker atom, the track and its reading), the plan's
 *    ledger, and the verb row, with the verbs `arcVerbs` derives;
 *  - the Brief panel is `ArcBriefDetail` and `ArcBriefHeadings`, under the
 *    canvas card's own title;
 *  - a session is named by `SessionIdentityView`, and each panel's dot is
 *    `TugProgressIndicator`.
 *
 * What is new, and is the thing under review: the 2×2 grid and its panels'
 * frames, the seam marks, the share that follows a press, a progress dot in
 * every panel header, and the content of the Idea and Sketch panels, which
 * nothing records yet.
 *
 * Nothing drags, opens or tidies. A panel is a header that holds short
 * things only, a body that scrolls inside its seat, and a floor that never
 * scrolls, so a button is never laid over content. The Arc panel's floor is
 * the popup's own verb row; while that panel is not the pressed one, the row
 * keeps only the arc's next move.
 *
 * The order is said by position, by the number each panel wears, and by the
 * marks on the seams: an arrow across the top seam, a return line down and
 * back across the middle, an arrow across the bottom seam. A seam is solid
 * where one rung was made from the one before it and dotted where there is
 * nothing to join yet.
 */

import "./spike.css";
import "@/components/tugways/cards/session-arc-shade.css";
import "@/components/tugways/cards/session-arc-canvas.css";
import "./spike-arc-panels.css";

import React, { useEffect, useId, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { ArcSigil } from "@/components/tugways/arc-sigil";
import { ArcBriefDetail, ArcBriefHeadings } from "@/components/tugways/cards/session-arc-brief";
import { ArcPopoverContent } from "@/components/tugways/cards/session-card-telemetry-popovers";
import { SessionIdentityView } from "@/components/tugways/cards/session-identity";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import { TugChoiceGroup, type TugChoiceItem } from "@/components/tugways/tug-choice-group";
import { TugProgressIndicator, type TugProgressIndicatorState } from "@/components/tugways/tug-progress-indicator";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { useResponder } from "@/components/tugways/use-responder";
import { arcBranchFacts } from "@/lib/arc-meta-facts";
import type { ArcSessionFact } from "@/lib/arc-session-index";
import { arcTrackModelFromEntry } from "@/lib/arc-track-model";
import { arcVerbs, type ArcVerbSet } from "@/lib/arc-verbs";
import { loadBriefHeadings } from "@/lib/brief-headings-store";
import type { ArcChangesetEntry, ArcStep } from "@/lib/changeset-types";
import type { readFileFromDisk } from "@/lib/file-io";
import { useSessionIdentity } from "@/lib/session-identity";
import { sessionNameStore } from "@/lib/session-name-store";
import { sessionTagStore } from "@/lib/session-tag-store";

import type { SpikeDef } from "./spike-registry";

// ---------------------------------------------------------------------------
// The fixture — wire entries, as the server sends them
// ---------------------------------------------------------------------------

const ROOT = "/Users/you/src/cookbook";
const ARC = "recipe-copy-in";
const SESSION = "5d2e9b10-0000-4000-8000-0000000a4c5e";
const BRIEF_PATH = `${ROOT}/.tug/arcs/${ARC}/brief.md`;
const PLAN_PATH = `${ROOT}/.tug/arcs/${ARC}/plan.md`;
const BRIEF_TITLE = "Copying a recipe between libraries";
const IDEA = "Copy a recipe into another library without retyping it";
const TOUCHED = 1_760_000_000_000;

sessionNameStore.setName(SESSION, "recipe copy");
sessionTagStore.setTag(SESSION, "amber-heron-4");

/** The brief's text, as the Brief panel's reader would find it on disk. */
const BRIEF_TEXT = [
  "**[F01] A recipe row and its image assets are stored apart.**",
  "**[F02] Nothing reads a recipe's link to its source after the copy.**",
  "**[F03] The library picker already filters out the current library.**",
  "**[B01] The copy keeps no link to its source.**",
  "**[B02] Images are copied, never shared.**",
  "**[B03] Ratings and cook history are not copied.**",
  "**[B04] Copy sits beside Move in the recipe's menu.**",
].join("\n\n");

const SKETCH_POINTS = [
  "The copy is a new recipe, not a link: editing one never changes the other.",
  "Images go with it. A copy that shows the source's photo until it is deleted is a trap.",
  "The picker that chooses the target library is the one Move already uses.",
  "Ratings and cook history stay behind; they belong to the library, not the recipe.",
];

const STEP_TITLES = [
  "Read the source recipe",
  "Write the copy into the target library",
  "Break the link to the source",
  "Copy image assets beside the recipe",
  "Offer the copy in the library picker",
  "Cover the copy with tests",
];

function steps(done: number, current: number | null): ArcStep[] {
  return STEP_TITLES.map((title, i) => ({
    title,
    status: i < done ? "done" : i + 1 === current ? "in progress" : "pending",
  }));
}

function entry(over: Partial<ArcChangesetEntry>): ArcChangesetEntry {
  return {
    kind: "arc",
    owner_id: `tugarc/${ARC}#spike-${ARC}`,
    display_name: ARC,
    base: "main",
    rounds: 0,
    worktree: `${ROOT}/.tug/worktrees/${ARC}`,
    worktree_dirty: false,
    files: [],
    last_activity: new Date(TOUCHED).toISOString(),
    branch: `tugarc/${ARC}`,
    bound_session: SESSION,
    documents: { brief: BRIEF_PATH, plan: PLAN_PATH },
    review: "reviewed",
    step_total: STEP_TITLES.length,
    run_length: STEP_TITLES.length,
    ...over,
  };
}

/** Where the work is. */
type Stage = "sketching" | "briefed" | "running" | "stopped" | "ready";

/** The arc's wire entry at each point where there is an arc. */
const ENTRIES: Partial<Record<Stage, ArcChangesetEntry>> = {
  running: entry({
    stage: "implementing",
    arc: { stage: "implement" },
    step_current: 4,
    run_position: 4,
    step_title: STEP_TITLES[3],
    steps: steps(3, 4),
    rounds: 3,
    worktree_dirty: true,
  }),
  stopped: entry({
    stage: "working",
    arc: { stage: "implement", stopped: "you stopped it", stopped_stage: "implement" },
    step_current: 4,
    run_position: 4,
    step_title: STEP_TITLES[3],
    steps: steps(3, 4),
    rounds: 3,
  }),
  ready: entry({
    stage: "ready",
    arc: { stage: "audit", done: true },
    step_current: STEP_TITLES.length,
    run_position: STEP_TITLES.length,
    steps: steps(STEP_TITLES.length, null),
    rounds: 7,
    draft: {
      fingerprint: "spike",
      updated_at: TOUCHED,
      message: "Copy a recipe into another library\n\nBody.",
    },
  }),
};

/** The session-scoped fact, projected from the entry as `arcSessionIndex` projects it. */
function factFor(e: ArcChangesetEntry): ArcSessionFact {
  return {
    ownerId: e.owner_id,
    name: e.display_name,
    stage: e.stage ?? null,
    arc: e.arc ?? null,
    review: e.review ?? null,
    taskList: e.task_list ?? false,
    projectDir: ROOT,
    workspaceKey: ROOT,
    stepCurrent: e.step_current ?? null,
    stepTotal: e.step_total ?? null,
    runPosition: e.run_position ?? null,
    runLength: e.run_length ?? null,
    stepTitle: e.step_title ?? null,
    hasPlan: e.documents?.plan !== undefined,
    track: arcTrackModelFromEntry(e),
    documents: e.documents,
    boundSession: e.bound_session ?? "",
    steps: e.steps ?? [],
    timeline: e.timeline ?? null,
    hasDraft: e.draft !== undefined,
    branch: arcBranchFacts(e),
    restamp: e.restamp ?? null,
  };
}

/** The verb row the bound card's popup derives for the entry. */
function verbsFor(e: ArcChangesetEntry, idle: boolean): ArcVerbSet {
  return arcVerbs({
    surface: "popover",
    arc: e.display_name,
    projectDir: ROOT,
    run: e.arc ?? null,
    documents: e.documents,
    boundSession: e.bound_session ?? null,
    boundCardOpen: true,
    stage: e.stage,
    draft: e.draft?.message ?? null,
    joinGate: {
      state: e.join ?? { phase: "previewed" },
      holderBusy: false,
      turnInProgress: !idle,
      pending: false,
    },
    branch: arcBranchFacts(e),
    followed: null,
    reach: {
      binding: { bound: true, refusal: null },
      replay: { refusal: null },
      discard: { refusal: idle ? null : "Wait for the turn to finish" },
    },
  });
}

/** The brief's reader for the fixture: the text above, as a read that succeeded. */
const readFixtureBrief = (async () => ({
  ok: true,
  file: { content: BRIEF_TEXT },
})) as unknown as typeof readFileFromDisk;

const NO_VERB = (): void => {};

// ---------------------------------------------------------------------------
// The grid's own vocabulary
// ---------------------------------------------------------------------------

/** The four panels, in reading order. */
const RUNGS = ["idea", "sketch", "brief", "arc"] as const;
type Rung = (typeof RUNGS)[number];

const RUNG_LABELS: Record<Rung, string> = { idea: "Idea", sketch: "Sketch", brief: "Brief", arc: "Arc" };

/** A panel's state: settled, where the work is, or an empty seat. */
type RungState = "done" | "active" | "pending";

/** A seam's state: the rung after it was made from the rung before it, or not yet. */
type SeamState = "linked" | "pending";

/** How the shade's room is shared among the four. */
type Share = "focus" | "even";

const STAGE_ITEMS: TugChoiceItem[] = [
  { value: "sketching", label: "Sketching" },
  { value: "briefed", label: "Briefed" },
  { value: "running", label: "Running" },
  { value: "stopped", label: "Stopped" },
  { value: "ready", label: "Ready to join" },
];

const SHARE_ITEMS: TugChoiceItem[] = [
  { value: "focus", label: "Pressed panel is larger" },
  { value: "even", label: "Even quarters" },
];

/** The rung the work is at. */
function activeRung(stage: Stage): Rung {
  switch (stage) {
    case "sketching":
      return "sketch";
    case "briefed":
      return "brief";
    default:
      return "arc";
  }
}

function rungState(rung: Rung, stage: Stage): RungState {
  if (stage === "ready") return "done";
  const at = RUNGS.indexOf(activeRung(stage));
  const i = RUNGS.indexOf(rung);
  return i < at ? "done" : i === at ? "active" : "pending";
}

/** The seam leaving `from`: joined once the next rung exists. */
function seamState(from: Rung, stage: Stage): SeamState {
  return RUNGS.indexOf(from) < RUNGS.indexOf(activeRung(stage)) ? "linked" : "pending";
}

/**
 * The progress dot's pose. A settled rung is complete, an empty seat is
 * still, and the rung the work is at pulses — unless the arc is stopped,
 * where it holds its pose.
 */
function dotState(state: RungState, stage: Stage): TugProgressIndicatorState {
  if (state === "done") return "completed";
  if (state === "pending") return "stopped";
  return stage === "stopped" ? "paused" : "running";
}

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

interface PanelProps {
  rung: Rung;
  state: RungState;
  dot: TugProgressIndicatorState;
  /** Whether this panel holds the larger share, in the layout that has one. */
  focused: boolean;
  onPress: (rung: Rung) => void;
  /** The body is a whole surface of its own and fills the panel edge to edge. */
  full?: boolean;
  /** The panel's floor. It never scrolls. */
  foot?: React.ReactNode;
  children: React.ReactNode;
}

/** One share of the shade: a header, a body that scrolls, and a floor. */
function Panel({ rung, state, dot, focused, onPress, full, foot, children }: PanelProps): React.ReactElement {
  return (
    <section
      className="sp-ap-panel"
      data-rung={rung}
      data-state={state}
      data-full={full === true ? "true" : undefined}
      data-focused={focused ? "true" : undefined}
      aria-label={RUNG_LABELS[rung]}
      onPointerDown={() => onPress(rung)}
    >
      <header className="sp-ap-panel-head">
        <span className="sp-ap-panel-dot">
          <TugProgressIndicator variant="pulsing-dot" size={12} state={dot} aria-hidden />
        </span>
        <span className="session-arc-canvas-card-name">
          <span className="sp-ap-panel-number">{RUNGS.indexOf(rung) + 1}</span>
          {RUNG_LABELS[rung]}
        </span>
      </header>
      <div className="sp-ap-panel-body">{children}</div>
      {foot !== undefined ? <footer className="sp-ap-foot">{foot}</footer> : null}
    </section>
  );
}

/** The arrow across a row's seam: this panel leads to the one on its right. */
function RowSeam({ state }: { state: SeamState }): React.ReactElement {
  return (
    <div className="sp-ap-seam sp-ap-seam-row" data-state={state} aria-hidden="true">
      <span className="sp-ap-seam-line" />
      <ChevronRight className="sp-ap-seam-head" size={14} />
    </div>
  );
}

/**
 * The return across the middle: down out of the second panel, back along the
 * seam, and down into the third. It is laid on the grid's own columns, so
 * its two drops stay over the middles of the panels however the room is
 * shared.
 */
function ReturnSeam({ state }: { state: SeamState }): React.ReactElement {
  return (
    <div className="sp-ap-seam sp-ap-seam-return" data-state={state} aria-hidden="true">
      <span className="sp-ap-return-cell" data-part="into">
        <ChevronDown className="sp-ap-seam-head" size={14} />
      </span>
      <span className="sp-ap-return-cell" data-part="across" />
      <span className="sp-ap-return-cell" data-part="out" />
    </div>
  );
}

/** Where a rung came from: the turns it covers and the session they are in. */
function Source({ turns }: { turns: string }): React.ReactElement {
  const identity = useSessionIdentity(SESSION);
  return (
    <>
      <span className="session-arc-canvas-card-detail">{turns}</span>
      <span className="sp-ap-foot-end">
        <SessionIdentityView identity={identity} tier="chip" arc={false} tooltip={false} />
      </span>
    </>
  );
}

/** An empty seat's one line, in the canvas card's own pending title. */
function Empty({ children }: { children: React.ReactNode }): React.ReactElement {
  return <h3 className="session-arc-canvas-card-title sp-ap-empty">{children}</h3>;
}

// ---------------------------------------------------------------------------
// The spike
// ---------------------------------------------------------------------------

function SpikeArcPanels(): React.ReactElement {
  const [stage, setStage] = useState<Stage>("running");
  const [share, setShare] = useState<Share>("focus");
  // The panel last pressed, which the focus layout enlarges. Null follows the
  // rung the work is at.
  const [pressed, setPressed] = useState<Rung | null>(null);
  const stageSenderId = useId();
  const shareSenderId = useId();
  const responderId = useId();
  const { ResponderScope, responderRef } = useResponder({
    id: responderId,
    actions: {
      [TUG_ACTIONS.SELECT_VALUE]: (event: ActionEvent) => {
        if (typeof event.value !== "string") return;
        if (event.sender === stageSenderId) {
          setStage(event.value as Stage);
          setPressed(null);
        } else if (event.sender === shareSenderId) setShare(event.value as Share);
      },
    },
  });

  const focus = pressed ?? activeRung(stage);
  const arcEntry = ENTRIES[stage] ?? null;
  const hasBrief = stage !== "sketching";
  // The bound session is mid-turn while the arc runs.
  const idle = stage !== "running";

  // The Brief panel's headings come through the app's own store, which reads
  // the file when the panel mounts. The fixture's brief is on no disk, so its
  // text is given to the store after that read is asked for, and stands.
  useEffect(() => {
    if (hasBrief) void loadBriefHeadings(BRIEF_PATH, readFixtureBrief);
  }, [hasBrief]);

  // The Arc panel's verb row: whole while the panel holds the larger share,
  // and only the arc's next move while it does not.
  const arcVerbsWhole = share === "even" || focus === "arc";
  const fullVerbs = arcEntry !== null ? verbsFor(arcEntry, idle) : null;
  const shownVerbs: ArcVerbSet | null =
    fullVerbs === null ? null : arcVerbsWhole ? fullVerbs : { next: fullVerbs.next, view: null, housekeeping: [] };

  const panel = (rung: Rung) => {
    const state = rungState(rung, stage);
    return {
      rung,
      state,
      dot: dotState(state, stage),
      focused: share === "focus" && focus === rung,
      onPress: setPressed,
    };
  };

  return (
    <ResponderScope>
      <div className="sp-content" ref={responderRef as (el: HTMLDivElement | null) => void}>
        <section className="sp-section">
          <h2 className="sp-section-title">The arc shade as four fixed panels</h2>
          <p className="sp-ap-note">
            Read it as a page: Idea, then Sketch, return, Brief, then Arc. The shade's header, the Arc panel's
            contents and verbs, the Brief panel's contents and the session chips are the app's own components. The
            grid, the panel frames, the seams, the dots and the Idea and Sketch contents are what is new. Press a
            panel to give it the larger share.
          </p>
          <div className="sp-ap-controls">
            <span className="sp-ap-control">
              <span className="sp-ap-control-label">Arc is</span>
              <TugChoiceGroup
                items={STAGE_ITEMS}
                value={stage}
                senderId={stageSenderId}
                size="sm"
                commit="live"
                aria-label="Arc is"
              />
            </span>
            <span className="sp-ap-control">
              <span className="sp-ap-control-label">Room</span>
              <TugChoiceGroup
                items={SHARE_ITEMS}
                value={share}
                senderId={shareSenderId}
                size="sm"
                commit="live"
                aria-label="Room"
              />
            </span>
          </div>

          <div className="sp-ap-shade">
            {/* The shade's header, as `SessionArcShade` draws it, less Tidy:
                there is nothing to send home. */}
            <header className="session-arc-shade-head">
              <span className="session-arc-shade-label">Arc</span>
              {arcEntry !== null ? (
                <span className="session-arc-shade-name">
                  <ArcSigil name={ARC} slot="session-arc-shade-name" />
                </span>
              ) : null}
              <span className="session-arc-shade-spacer" />
              <TugPushButton size="xs" emphasis="ghost" role="action">
                Transcript
              </TugPushButton>
            </header>
            <div className="sp-ap-grid" data-share={share} data-focus={share === "focus" ? focus : undefined}>
              <Panel {...panel("idea")} foot={<Source turns="Turn 1" />}>
                <h3 className="session-arc-canvas-card-title">{IDEA}</h3>
                <div className="session-arc-canvas-card-detail">The prompt this work began as.</div>
              </Panel>
              <RowSeam state={seamState("idea", stage)} />
              <Panel
                {...panel("sketch")}
                foot={<Source turns={stage === "sketching" ? "Turns 2 to 9, so far" : "Turns 2 to 14"} />}
              >
                <ul className="sp-ap-points">
                  {SKETCH_POINTS.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </Panel>

              <ReturnSeam state={seamState("sketch", stage)} />

              <Panel
                {...panel("brief")}
                foot={
                  stage === "briefed" ? (
                    <TugPushButton size="xs" emphasis="filled" role="action">
                      Open Arc
                    </TugPushButton>
                  ) : undefined
                }
              >
                {hasBrief ? (
                  <>
                    <h3 className="session-arc-canvas-card-title">{BRIEF_TITLE}</h3>
                    <div className="session-arc-canvas-card-detail">
                      <ArcBriefDetail path={BRIEF_PATH} projectDir={ROOT} />
                    </div>
                    <ArcBriefHeadings path={BRIEF_PATH} />
                  </>
                ) : (
                  <Empty>No brief</Empty>
                )}
              </Panel>
              <RowSeam state={seamState("brief", stage)} />
              <Panel {...panel("arc")} full={arcEntry !== null}>
                {arcEntry !== null && shownVerbs !== null ? (
                  <ArcPopoverContent
                    fact={factFor(arcEntry)}
                    tasks={[]}
                    idle={idle}
                    verbs={shownVerbs}
                    onVerb={NO_VERB}
                    verbLabels="lead-only"
                  />
                ) : (
                  <Empty>No arc</Empty>
                )}
              </Panel>
            </div>
          </div>
        </section>
      </div>
    </ResponderScope>
  );
}

export const spike: SpikeDef = {
  name: "arc-panels",
  title: "Arc Panels",
  blurb: "The arc shade as four fixed panels in a 2×2 grid, read like a page, in place of the movable cards.",
  icon: "LayoutGrid",
  component: () => <SpikeArcPanels />,
};
