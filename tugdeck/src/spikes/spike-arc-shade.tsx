/**
 * spike-arc-shade.tsx — what if the Z2 ARC cell, moved to the row's rightmost
 * seat past JOBS, stopped opening a placard and instead raised a shade from
 * the bottom of the transcript that shows the arc's whole ladder: idea →
 * sketch → brief → arc, as four connected cards — and what does every control
 * on those cards actually do?
 *
 * The subject is the "Tug Flows" design study's four-card figure, held to the
 * word Arc (the study's working title "Flow" is not used), and moved off the
 * canvas into the Session card as a shade.
 *
 * This revision is a working model rather than a depiction. The arc below is
 * simulated: every button and every prompt changes its state, writes what it
 * did into the transcript, and says in a line what just happened.
 *
 * **The prompt entry is the only place a prompt is typed.** The cards carry no
 * message fields. A prompt is *aimed* instead, and it has three places to go:
 *
 *  - nowhere in particular — a plain prompt is a turn in the conversation,
 *    which is what the Sketch card is;
 *  - `^brief` — a turn asking the session to revise the brief and commit it,
 *    which is the one act that can leave the arc behind;
 *  - `^arc` — a note to whichever stage of the arc is in hand.
 *
 * `^` is already the arc sigil (`lib/arc-sigil-text.ts`), so the aim is the
 * existing grammar pointed at a rung of this card's arc. Typing `^brief ` or
 * `^arc ` at the start of the prompt turns into the aim's chip; clicking a
 * card aims at it; Backspace in an empty prompt clears the aim. The line
 * under the prompt says what sending will do before it is sent. The idea
 * cannot be aimed at: it is the first prompt, and it is history.
 *
 * **The buttons are the arc's own next acts**, one per card and only when it
 * applies: Write Brief on an empty Brief seat, Open Arc on an empty Arc seat,
 * Update Arc from Brief when the brief has moved past the arc, Join when the
 * arc is ready, Open Follow-up Arc when a joined arc's brief is revised.
 *
 * **The cards move and expand.** The shade's floor is a canvas: a card drags
 * anywhere on it and its connectors follow, so the ladder can be laid out the
 * way the work reads. Tidy puts the four back in a row. A card opens in place
 * to show what it stands for — the conversation's recent turns, the brief's
 * text, the arc's steps — and pushes the cards to its right along. A card
 * dragged off the Session card altogether is torn off: the shade says what it
 * becomes on the deck, and its seat in the ladder stays.
 *
 * The Z2 cells, the track, the step list, the badges, the buttons and the
 * prompt field are the shipping components. The transcript is a stand-in.
 */

import "./spike.css";
import "@/components/tugways/cards/session-card-telemetry-renderers.css";
import "./spike-arc-shade.css";

import React, { useCallback, useId, useLayoutEffect, useReducer, useRef, useState } from "react";
import { FileDiff, Maximize2, Minimize2 } from "lucide-react";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { ArcStepItems } from "@/components/tugways/arc-step-list";
import { SessionTelemetryCell } from "@/components/tugways/cards/session-telemetry-cell";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import {
  TugArcTrack,
  arcCellWord,
  arcReading,
  arcTrackModel,
  type ArcTrackModel,
} from "@/components/tugways/tug-arc-track";
import { TugBadge } from "@/components/tugways/tug-badge";
import { TugChoiceGroup, type TugChoiceItem } from "@/components/tugways/tug-choice-group";
import { TugIconButton } from "@/components/tugways/tug-icon-button";
import { TugInlineDialog } from "@/components/tugways/tug-inline-dialog";
import { TugInput } from "@/components/tugways/tug-input";
import { TugPopupListFrame } from "@/components/tugways/tug-popup-list";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { useResponder } from "@/components/tugways/use-responder";
import { ARC_SIGIL } from "@/lib/arc-sigil-text";
import type { ArcStep } from "@/lib/changeset-types";

import type { SpikeDef } from "./spike-registry";

// ---------------------------------------------------------------------------
// The simulated arc
// ---------------------------------------------------------------------------

const ARC = "recipe-copy-in";
const SESSION = "tug/amber-heron";
const WORKER = "tug/quiet-lark";
const IDEA = "Copy a recipe into another library without retyping it";
const SQUASH = "9c41e2a";

const BASE_STEPS = [
  "Read the source recipe",
  "Write the copy into the target library",
  "Break the link to the source",
  "Copy image assets beside the recipe",
  "Offer the copy in the library picker",
  "Cover the copy with tests",
];

const BRIEF_FINDINGS = [
  "A recipe row and its image assets are stored apart.",
  "Nothing reads a recipe's link to its source after the copy.",
];

const BRIEF_DECISIONS = ["The copy keeps no link to its source.", "Images are copied, never shared."];

/** Where the arc is in its life. */
type Stage = "sketching" | "briefed" | "executing" | "ready" | "joined";

/** The four rungs, in the ladder's order. */
type Rung = "idea" | "sketch" | "brief" | "arc";

/** Where a prompt can be aimed. `sketch` is the plain prompt. */
type Aim = "sketch" | "brief" | "arc";

interface Turn {
  who: "you" | "claude" | "stage";
  /** The aim the prompt was sent with, when it was not a plain one. */
  aim?: Aim;
  text: string;
}

interface Sim {
  stage: Stage;
  arcName: string;
  /** The joined arc this one follows, when it is a follow-up. */
  follows: string | null;
  /** Turns in the conversation, as the Sketch card counts them. */
  turnCount: number;
  /** Turns the conversation has run since the brief was last written. */
  sinceBrief: number;
  /** Commits to the brief since the arc opened: what puts the arc behind. */
  drift: number;
  /** What each revision of the brief added, oldest first. */
  revisions: string[];
  /** How many of {@link revisions} the arc has been built from. */
  revisionsBuilt: number;
  steps: string[];
  stepsDone: number;
  log: Turn[];
  /** What the last act did, in a sentence. */
  effect: string;
}

const OPENING: Turn[] = [
  { who: "you", text: `/arc ${IDEA}` },
  {
    who: "claude",
    text: "Two questions before I write the brief. Does the copy keep a link to its source, and do its images travel with it?",
  },
  { who: "you", text: "No link. The images are copied." },
];

const BRIEFED: Turn[] = [
  ...OPENING,
  { who: "claude", text: `Brief written to .tug/arcs/${ARC}/brief.md and committed.` },
];

const RUNNING: Turn[] = [
  ...BRIEFED,
  { who: "claude", text: `Opened a planned arc on the brief: tugarc/${ARC}, six steps.` },
  { who: "stage", text: "Step 4 of 6: copying image assets beside the recipe row." },
];

function preset(stage: Stage): Sim {
  const base: Sim = {
    stage,
    arcName: ARC,
    follows: null,
    turnCount: 41,
    sinceBrief: 0,
    drift: 0,
    revisions: [],
    revisionsBuilt: 0,
    steps: BASE_STEPS,
    stepsDone: 3,
    log: RUNNING,
    effect: "Nothing yet. Aim a prompt, or press a card's button.",
  };
  switch (stage) {
    case "sketching":
      return { ...base, turnCount: 3, log: OPENING, stepsDone: 0 };
    case "briefed":
      return { ...base, turnCount: 4, log: BRIEFED, stepsDone: 0 };
    case "executing":
      return base;
    case "ready":
      return {
        ...base,
        stepsDone: BASE_STEPS.length,
        log: [...RUNNING, { who: "stage", text: "All six steps are done and audited. The arc is ready to join." }],
      };
    case "joined":
      return {
        ...base,
        stepsDone: BASE_STEPS.length,
        log: [...RUNNING, { who: "claude", text: `Joined tugarc/${ARC} onto main as ${SQUASH}.` }],
      };
  }
}

type Act =
  | { type: "reset"; stage: Stage }
  | { type: "send"; aim: Aim; text: string }
  | { type: "writeBrief" }
  | { type: "openArc" }
  | { type: "updateArc" }
  | { type: "join" }
  | { type: "followUp" }
  | { type: "note"; effect: string };

/** Whether a prompt can be aimed there at this stage. */
function canAim(aim: Aim, stage: Stage): boolean {
  if (aim === "brief") return stage !== "sketching";
  if (aim === "arc") return stage === "executing" || stage === "ready";
  return true;
}

function reduce(sim: Sim, act: Act): Sim {
  switch (act.type) {
    case "reset":
      return preset(act.stage);
    case "note":
      return { ...sim, effect: act.effect };
    case "send": {
      const you: Turn = { who: "you", aim: act.aim === "sketch" ? undefined : act.aim, text: act.text };
      if (act.aim === "brief") {
        const arcOpen = sim.stage === "executing" || sim.stage === "ready" || sim.stage === "joined";
        return {
          ...sim,
          turnCount: sim.turnCount + 2,
          sinceBrief: 0,
          drift: arcOpen ? sim.drift + 1 : 0,
          revisions: [...sim.revisions, act.text],
          revisionsBuilt: arcOpen ? sim.revisionsBuilt : sim.revisions.length + 1,
          log: [...sim.log, you, { who: "claude", text: "Revised brief.md to say so, and committed it." }],
          effect: arcOpen
            ? `${SESSION} rewrote the brief and committed it. The arc was built from the earlier brief, so it is now behind.`
            : `${SESSION} rewrote the brief and committed it. No arc is open on it, so nothing is behind.`,
        };
      }
      if (act.aim === "arc") {
        const resting = sim.stage === "ready";
        return {
          ...sim,
          stage: "executing",
          steps: resting ? [...sim.steps, `Take the note: ${act.text}`] : sim.steps,
          log: [
            ...sim.log,
            you,
            {
              who: "stage",
              text: resting
                ? "The arc was at rest. Reopened it with one more step for the note."
                : "Noted. I will take that into the step in hand.",
            },
          ],
          effect: resting
            ? `The note reopened the arc with a step of its own. The brief did not change.`
            : `The note went to the stage in hand (implement, ${WORKER}). The brief did not change.`,
        };
      }
      const briefed = sim.stage !== "sketching";
      return {
        ...sim,
        turnCount: sim.turnCount + 2,
        sinceBrief: briefed ? sim.sinceBrief + 2 : 0,
        log: [
          ...sim.log,
          you,
          {
            who: "claude",
            text: briefed
              ? "Understood. That is in the conversation; the brief does not say it yet."
              : "Understood. I will carry that into the brief.",
          },
        ],
        effect: briefed
          ? `A turn in ${SESSION}. Nothing is out of step, but the conversation now holds something the brief does not.`
          : `A turn in ${SESSION}. The sketch is still taking shape.`,
      };
    }
    case "writeBrief":
      return {
        ...sim,
        stage: "briefed",
        turnCount: sim.turnCount + 1,
        sinceBrief: 0,
        log: [...sim.log, { who: "claude", text: `Brief written to .tug/arcs/${ARC}/brief.md and committed.` }],
        effect: `${SESSION} wrote the brief from the conversation so far and committed it. No arc is open yet.`,
      };
    case "openArc":
      return {
        ...sim,
        stage: "executing",
        stepsDone: 0,
        revisionsBuilt: sim.revisions.length,
        drift: 0,
        log: [
          ...sim.log,
          { who: "claude", text: `Opened a planned arc on the brief: tugarc/${sim.arcName}, ${sim.steps.length} steps.` },
        ],
        effect: `The arc opened on the brief as it stands now: a branch, a worktree, and a plan of ${sim.steps.length} steps.`,
      };
    case "updateArc": {
      const fresh = sim.revisions.slice(sim.revisionsBuilt).map((text) => `From the revised brief: ${text}`);
      return {
        ...sim,
        stage: "executing",
        drift: 0,
        revisionsBuilt: sim.revisions.length,
        steps: [...sim.steps, ...fresh],
        log: [
          ...sim.log,
          { who: "you", text: `/arc ${sim.arcName} @.tug/arcs/${sim.arcName}/brief.md` },
          {
            who: "claude",
            text: `The brief changed in ${sim.drift} commit(s) since the arc opened. The ${sim.stepsDone} finished step(s) stand. Added ${fresh.length} step(s) for what changed.`,
          },
        ],
        effect: `The arc re-read the brief. Its finished steps stand, and it gained ${fresh.length} step(s) for what the brief now says.`,
      };
    }
    case "join":
      return {
        ...sim,
        stage: "joined",
        log: [...sim.log, { who: "claude", text: `Joined tugarc/${sim.arcName} onto main as ${SQUASH}.` }],
        effect: `The arc was squashed onto main as ${SQUASH}. Its branch and worktree are gone, and it is now a finished record.`,
      };
    case "followUp": {
      const name = `${ARC}-2`;
      const fresh = sim.revisions.slice(sim.revisionsBuilt).map((text) => `From the revised brief: ${text}`);
      return {
        ...sim,
        stage: "executing",
        arcName: name,
        follows: sim.arcName,
        drift: 0,
        revisionsBuilt: sim.revisions.length,
        steps: fresh.length > 0 ? fresh : ["Bring the code up to the revised brief"],
        stepsDone: 0,
        log: [
          ...sim.log,
          { who: "you", text: `/arc ${name} @.tug/arcs/${ARC}/brief.md` },
          { who: "claude", text: `Opened a follow-up arc on the revised brief: tugarc/${name}.` },
        ],
        effect: `A second arc opened on the same brief. ${sim.arcName} stays as it joined.`,
      };
    }
  }
}

/** The steps as the ledger would carry them. */
function ledger(sim: Sim): ArcStep[] {
  const walking = sim.stage === "executing";
  return sim.steps.map((title, i) => ({
    title,
    status: i < sim.stepsDone ? "done" : walking && i === sim.stepsDone ? "in progress" : "pending",
  }));
}

/** The arc's track, or `null` where there is no live arc to draw. */
function trackOf(sim: Sim): ArcTrackModel | null {
  const brief = `.tug/arcs/${sim.arcName}/brief.md`;
  const documents = { brief, plan: `.tug/arcs/${sim.arcName}/plan.md` };
  switch (sim.stage) {
    case "sketching":
    case "joined":
      return null;
    case "briefed":
      return arcTrackModel({ documents: { brief }, arcKind: "planned", arc: null });
    case "executing":
      return arcTrackModel({
        documents,
        arcKind: "planned",
        arc: { stage: "implement" },
        stage: "implementing",
        steps: ledger(sim),
        holdersBusy: true,
      });
    case "ready":
      return arcTrackModel({
        documents,
        arcKind: "planned",
        arc: { done: true },
        stage: "audited",
        steps: ledger(sim),
      });
  }
}

/** The arc's reading as a clause: `Executing 4/6`, `Sketching`, `Joined`. */
function clauseOf(sim: Sim, model: ArcTrackModel | null): string {
  if (sim.stage === "sketching") return "Sketching";
  if (sim.stage === "joined") return `Joined ${SQUASH}`;
  if (model === null) return "";
  const reading = arcReading(model);
  return reading.fraction !== null ? `${reading.word} ${reading.fraction}` : reading.word;
}

/** What sending a prompt with this aim will do, said before it is sent. */
function consequence(aim: Aim, sim: Sim): string {
  if (aim === "brief") {
    if (sim.stage === "briefed") {
      return `Asks ${SESSION} to revise brief.md and commit it. No arc is open, so nothing falls behind.`;
    }
    if (sim.stage === "joined") {
      return `Asks ${SESSION} to revise brief.md and commit it. The joined arc stays as it finished; a follow-up arc brings the code up to date.`;
    }
    return `Asks ${SESSION} to revise brief.md and commit it. The arc was built from the brief as it was, so it falls behind until it is updated.`;
  }
  if (aim === "arc") {
    return sim.stage === "ready"
      ? "The arc is at rest. A note reopens it with one more step. The brief does not change."
      : `A note to the stage in hand (implement, ${WORKER}). The brief does not change.`;
  }
  return sim.stage === "sketching"
    ? `A turn in ${SESSION}. The conversation is the sketch.`
    : `A turn in ${SESSION}, the conversation. Nothing falls out of step.`;
}

/** What Send sends when the prompt is empty, so every aim can be tried cold. */
const SAMPLE: Record<Aim, string> = {
  sketch: "Should a copied recipe keep the source's rating?",
  brief: "A copied recipe says where it came from, in its notes.",
  arc: "Use the existing asset copier; do not write a new one.",
};

const STAGE_ITEMS: TugChoiceItem[] = [
  { value: "sketching", label: "Sketching" },
  { value: "briefed", label: "Briefed" },
  { value: "executing", label: "Executing" },
  { value: "ready", label: "Ready to join" },
  { value: "joined", label: "Joined" },
];

/** How far up the transcript the shade rises, as a percentage of its height. */
const REACH_ITEMS: TugChoiceItem[] = [
  { value: "75", label: "75%" },
  { value: "90", label: "90%" },
  { value: "100", label: "Full" },
];

// ---------------------------------------------------------------------------
// The canvas: where the cards stand and how the connectors join them
// ---------------------------------------------------------------------------

/** A connector's reading: nothing to join yet, in step, or out of step. */
type LinkState = "pending" | "linked" | "changed";

interface Point {
  x: number;
  y: number;
}

const ORDER: readonly Rung[] = ["idea", "sketch", "brief", "arc"];

/** A card's width at rest and expanded, and how far down its edge its port is. */
const CARD_W = 200;
const CARD_W_EXPANDED = 440;
const PORT_Y = 64;
const CANVAS_PAD = 16;

/** The tidy layout: a row, Idea and Brief a step lower so every connector curves. */
const HOME: Record<Rung, Point> = {
  idea: { x: 16, y: 40 },
  sketch: { x: 272, y: 16 },
  brief: { x: 528, y: 40 },
  arc: { x: 784, y: 16 },
};

/** What a card becomes when it is dragged off the Session card. */
const TORN_OFF: Record<Rung, string> = {
  idea: "The idea is a turn, not a document, so it has no card of its own to become. It went back to its seat.",
  sketch:
    "The sketch is this Session card's own conversation, so there is no second card to open. It went back to its seat.",
  brief:
    "Torn off: brief.md opens where it was dropped as a Text card, in Markdown preview. Its seat in the ladder stays.",
  arc: "Torn off: the arc opens where it was dropped as its row on the Arcs card. Its seat in the ladder stays.",
};

// ---------------------------------------------------------------------------
// One rung's card
// ---------------------------------------------------------------------------

interface RungCardProps {
  rung: Rung;
  /** `done` is settled, `active` is where the work is, `pending` is an empty seat. */
  state: "done" | "active" | "pending";
  /** The card's element, for the canvas to place. */
  elRef: (el: HTMLElement | null) => void;
  /** The pointer handlers that drag the card across the canvas. */
  drag: Pick<
    React.HTMLAttributes<HTMLElement>,
    "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel"
  >;
  /** Whether the press that just ended was a drag, and so not a click. */
  wasDrag: () => boolean;
  /** The connector arriving at this card's left port, and leaving its right. */
  inLink?: LinkState;
  outLink?: LinkState;
  /** What stands beside the rung's name: a session, or a caution. */
  mark?: React.ReactNode;
  title: string;
  /** The card's readings, one per line. A caution line is out of step. */
  points: ReadonlyArray<{ text: string; caution?: boolean }>;
  /** The aim this card is, when a prompt can be aimed at it now. */
  aim?: Aim;
  /** Whether the prompt is aimed here. */
  aimed?: boolean;
  onAim?: (aim: Aim) => void;
  expanded: boolean;
  onExpand: (rung: Rung | null) => void;
  /** What the card stands for, shown only when it is expanded. */
  body?: React.ReactNode;
  /** The card's own next acts. */
  children?: React.ReactNode;
}

function RungCard(props: RungCardProps): React.ReactElement {
  const { rung, state, elRef, drag, wasDrag, mark, title, points, aim, aimed, onAim, expanded, onExpand, body } = props;
  const { children, inLink, outLink } = props;
  return (
    <section
      ref={elRef}
      className="sp-as-rung"
      data-state={state}
      data-expanded={expanded ? "true" : undefined}
      data-aimable={aim !== undefined ? "true" : undefined}
      data-aimed={aimed === true ? "true" : undefined}
      {...drag}
      onClick={(event) => {
        // A press on one of the card's own controls is that control's.
        if ((event.target as HTMLElement).closest("button, input, a") !== null) return;
        if (wasDrag()) return;
        if (aim !== undefined) onAim?.(aim);
      }}
    >
      {/* The ports are the card's own, so they stack with it: a connector
          runs beneath every card and meets its port at the edge. */}
      {inLink !== undefined ? <span className="sp-as-port" data-side="in" data-state={inLink} /> : null}
      {outLink !== undefined ? <span className="sp-as-port" data-side="out" data-state={outLink} /> : null}
      <header className="sp-as-rung-head">
        <span className="sp-as-rung-name">{rung}</span>
        {mark}
        <span className="sp-as-spacer" />
        {aim !== undefined && aim !== "sketch" ? (
          <span className="sp-as-rung-sigil">
            {ARC_SIGIL}
            {aim}
          </span>
        ) : null}
        {state !== "pending" ? (
          <TugIconButton
            size="2xs"
            emphasis="ghost"
            icon={expanded ? <Minimize2 /> : <Maximize2 />}
            aria-label={expanded ? `Collapse ${rung}` : `Expand ${rung}`}
            onClick={() => onExpand(expanded ? null : rung)}
          />
        ) : null}
      </header>
      <h3 className="sp-as-rung-title">{title}</h3>
      <ul className="sp-as-rung-points">
        {points.map((point) => (
          <li key={point.text} className="sp-as-rung-point" data-caution={point.caution === true ? "true" : undefined}>
            {point.text}
          </li>
        ))}
      </ul>
      {expanded && body !== undefined ? <div className="sp-as-rung-body">{body}</div> : null}
      {children !== undefined && children !== null ? <div className="sp-as-rung-foot">{children}</div> : null}
    </section>
  );
}

/** A session, as a rung names it. */
function SessionMark({ name }: { name: string }): React.ReactElement {
  return (
    <TugBadge size="xs" emphasis="outlined" role="agent">
      {name}
    </TugBadge>
  );
}

/** One turn, in the transcript stand-in and in the Sketch card's digest. */
function TurnLine({ turn, marked }: { turn: Turn; marked?: boolean }): React.ReactElement {
  const who = turn.who === "you" ? "You" : turn.who === "claude" ? "Claude" : `${WORKER} · implement`;
  return (
    <p className="sp-as-turn" data-who={turn.who} data-marked={marked === true ? "true" : undefined}>
      <span className="sp-as-turn-who">
        {who}
        {turn.aim !== undefined ? (
          <span className="sp-as-turn-aim">
            {" "}
            {ARC_SIGIL}
            {turn.aim}
          </span>
        ) : null}
      </span>
      {turn.text}
    </p>
  );
}

// ---------------------------------------------------------------------------
// The shade's content
// ---------------------------------------------------------------------------

interface ArcLadderProps {
  sim: Sim;
  model: ArcTrackModel | null;
  aim: Aim;
  onAim: (aim: Aim) => void;
  act: (act: Act) => void;
  onShowIdea: () => void;
  onLower: () => void;
}

function ArcLadder({ sim, model, aim, onAim, act, onShowIdea, onLower }: ArcLadderProps): React.ReactElement {
  const [expanded, setExpanded] = useState<Rung | null>(null);
  // Whether Update Arc from Brief is waiting on its confirmation.
  const [confirming, setConfirming] = useState(false);
  const { stage } = sim;
  const sketching = stage === "sketching";
  const arcOpen = stage === "executing" || stage === "ready";
  const behind = sim.drift > 0;
  const clause = clauseOf(sim, model);
  const briefPath = `.tug/arcs/${ARC}/brief.md`;

  // Where each card stands. The canvas is placed through the DOM ([L06]): a
  // drag writes positions straight to the cards and the connectors, and
  // nothing re-renders while the pointer moves.
  const posRef = useRef<Record<Rung, Point>>(HOME);
  const expandedRef = useRef<Rung | null>(null);
  expandedRef.current = expanded;
  const cardEls = useRef<Partial<Record<Rung, HTMLElement | null>>>({});
  const linkEls = useRef<Array<SVGGElement | null>>([]);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const place = useCallback((): void => {
    const pos = posRef.current;
    const open = expandedRef.current;
    let right = 0;
    let bottom = 0;
    const shown = {} as Record<Rung, Point & { w: number }>;
    for (const rung of ORDER) {
      // An expanded card pushes the cards to its right along by what it grew.
      const pushed = open !== null && open !== rung && pos[open].x < pos[rung].x;
      const w = rung === open ? CARD_W_EXPANDED : CARD_W;
      const at = { x: pos[rung].x + (pushed ? CARD_W_EXPANDED - CARD_W : 0), y: pos[rung].y, w };
      shown[rung] = at;
      const el = cardEls.current[rung];
      if (el === null || el === undefined) continue;
      el.style.left = `${at.x}px`;
      el.style.top = `${at.y}px`;
      right = Math.max(right, at.x + w);
      bottom = Math.max(bottom, at.y + el.offsetHeight);
    }
    for (let i = 0; i < ORDER.length - 1; i += 1) {
      const g = linkEls.current[i];
      if (g === null || g === undefined) continue;
      const a = shown[ORDER[i]];
      const b = shown[ORDER[i + 1]];
      const x1 = a.x + a.w;
      const y1 = a.y + PORT_Y;
      const x2 = b.x;
      const y2 = b.y + PORT_Y;
      const reach = Math.max(28, Math.abs(x2 - x1) / 2);
      g.children[0]?.setAttribute("d", `M${x1} ${y1} C ${x1 + reach} ${y1}, ${x2 - reach} ${y2}, ${x2} ${y2}`);
    }
    const canvas = canvasRef.current;
    if (canvas !== null) {
      canvas.style.width = `${right + CANVAS_PAD}px`;
      canvas.style.height = `${bottom + CANVAS_PAD}px`;
    }
  }, []);
  // Every render can change a card's size, so every render re-places.
  useLayoutEffect(() => {
    place();
  });

  const dragRef = useRef<{ rung: Rung; from: Point; origin: Point; moved: boolean } | null>(null);
  const draggedRef = useRef(false);
  // The cards stack in the order they were last touched: a press, a drag or
  // an expand brings a card to the front of the others.
  const topRef = useRef(1);
  const raise = (rung: Rung): void => {
    const el = cardEls.current[rung];
    if (el === null || el === undefined) return;
    topRef.current += 1;
    el.style.zIndex = String(topRef.current);
  };
  const dragOf = (rung: Rung): RungCardProps["drag"] => ({
    onPointerDown: (event) => {
      draggedRef.current = false;
      if (event.button !== 0) return;
      raise(rung);
      if ((event.target as HTMLElement).closest("button, input, a") !== null) return;
      dragRef.current = {
        rung,
        from: { x: event.clientX, y: event.clientY },
        origin: posRef.current[rung],
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event) => {
      const drag = dragRef.current;
      if (drag === null || drag.rung !== rung) return;
      const dx = event.clientX - drag.from.x;
      const dy = event.clientY - drag.from.y;
      // A press that barely moves is a click, which aims the prompt.
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      event.currentTarget.dataset.dragging = "true";
      posRef.current = {
        ...posRef.current,
        [rung]: { x: Math.max(0, drag.origin.x + dx), y: Math.max(0, drag.origin.y + dy) },
      };
      place();
    },
    onPointerUp: (event) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null || !drag.moved) return;
      draggedRef.current = true;
      delete event.currentTarget.dataset.dragging;
      // Let go outside the Session card, the card is torn off: it becomes a
      // card on the deck, and its seat here goes back where it was.
      const host = event.currentTarget.closest(".sp-as-card")?.getBoundingClientRect();
      const outside =
        host !== undefined &&
        (event.clientX < host.left ||
          event.clientX > host.right ||
          event.clientY < host.top ||
          event.clientY > host.bottom);
      if (outside) {
        posRef.current = { ...posRef.current, [rung]: drag.origin };
        place();
        act({ type: "note", effect: TORN_OFF[rung] });
      }
    },
    onPointerCancel: (event) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null) return;
      delete event.currentTarget.dataset.dragging;
      posRef.current = { ...posRef.current, [rung]: drag.origin };
      place();
    },
  });
  const tidy = (): void => {
    posRef.current = HOME;
    place();
    act({ type: "note", effect: "Tidied: the four cards are back in a row, in the ladder's order." });
  };
  const links: LinkState[] = [
    "linked",
    sketching ? "pending" : "linked",
    sketching || stage === "briefed" ? "pending" : behind ? "changed" : "linked",
  ];

  const card = (rung: Rung) => ({
    rung,
    elRef: (el: HTMLElement | null) => {
      cardEls.current[rung] = el;
    },
    drag: dragOf(rung),
    wasDrag: () => draggedRef.current,
    expanded: expanded === rung,
    onExpand: (next: Rung | null) => {
      setExpanded(next);
      if (next !== null) raise(next);
      if (next !== "brief") setConfirming(false);
    },
  });
  const aimAt = (target: Aim) =>
    canAim(target, stage) ? { aim: target, aimed: aim === target, onAim } : {};

  return (
    <>
      <header className="sp-as-shade-head">
        <span className="sp-as-rung-name">Arc</span>
        <span className="sp-as-arc-name">{sim.arcName}</span>
        {model !== null ? <TugArcTrack model={model} /> : null}
        <span className="sp-as-arc-reading">{clause}</span>
        <span className="sp-as-spacer" />
        <TugPushButton size="xs" emphasis="ghost" role="action" onClick={tidy}>
          Tidy
        </TugPushButton>
        <TugPushButton size="xs" emphasis="ghost" role="action" onClick={onLower}>
          Transcript
        </TugPushButton>
      </header>
      <div className="sp-as-ladder">
        <div className="sp-as-canvas" ref={canvasRef}>
        <svg className="sp-as-links" aria-hidden="true">
          {links.map((state, i) => (
            <g
              key={ORDER[i]}
              className="sp-as-link"
              data-state={state}
              ref={(el) => {
                linkEls.current[i] = el;
              }}
            >
              <path className="sp-as-link-path" />
            </g>
          ))}
        </svg>
        <RungCard
          {...card("idea")}
          state="done"
          outLink={links[0]}
          title={IDEA}
          points={[{ text: `First prompt of ${SESSION}` }]}
          body={
            <p className="sp-as-does">
              The idea is the first prompt, and it is history, so a prompt cannot be aimed at it. A different idea is a
              different arc.
            </p>
          }
        >
          <TugPushButton size="xs" emphasis="outlined" role="action" onClick={onShowIdea}>
            Show in Transcript
          </TugPushButton>
        </RungCard>
        <RungCard
          {...card("sketch")}
          {...aimAt("sketch")}
          inLink={links[0]}
          outLink={links[1]}
          state={sketching ? "active" : "done"}
          mark={<SessionMark name={SESSION} />}
          title="The conversation"
          points={[
            { text: `${sim.turnCount} turns in the transcript` },
            ...(sim.sinceBrief > 0 ? [{ text: `${sim.sinceBrief} turns since the brief` }] : []),
          ]}
          body={
            <>
              <p className="sp-as-does">
                A plain prompt lands here. This is the session whose transcript is behind the shade, and it only grows,
                so it is never out of step. Turns since the brief are a hint that something said has not been written
                down.
              </p>
              <div className="sp-as-digest">
                {sim.log.slice(-4).map((turn, i) => (
                  <TurnLine key={`${i}-${turn.text}`} turn={turn} />
                ))}
              </div>
            </>
          }
        >
          <TugPushButton size="xs" emphasis="outlined" role="action" onClick={onLower}>
            Show Transcript
          </TugPushButton>
        </RungCard>
        <RungCard
          {...card("brief")}
          {...aimAt("brief")}
          inLink={links[1]}
          outLink={links[2]}
          state={sketching ? "pending" : stage === "briefed" ? "active" : "done"}
          mark={
            behind ? (
              <TugBadge size="xs" emphasis="tinted" role="caution">
                changed
              </TugBadge>
            ) : undefined
          }
          title={sketching ? "No brief yet" : "brief.md"}
          points={
            sketching
              ? [{ text: "Written from the sketch" }]
              : [
                  { text: briefPath },
                  behind
                    ? { text: `${sim.drift} commit(s) since the arc opened`, caution: true }
                    : { text: stage === "briefed" ? "No arc opened on it yet" : "In step with the arc" },
                ]
          }
          body={
            <>
              {confirming && behind && arcOpen ? (
                <div className="sp-as-confirm">
                  <TugInlineDialog
                    icon={<FileDiff />}
                    iconTone="caution"
                    title="Update the arc from the brief?"
                    description={`The brief changed in ${sim.drift} commit(s) since ${sim.arcName} opened. The arc re-reads it: the ${sim.stepsDone} finished step(s) stand, and it gains a step for each change. This is /arc ${sim.arcName} @brief.md, the door's continuation.`}
                    actions={
                      <>
                        <TugPushButton size="sm" emphasis="outlined" role="action" onClick={() => setConfirming(false)}>
                          Cancel
                        </TugPushButton>
                        <TugPushButton
                          size="sm"
                          emphasis="primary"
                          role="action"
                          onClick={() => {
                            setConfirming(false);
                            act({ type: "updateArc" });
                          }}
                        >
                          Update Arc
                        </TugPushButton>
                      </>
                    }
                  />
                </div>
              ) : null}
              <p className="sp-as-does">
                A prompt aimed here asks {SESSION} to revise the brief and commit it. The brief is the one rung the arc
                is built from, so it is the one link that can fall out of step.
              </p>
              <div className="sp-as-doc">
                <h4 className="sp-as-doc-head">Findings</h4>
                <ul className="sp-as-doc-list">
                  {BRIEF_FINDINGS.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <h4 className="sp-as-doc-head">Decisions</h4>
                <ul className="sp-as-doc-list">
                  {BRIEF_DECISIONS.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                  {sim.revisions.map((line, i) => (
                    <li
                      key={`${i}-${line}`}
                      className="sp-as-doc-added"
                      data-unbuilt={i >= sim.revisionsBuilt ? "true" : undefined}
                    >
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            </>
          }
        >
          {sketching ? (
            <TugPushButton size="xs" emphasis="outlined" role="action" onClick={() => act({ type: "writeBrief" })}>
              Write Brief
            </TugPushButton>
          ) : (
            <>
              {behind && arcOpen ? (
                <TugPushButton
                  size="xs"
                  emphasis="outlined"
                  role="action"
                  onClick={() => {
                    setExpanded("brief");
                    setConfirming(true);
                  }}
                >
                  Update Arc from Brief…
                </TugPushButton>
              ) : null}
              {behind && stage === "joined" ? (
                <TugPushButton size="xs" emphasis="outlined" role="action" onClick={() => act({ type: "followUp" })}>
                  Open Follow-up Arc
                </TugPushButton>
              ) : null}
              <TugPushButton
                size="xs"
                emphasis="ghost"
                role="action"
                onClick={() =>
                  act({
                    type: "note",
                    effect: "Opens brief.md in a Text card beside this one, in Markdown preview. The shade stays up.",
                  })
                }
              >
                Open in Text Card
              </TugPushButton>
            </>
          )}
        </RungCard>
        <RungCard
          {...card("arc")}
          {...aimAt("arc")}
          inLink={links[2]}
          state={arcOpen ? "active" : stage === "joined" ? "done" : "pending"}
          mark={arcOpen ? <SessionMark name={WORKER} /> : undefined}
          title={arcOpen || stage === "joined" ? sim.arcName : "Not opened"}
          points={
            arcOpen
              ? [
                  { text: clause },
                  { text: `tugarc/${sim.arcName}` },
                  ...(sim.follows !== null ? [{ text: `Follows ${sim.follows}` }] : []),
                ]
              : stage === "joined"
                ? [{ text: clause }, { text: "A finished record" }]
                : [{ text: "Opens on the brief" }]
          }
          body={
            <>
              <p className="sp-as-does">
                {stage === "joined"
                  ? "A joined arc is a finished record, so a prompt cannot be aimed at it. Revise the brief and open a follow-up arc instead."
                  : `A prompt aimed here is a note to the stage in hand, which is ${WORKER}. The wheel still owns the run, and the brief does not change.`}
              </p>
              <TugPopupListFrame kind="item" className="sp-as-steps">
                <ArcStepItems steps={ledger(sim)} live={model !== null && model.live} />
              </TugPopupListFrame>
            </>
          }
        >
          {model !== null && arcOpen ? <TugArcTrack model={model} /> : null}
          {stage === "briefed" ? (
            <TugPushButton size="xs" emphasis="outlined" role="action" onClick={() => act({ type: "openArc" })}>
              Open Arc
            </TugPushButton>
          ) : null}
          {stage === "ready" ? (
            <TugPushButton size="xs" emphasis="outlined" role="action" onClick={() => act({ type: "join" })}>
              Join
            </TugPushButton>
          ) : null}
        </RungCard>
        </div>
      </div>
      <footer className="sp-as-shade-foot">
        <p className="sp-as-effect">{sim.effect}</p>
        <div className="sp-as-legend">
          <span className="sp-as-legend-item" data-state="linked">
            in step
          </span>
          <span className="sp-as-legend-item" data-state="changed">
            brief changed since the arc opened
          </span>
          <span className="sp-as-legend-item" data-state="pending">
            not yet
          </span>
        </div>
      </footer>
    </>
  );
}

// ---------------------------------------------------------------------------
// The Session card stand-in
// ---------------------------------------------------------------------------

/** `^brief rest` → the aim and the rest. */
const AIM_PREFIX = /^\^(sketch|brief|arc)\s(.*)$/s;

function SpikeArcShade(): React.ReactElement {
  const [sim, act] = useReducer(reduce, "executing", preset);
  const [reach, setReach] = useState("90");
  const [open, setOpen] = useState(true);
  const [wantedAim, setWantedAim] = useState<Aim>("sketch");
  const [text, setText] = useState("");
  // Whether the idea's turn is marked in the transcript, which Show in
  // Transcript sets as it lowers the shade and the next raise clears.
  const [ideaMarked, setIdeaMarked] = useState(false);
  const stageSenderId = useId();
  const reachSenderId = useId();
  const responderId = useId();
  const { ResponderScope, responderRef } = useResponder({
    id: responderId,
    actions: {
      [TUG_ACTIONS.SELECT_VALUE]: (event: ActionEvent) => {
        if (typeof event.value !== "string") return;
        if (event.sender === stageSenderId) act({ type: "reset", stage: event.value as Stage });
        else if (event.sender === reachSenderId) setReach(event.value);
      },
    },
  });

  // An aim the arc has moved past falls back to the plain prompt.
  const aim: Aim = canAim(wantedAim, sim.stage) ? wantedAim : "sketch";
  const model = trackOf(sim);
  const cellValue =
    sim.stage === "sketching"
      ? "Sketching"
      : sim.stage === "joined"
        ? "Joined"
        : model !== null
          ? (arcReading(model).fraction ?? arcCellWord(model))
          : "None";
  const dots = model !== null && model.live ? "running" : "paused";

  // The transcript keeps its newest turn in view, which with the shade up is
  // the strip above it; Show in Transcript goes to the top instead.
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = transcriptRef.current;
    if (el === null) return;
    el.scrollTop = ideaMarked ? 0 : el.scrollHeight;
  }, [sim.log, open, reach, ideaMarked]);

  const toggle = (): void => {
    setOpen((was) => !was);
    setIdeaMarked(false);
  };
  const lower = (): void => setOpen(false);
  const showIdea = (): void => {
    setOpen(false);
    setIdeaMarked(true);
  };
  const send = (): void => {
    act({ type: "send", aim, text: text.trim().length > 0 ? text.trim() : SAMPLE[aim] });
    setText("");
    setIdeaMarked(false);
  };
  const type = (value: string): void => {
    const match = AIM_PREFIX.exec(value);
    if (match !== null && canAim(match[1] as Aim, sim.stage)) {
      setWantedAim(match[1] as Aim);
      setText(match[2] ?? "");
    } else {
      setText(value);
    }
  };

  return (
    <ResponderScope>
      <div className="sp-content" ref={responderRef as (el: HTMLDivElement | null) => void}>
        <section className="sp-section">
          <h2 className="sp-section-title">The arc shade</h2>
          <p className="sp-as-note">
            A working model. The ARC cell, rightmost in Z2, raises and lowers the shade. Drag a card anywhere on the
            shade and its connectors follow; drag one off the Session card to tear it off. Click a card to aim the
            prompt at it, or type {ARC_SIGIL}brief or {ARC_SIGIL}arc and a space; Send with the prompt empty sends a
            sample. Every card button changes the arc, and the line at the foot of the shade says what it did.
          </p>
          <div className="sp-as-controls">
            <span className="sp-as-control">
              <span className="sp-as-control-label">Start from</span>
              <TugChoiceGroup
                items={STAGE_ITEMS}
                value={sim.stage}
                senderId={stageSenderId}
                size="sm"
                commit="live"
                aria-label="Start from"
              />
            </span>
            <span className="sp-as-control">
              <span className="sp-as-control-label">Shade reach</span>
              <TugChoiceGroup
                items={REACH_ITEMS}
                value={reach}
                senderId={reachSenderId}
                size="sm"
                commit="live"
                aria-label="Shade reach"
              />
            </span>
          </div>
          {/* The Session card: a masthead, the transcript with the shade over
              it, Z2, and the prompt entry. */}
          <div
            className="sp-as-card"
            data-shade={open ? "open" : "closed"}
            data-reach={reach}
            onKeyDown={(event) => {
              if (event.key === "Escape" && open) {
                event.stopPropagation();
                lower();
              }
            }}
          >
            <div className="sp-as-masthead">
              <span className="sp-as-masthead-title">{SESSION}</span>
              <span className="sp-as-masthead-meta">
                {ARC_SIGIL}
                {sim.arcName}
              </span>
            </div>
            <div className="sp-as-transcript-area">
              <div className="sp-as-transcript" ref={transcriptRef}>
                {sim.log.map((turn, i) => (
                  <TurnLine key={`${i}-${turn.text}`} turn={turn} marked={i === 0 && ideaMarked} />
                ))}
              </div>
              <div className="sp-as-shade" aria-hidden={!open} inert={!open}>
                <ArcLadder
                  sim={sim}
                  model={model}
                  aim={aim}
                  onAim={setWantedAim}
                  act={act}
                  onShowIdea={showIdea}
                  onLower={lower}
                />
              </div>
            </div>
            <div className="sp-as-z2">
              <div className="session-telemetry-status-row">
                <SessionTelemetryCell priority="state" label="STATE">
                  <span className="session-telemetry-status-value">{dots === "running" ? "Working" : "Idle"}</span>
                </SessionTelemetryCell>
                <SessionTelemetryCell priority="time" label="TIME">
                  <span className="session-telemetry-status-value">0:42</span>
                </SessionTelemetryCell>
                <SessionTelemetryCell priority="context" label="CONTEXT">
                  <span className="session-telemetry-status-value">38%</span>
                </SessionTelemetryCell>
                <SessionTelemetryCell priority="jobs" label="JOBS" valueEmpty>
                  <span className="session-telemetry-status-value">None</span>
                </SessionTelemetryCell>
                {/* The seat is the spike's own element. It carries the
                    pressed state the real cell would carry itself. */}
                <span className="sp-as-arc-seat" data-on={open ? "true" : undefined}>
                  <SessionTelemetryCell
                    priority="arc"
                    label="ARC"
                    onActivate={toggle}
                    aria-label={open ? "Lower the arc shade" : "Raise the arc shade"}
                  >
                    <TugProgressIndicator variant="pulsing-dot" size={12} state={dots} aria-hidden />
                    <span className="session-telemetry-status-value">{cellValue}</span>
                    <TugProgressIndicator variant="pulsing-dot" size={12} state={dots} aria-hidden />
                  </SessionTelemetryCell>
                </span>
              </div>
            </div>
            {/* The prompt entry: the one place a prompt is typed, whatever it
                is aimed at. */}
            <div className="sp-as-composer">
              <div className="sp-as-composer-row">
                {aim !== "sketch" ? (
                  <TugBadge size="sm" emphasis="tinted" role="accent">
                    {ARC_SIGIL}
                    {aim}
                  </TugBadge>
                ) : null}
                <TugInput
                  className="sp-as-composer-input"
                  size="md"
                  value={text}
                  placeholder={SAMPLE[aim]}
                  aria-label="Prompt"
                  onChange={(event) => type(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      send();
                    } else if (event.key === "Backspace" && text.length === 0 && aim !== "sketch") {
                      setWantedAim("sketch");
                    }
                  }}
                />
                <TugPushButton size="sm" emphasis="primary" role="action" onClick={send}>
                  Send
                </TugPushButton>
              </div>
              <p className="sp-as-does">{consequence(aim, sim)}</p>
            </div>
          </div>
        </section>
      </div>
    </ResponderScope>
  );
}

export const spike: SpikeDef = {
  name: "arc-shade",
  title: "Arc Shade",
  blurb:
    "The Z2 ARC cell as the toggle for a shade over the transcript that shows the arc as four connected cards, with a working model of what aiming a prompt at a rung and pressing each card's button does.",
  icon: "Waypoints",
  size: {
    min: { width: 640, height: 520 },
    preferred: { width: 1040, height: 940 },
  },
  component: () => <SpikeArcShade />,
};
