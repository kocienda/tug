/**
 * spike-dash-progress.tsx — can a dash's step progress live INSIDE the rows we
 * already have, at their existing heights?
 *
 * ROUND 2 verdicts: the step strip, baseline gauge, and standalone fraction
 * are passed on; the dot ring is chosen, in the session's STATE color (the
 * same phase mapping the dot reads — cobalt working, caution awaiting, danger
 * errored, success complete), never the theme accent. The numbered step list
 * is tabled for a Z2 WORK popover refresh.
 *
 * ROUND 3: unfilled ring segments toned well back — the count is read off the
 * filled/unfilled contrast. The Dashes section renders at its real floor, a
 * slim card's content width.
 *
 * ROUND 4, this one:
 *   - The identity rule is REMOVAL, not truncation: a custom-named session
 *     shows no callsign and no project run at all. The masthead and the Lens
 *     row both wear it here.
 *   - ONE ring geometry. The 28px monitor form outset the ring inside the
 *     dot's pulse; the small form has it right — the pulse ends AT the step
 *     depiction. The 16px dot + ring is the design, everywhere.
 *   - The plan stage is an ICON with its word on hover, beside the N/M count
 *     — `implementing` as a word was spending title-line width the icon
 *     carries in 13px.
 *   - The Dashes section adopts the Changes shade's EYEBROW grammar: the dash
 *     name leads a hairline header with the verbs (or the worker) at its
 *     right, and the metadata sits beneath in one controlled line — stage
 *     icon, ring, count, detail, age — with divergence on its own line only
 *     when there is any.
 *   - The shade's collapsed row is REGULARIZED with the Dashes rows: same
 *     icons, same ring, same fact tones — one language in both places.
 *
 * ROUND 5, after the join-arc rollout shipped the shade's face as a pile:
 *   - The face's facts are FIVE SPECIES — identity, work state, join state,
 *     evidence, content — plus acts, and only the first three stand. The
 *     collapsed block is three lines on one left margin: eyebrow,
 *     `DashMetaLine`, `DashJoinRegister`. A line renders nothing it cannot
 *     say, so a dash with no join arc is two lines.
 *   - Evidence and content live in the FOLD, on the fronted row only, ranked
 *     report → rounds → draft under the shade's own `TugSectionLabel`
 *     eyebrows — not a third dialect.
 *   - The outcome chip and the standing reason line are BANISHED: the chip
 *     restates the register's word, and a refusal rides the control that
 *     refuses ([D142]), not the face.
 *
 * Held separately: the identity-atom work itself (decided, not begun) — the
 * fixtures here preview it.
 *
 * @module spikes/spike-dash-progress
 */

import "./spike.css";
import "./spike-dash-progress.css";

import React from "react";
import {
  EllipsisVertical,
  FileCheck,
  GitBranch,
  GitMerge,
  Hammer,
  Package,
  ShieldCheck,
  Sprout,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import type { SpikeDef } from "./spike-registry";

import { DashFactsRun } from "@/components/lens/sections/dash-facts";
import { DashJoinRegisterView } from "@/components/tugways/dash-join-register";
import { DashSigil } from "@/components/tugways/dash-sigil";
import { TugSectionLabel } from "@/components/tugways/tug-section-label";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugSessionIdentity } from "@/components/tugways/tug-session-identity";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import {
  TugSessionRow,
  TUG_SESSION_ROW_INDICATOR_SIZE,
  TUG_SESSION_ROW_STACK_DOT_SIZE,
} from "@/components/tugways/tug-session-row";
import { sessionSessionPhaseVisual } from "@/lib/code-session-store/session-phase-visual";
import { CONTENT_WIDTH_SLIM_PX } from "@/lib/layout-imposer";
import {
  composeSessionIdentity,
  type SessionIdentity,
} from "@/lib/session-identity";

// ---------------------------------------------------------------------------
// The ring
// ---------------------------------------------------------------------------

/** Past this many steps the ring stops drawing per-step gaps: a 24-way split
 *  ring is texture, not a count, so it becomes one continuous arc. */
const RING_SEGMENT_MAX = 16;

/** THE dot size for the ring form. One geometry: the pulse ends at the ring,
 *  never inside it, which the small form gets right and the 28px monitor form
 *  did not. Every surface that takes the ring takes it at this size. */
const RING_DOT_SIZE = TUG_SESSION_ROW_STACK_DOT_SIZE;

/** One ring segment's arc path, angles in radians. */
function arcPath(
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
): string {
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/**
 * Step progress as a segmented ring, in the session's STATE color.
 *
 * The ring is one system with the phase dot it wraps: its tone comes from the
 * same phase→visual mapping the dot reads, so a session waiting on the user's
 * answer wears a caution ring around a caution dot, and a working one wears
 * the same fixed cobalt the working dot fills with. `complete` overrides to
 * the success tone — every step landed is the one reading that outranks what
 * the session is doing this second.
 *
 * With `dot` it wraps a live phase dot at {@link RING_DOT_SIZE} — the one
 * size the design has; without it, it is the inline miniature for rows with
 * no dot of their own.
 */
function DotRing({
  current,
  total,
  phase = "tool_work",
  dot = false,
  complete = false,
  size = 14,
}: {
  current: number;
  total: number;
  /** The session phase key the ring (and inner dot) take their color from. */
  phase?: string;
  /** Wrap a live phase dot; omitted → the inline miniature. */
  dot?: boolean;
  complete?: boolean;
  /** The miniature's box, in px. Ignored when `dot` sets the geometry. */
  size?: number;
}): React.ReactElement {
  const role = complete
    ? "success"
    : (sessionSessionPhaseVisual(phase).role ?? "inherit");
  const stroke = 2;
  const box = dot ? RING_DOT_SIZE + 10 : size;
  const c = box / 2;
  const r = c - stroke / 2 - 0.5;
  const segmented = total <= RING_SEGMENT_MAX;
  const gap = segmented ? 0.3 : 0;
  const span = (Math.PI * 2) / total;
  const top = -Math.PI / 2;
  const shown = complete ? total + 1 : current;
  const label = complete
    ? `all ${total} steps done`
    : `step ${current} of ${total}`;
  return (
    <span
      className="spdp-ring"
      data-role={role}
      style={{ width: box, height: box }}
      role="img"
      aria-label={label}
    >
      <svg
        className="spdp-ring-svg"
        width={box}
        height={box}
        viewBox={`0 0 ${box} ${box}`}
        aria-hidden
      >
        {Array.from({ length: total }, (_, i) => {
          const step = i + 1;
          const a0 = top + i * span + gap / 2;
          const a1 = top + (i + 1) * span - gap / 2;
          const state =
            step < shown ? "done" : step === shown ? "current" : "todo";
          return (
            <path
              key={step}
              className="spdp-ring-seg"
              data-state={state}
              d={arcPath(c, c, r, a0, a1)}
              fill="none"
              strokeWidth={stroke}
              strokeLinecap="round"
            />
          );
        })}
      </svg>
      {dot ? (
        <span className="spdp-ring-dot">
          <TugProgressIndicator
            variant="pulsing-dot"
            size={RING_DOT_SIZE}
            phase={phase}
            phaseVisual={sessionSessionPhaseVisual}
            aria-hidden
          />
        </span>
      ) : null}
    </span>
  );
}

/** The counters at caption weight: the ring's numerate companion where a row
 *  has the width for six characters. */
function Fraction({
  current,
  total,
}: {
  current: number;
  total: number;
}): React.ReactElement {
  return (
    <span className="spdp-fraction" aria-label={`step ${current} of ${total}`}>
      <span className="spdp-fraction-i">{current}</span>
      <span className="spdp-fraction-slash">/</span>
      <span className="spdp-fraction-n">{total}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// The stage mark
// ---------------------------------------------------------------------------

/** The plan stages, each as a glyph. The word rides the hover — a stage name
 *  in 13px of icon instead of 90px of text is what makes room for it on a
 *  title line. */
const STAGE_ICONS: Record<string, LucideIcon> = {
  created: Sprout,
  working: Wrench,
  implementing: Hammer,
  built: Package,
  audited: ShieldCheck,
  "draft-ready": FileCheck,
  joining: GitMerge,
};

function StageMark({
  stage,
  size = 13,
}: {
  stage: string;
  size?: number;
}): React.ReactElement {
  const Glyph = STAGE_ICONS[stage] ?? Sprout;
  return (
    <TugTooltip content={stage}>
      <span className="spdp-stage-mark" data-stage={stage} aria-label={stage}>
        <Glyph size={size} />
      </span>
    </TugTooltip>
  );
}

/**
 * The whole title run: `<name>^<dash>`, then the stage icon and the count.
 *
 * The name and the sigil are one FLUSH run — the identity grammar puts no
 * space between a name and its `^`, exactly as the shipping atom's run does
 * (`.tug-session-identity-run` has no gap). Only after the dash name does the
 * line breathe: a gap ahead of the stage icon, another ahead of the count.
 */
function TitleCluster({
  sessionName,
  name,
  review,
  stage,
  current,
  total,
  slot,
}: {
  sessionName: string;
  name: string;
  review: string | null;
  stage: string;
  current: number;
  total: number;
  slot: string;
}): React.ReactElement {
  return (
    <span className="spdp-cluster">
      <span className="spdp-name-dash">
        <CompactName name={sessionName} />
        <DashSigil name={name} review={review} slot={slot} />
      </span>
      <StageMark stage={stage} />
      <Fraction current={current} total={total} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKER_FLOW: SessionIdentity = composeSessionIdentity({
  sessionId: "spdp-flow-00000000",
  name: "Layout imposer",
  synopsis:
    "Reworks flow mode: the deck gets a second geometry, and a slot becomes a place that divides.",
  tag: "frothy-nurse-2",
  projectDir: "/u/src/tugtool",
  state: "live",
  ledgerKnown: true,
});

/**
 * The identity under the rule: a custom name is set, so the callsign is
 * REMOVED — no run, no fallback, nothing after the name.
 *
 * Deliberately NOT `TugSessionIdentity`: that component cannot say this.
 * `sessionTitleParts` always emits a callsign beside a custom name, and with
 * `tag: null` it falls back to the SHORT ID — which is exactly the
 * `:spdp-flo…` residue the earlier rounds showed. The mock renders the name
 * run directly, in the identity's own type register (semibold, one line),
 * because rendering nothing after it is the whole point. When the identity
 * work lands, `sessionTitleParts` is where the rule goes.
 */
function CompactName({ name }: { name: string }): React.ReactElement {
  return <span className="spdp-compact-name">{name}</span>;
}

/**
 * The session ATOM under the same rule: dot, custom name, dash — and no
 * callsign anywhere in the pill. Composed from the settled atom skin's own
 * class names, the identical borrowing `DashSigil`'s atom mode already does:
 * the enclosure, dot seat, and name register are `tug-session-identity.css`'s
 * chip rules, reached by the same selectors, so this pill is the shipping
 * pill minus exactly one run.
 */
function CompactAtom({
  name,
  dash,
  review,
  phase,
  size = "2xs",
}: {
  name: string;
  dash: string;
  review: string | null;
  phase: string;
  /**
   * Which chip size the skin wears. `2xs` is the rail's — a fact glanced at
   * beside other rails. `full` is the chip tier's own size, for a surface
   * whose lines beneath are set at `sm`: an atom a step smaller than the
   * facts it heads reads as a caption over its own content.
   */
  size?: "2xs" | "full";
}): React.ReactElement {
  const small = size === "2xs";
  return (
    <span
      className="tug-session-identity"
      data-slot="spdp-compact-atom"
      data-tier="chip"
      {...(small ? { "data-size": "2xs" } : {})}
    >
      <span className="tug-session-identity-dot">
        <TugProgressIndicator
          variant="pulsing-dot"
          size={small ? 10 : 12}
          phase={phase}
          phaseVisual={sessionSessionPhaseVisual}
          aria-hidden
        />
      </span>
      <span className="tug-session-identity-run">
        <span className="tug-session-identity-title">
          <span className="tug-session-identity-name">{name}</span>
        </span>
        <DashSigil
          name={dash}
          review={review}
          slot="spdp-compact-atom-dash"
          title={`Working on dash ${dash}`}
          ariaLabel={`On dash ${dash}`}
        />
      </span>
    </span>
  );
}

const FLOW_CURRENT = 7;

/** The worker as a MINI ATOM: the settled chip skin (same borrowing as
 *  {@link CompactAtom}) holding a phase dot and the session's display name —
 *  no callsign, no dash run. Previews the identity-atom decision; an unnamed
 *  session shows its callsign AS the name. */
function WorkerRef({
  name,
  phase,
}: {
  name: string;
  phase: string;
}): React.ReactElement {
  return (
    <span
      className="tug-session-identity spdp-worker"
      data-slot="spdp-worker"
      data-tier="chip"
      data-size="2xs"
    >
      <span className="tug-session-identity-dot">
        <TugProgressIndicator
          variant="pulsing-dot"
          size={10}
          phase={phase}
          phaseVisual={sessionSessionPhaseVisual}
          aria-hidden
        />
      </span>
      <span className="tug-session-identity-run">
        <span className="tug-session-identity-title">
          <span className="tug-session-identity-name">{name}</span>
        </span>
      </span>
    </span>
  );
}

interface DashRowFixture {
  name: string;
  stage: string;
  current: number | null;
  total: number | null;
  complete?: boolean;
  /** The session phase coloring this row's ring, when work is live. */
  phase?: string;
  /** The metadata line's lead: the step being worked, or the draft's subject. */
  detail: string | null;
  review: string | null;
  age: string;
  /** The bound session's display name (post identity-atom decision), or null. */
  workerName: string | null;
  workerPhase?: string;
  facts: readonly {
    label: string;
    tone: "danger" | "caution" | "muted" | "subtle";
  }[];
}

const DASH_ROWS: readonly DashRowFixture[] = [
  {
    name: "flow-mode",
    stage: "implementing",
    current: FLOW_CURRENT,
    total: 12,
    phase: "tool_work",
    detail: "A slot becomes a place that divides",
    review: null,
    age: "12m",
    workerName: "Layout imposer",
    workerPhase: "tool_work",
    facts: [{ label: "replayed", tone: "subtle" }],
  },
  {
    name: "join-hardening",
    stage: "draft-ready",
    current: 12,
    total: 12,
    complete: true,
    detail: "Join hardening: admission, server-side gating, terminal failure facts",
    review: null,
    age: "2h",
    workerName: null,
    facts: [{ label: "verified", tone: "muted" }],
  },
  {
    name: "theme-audit",
    stage: "built",
    current: 5,
    total: 5,
    complete: true,
    detail: "Contrast budget sweep across the six shipped themes",
    review: "stale",
    age: "1d",
    workerName: null,
    facts: [
      { label: "base overlap (2)", tone: "caution" },
      { label: "base +3", tone: "muted" },
    ],
  },
  {
    name: "scroll-anchor",
    stage: "joining",
    current: 8,
    total: 8,
    complete: true,
    phase: "awaiting_approval",
    detail: "Top-edge anchor; reflow re-anchored every frame",
    review: null,
    age: "3m",
    workerName: "brave-anchor-4",
    workerPhase: "awaiting_approval",
    facts: [{ label: "replay conflicts (1)", tone: "danger" }],
  },
  {
    name: "dom-eviction",
    stage: "created",
    current: null,
    total: null,
    detail: null,
    review: "never-reviewed",
    age: "4d",
    workerName: null,
    facts: [],
  },
];

// ---------------------------------------------------------------------------
// Section 1 — the ring, refined
// ---------------------------------------------------------------------------

function RingSpecimen({
  caption,
  children,
}: {
  caption: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="spdp-specimen">
      <span className="spdp-specimen-subject">{children}</span>
      <span className="spdp-specimen-caption">{caption}</span>
    </div>
  );
}

function RingSection(): React.ReactElement {
  return (
    <section className="sp-section">
      <h2 className="sp-section-title">1 · The ring, in the state color</h2>
      <p className="spdp-prose">
        The chosen treatment: the ring takes its tone from the{" "}
        <em>same phase mapping the dot inside it reads</em>, never the theme
        accent, and the unfilled steps are a toned-back whisper the fill
        contrasts against. <strong>One geometry.</strong> The dot is always{" "}
        {RING_DOT_SIZE}px inside its ring, so the pulse ends AT the step
        depiction — the 28px monitor form, whose pulse outset the ring, is
        retired from this design.
      </p>
      <div className="spdp-specimen-grid">
        <RingSpecimen caption="working — the dot's own fixed cobalt, step 7 of 12">
          <DotRing current={7} total={12} phase="tool_work" dot />
        </RingSpecimen>
        <RingSpecimen caption="awaiting an answer — caution ring, caution dot">
          <DotRing current={7} total={12} phase="awaiting_approval" dot />
        </RingSpecimen>
        <RingSpecimen caption="errored — the failure outranks the count">
          <DotRing current={7} total={12} phase="errored" dot />
        </RingSpecimen>
        <RingSpecimen caption="idle — quiet ring on a still dot; progress persists">
          <DotRing current={7} total={12} phase="idle" dot />
        </RingSpecimen>
        <RingSpecimen caption="complete — every step landed reads success">
          <DotRing current={12} total={12} complete dot />
        </RingSpecimen>
        <RingSpecimen caption="N=24 — past 16 steps the ring is one continuous arc">
          <DotRing current={9} total={24} phase="tool_work" dot />
        </RingSpecimen>
        <RingSpecimen caption="the inline miniature, with its fraction — for rows with no dot of their own">
          <span className="spdp-inline-pair">
            <DotRing current={7} total={12} phase="tool_work" />
            <Fraction current={7} total={12} />
          </span>
        </RingSpecimen>
        <RingSpecimen caption="the stage marks — the word rides the hover">
          <span className="spdp-inline-pair" data-gapped="true">
            {Object.keys(STAGE_ICONS).map((stage) => (
              <StageMark key={stage} stage={stage} />
            ))}
          </span>
        </RingSpecimen>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section 2 — the masthead at 72px
// ---------------------------------------------------------------------------

function MastheadMock({ phase }: { phase: string }): React.ReactElement {
  const awaiting = phase === "awaiting_approval";
  return (
    <div className="spdp-chrome">
      <TugSessionRow
        className="spdp-chrome-row"
        subAlign="title"
        indicator={
          <DotRing current={FLOW_CURRENT} total={12} phase={phase} dot />
        }
        name={
          <TitleCluster
            sessionName="Layout imposer"
            name="flow-mode"
            review={null}
            stage="implementing"
            current={FLOW_CURRENT}
            total={12}
            slot="spdp-title-dash"
          />
        }
        description={WORKER_FLOW.description ?? ""}
        activity={
          <span className="spdp-activity-run">
            {awaiting
              ? "Awaiting your answer — keep the divider protocol on narrow decks?"
              : "Editing tug-session-row.tsx — retiring the dash line"}
          </span>
        }
      />
    </div>
  );
}

function MastheadSection(): React.ReactElement {
  return (
    <section className="sp-section">
      <h2 className="sp-section-title">2 · The masthead — 72px, untouched</h2>
      <p className="spdp-prose">
        The ring wraps the masthead's dot; same three lines, same tier. The
        identity rule is applied: the custom name REMOVES the callsign and the
        project run — no truncation, no residue — and the reclaimed width
        carries the dash cluster: sigil, stage icon (word on hover), count.
      </p>
      <MastheadMock phase="tool_work" />
      <span className="spdp-mock-caption">
        working — cobalt dot, cobalt ring; the title reads name, dash, stage,
        count
      </span>
      <MastheadMock phase="awaiting_approval" />
      <span className="spdp-mock-caption">
        awaiting — the whole glyph turns caution; progress stays legible
      </span>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section 3 — the Lens row, back to three lines
// ---------------------------------------------------------------------------

function LensRowMock({ proposed }: { proposed: boolean }): React.ReactElement {
  return (
    <div className="spdp-rail">
      <TugSessionRow
        className="spdp-rail-row"
        subAlign="edge"
        indicator={
          proposed ? (
            <DotRing current={FLOW_CURRENT} total={12} phase="tool_work" dot />
          ) : (
            <TugProgressIndicator
              variant="pulsing-dot"
              size={TUG_SESSION_ROW_INDICATOR_SIZE}
              phase="tool_work"
              phaseVisual={sessionSessionPhaseVisual}
              aria-hidden
            />
          )
        }
        indicatorSize={proposed ? undefined : TUG_SESSION_ROW_INDICATOR_SIZE}
        name={
          proposed ? (
            <TitleCluster
              sessionName="Layout imposer"
              name="flow-mode"
              review={null}
              stage="implementing"
              current={FLOW_CURRENT}
              total={12}
              slot="spdp-rail-dash"
            />
          ) : (
            <span className="spdp-title-run">
              <TugSessionIdentity
                identity={WORKER_FLOW}
                tier="line"
                dot={false}
                tooltip={false}
              />
              <DashSigil name="flow-mode" review={null} slot="spdp-rail-dash" />
            </span>
          )
        }
        description={WORKER_FLOW.description ?? ""}
        activity={
          <span className="spdp-activity-run">Editing tug-session-row.tsx</span>
        }
        dashLine={
          proposed ? null : (
            <DashFactsRun
              name={null}
              stage="implementing"
              stepCurrent={FLOW_CURRENT}
              stepTotal={12}
              stepTitle="A slot becomes a place that divides"
              hasPlan
              review={null}
              markSize={14}
            />
          )
        }
      />
    </div>
  );
}

function LensRowSection(): React.ReactElement {
  return (
    <section className="sp-section">
      <h2 className="sp-section-title">3 · The Lens row — the fourth line retired</h2>
      <p className="spdp-prose">
        Today's bound row grows a fourth line and leads with the 28px monitor
        dot. Proposed: the one ring geometry (the {RING_DOT_SIZE}px dot inside
        its ring), three lines forever, and the identity rule applied in full —
        the callsign and project are REMOVED under the custom name, and the
        title line carries the dash cluster in their place:{" "}
        <code>^flow-mode</code>, the stage icon with its word on hover, and{" "}
        <code>7/12</code>. The step's <em>title</em> still lives on hover and
        in the Dashes section.
      </p>
      <div className="spdp-pair">
        <div className="spdp-pair-item">
          <span className="spdp-mock-caption">today — four lines when bound</span>
          <LensRowMock proposed={false} />
        </div>
        <div className="spdp-pair-item">
          <span className="spdp-mock-caption">
            proposed — three lines; callsign removed, the cluster in its place
          </span>
          <LensRowMock proposed />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section 4 — Dashes, always on (the eyebrow grammar)
// ---------------------------------------------------------------------------

function DashBlockMock({ f }: { f: DashRowFixture }): React.ReactElement {
  const counted = f.current !== null && f.total !== null;
  return (
    <div className="spdp-dash-block" data-dash={f.name}>
      {/* The eyebrow holds the identities and nothing else: the dash atom at
          the left, the hairline, the "who" at the right — the worker's mini
          atom, or the verbs. The dash pill never wears a review tint (that
          yellow is the WAITING color, and a dash is not waiting for anyone). */}
      <div className="spdp-eyebrow">
        <DashSigil
          name={f.name}
          review={null}
          slot="spdp-dashes-name"
          atom
          atomSize="2xs"
        />
        <span className="spdp-eyebrow-rule" />
        {f.workerName !== null ? (
          <WorkerRef name={f.workerName} phase={f.workerPhase ?? "idle"} />
        ) : (
          <span className="spdp-dashes-verbs">
            <TugPushButton size="2xs" subtype="text">
              Bind
            </TugPushButton>
            <TugPushButton size="2xs" subtype="text" role="danger">
              Discard
            </TugPushButton>
          </span>
        )}
      </div>
      {/* Everything the dash is DOING, in one metadata line beneath:
          ring · stage icon · count · note · age · divergence. */}
      <div className="spdp-dash-meta">
        {counted ? (
          <DotRing
            current={f.current!}
            total={f.total!}
            complete={f.complete}
            phase={f.phase ?? "idle"}
          />
        ) : null}
        <StageMark stage={f.stage} />
        {counted ? <Fraction current={f.current!} total={f.total!} /> : null}
        {f.detail !== null ? (
          <span className="spdp-dash-note">{f.detail}</span>
        ) : (
          <span className="spdp-dash-note" data-empty="true">
            no plan adopted
          </span>
        )}
        <span className="spdp-dash-age">{f.age}</span>
        {f.facts.map((fact) => (
          <span
            key={fact.label}
            className="spdp-dashes-fact"
            data-tone={fact.tone}
          >
            {fact.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function DashesBand({ count }: { count: number }): React.ReactElement {
  return (
    <div className="spdp-band">
      <GitBranch size={14} />
      <span className="spdp-band-title">Dashes</span>
      <span className="spdp-band-count">{count}</span>
    </div>
  );
}

function DashesSection(): React.ReactElement {
  return (
    <section className="sp-section">
      <h2 className="sp-section-title">4 · Dashes, always on — the eyebrow grammar</h2>
      <p className="spdp-prose">
        One grammar, worn by every dash line in the app. The eyebrow holds the
        IDENTITIES and nothing else: the dash atom at the left, the hairline,
        and the "who" at the right — the bound worker as a mini atom, or Bind
        and Discard. Beneath it one metadata line carries everything the dash
        is DOING: ring · stage icon · count · note · age · divergence in its
        tones. No review tint on the pills — that yellow means WAITING, and a
        dash is not waiting for anyone — and no review glyph either. At the
        section's real floor, a slim card's {CONTENT_WIDTH_SLIM_PX}px.
      </p>
      <div
        className="spdp-rail"
        data-wide="true"
        style={{ width: CONTENT_WIDTH_SLIM_PX }}
      >
        <DashesBand count={DASH_ROWS.length} />
        <div className="spdp-dashes-list">
          {DASH_ROWS.map((f) => (
            <DashBlockMock key={f.name} f={f} />
          ))}
        </div>
      </div>
      <span className="spdp-mock-caption">
        Eyebrow: atom — hairline — worker-in-mini-atom or verbs. Metadata
        beneath: ring · stage icon · count · note · age · divergence,
        tone-colored.
      </span>
      <div
        className="spdp-rail"
        data-wide="true"
        style={{ width: CONTENT_WIDTH_SLIM_PX }}
      >
        <DashesBand count={0} />
        <div className="spdp-dashes-empty">
          No dashes. <code>tugutil dash create</code> starts one.
        </div>
      </div>
      <span className="spdp-mock-caption">
        Empty state: the band stays. One quiet line costs ~24px and buys the
        section a fixed address.
      </span>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section 5 — the shade's dash face: five species, three lines, one fold
// ---------------------------------------------------------------------------

/** The register's collapsed reading, hand-set: the shade's built dash. */
const READY_REGISTER = {
  phase: "success",
  line: "Ready to join",
  word: "ready",
} as const;

/** The three-line collapsed block — the whole face, every dash, both surfaces. */
function ProposedBlock(): React.ReactElement {
  return (
    <div className="spdp-shade-row">
      <span className="spdp-eyebrow">
        <CompactAtom
          name="Layout imposer"
          dash="imposer-polish"
          review={null}
          phase="idle"
          size="full"
        />
        <span className="spdp-eyebrow-rule" />
        <TugPushButton
          size="2xs"
          subtype="icon"
          emphasis="ghost"
          aria-label="Actions for dash imposer-polish"
          icon={<EllipsisVertical size={14} />}
        />
      </span>
      <span className="spdp-dash-meta">
        <DotRing current={5} total={5} complete size={16} />
        <StageMark stage="built" size={15} />
        <Fraction current={5} total={5} />
        <span className="spdp-dash-note">draft · verified</span>
        <span className="spdp-dash-age">1d</span>
        <span className="spdp-dashes-fact" data-tone="caution">
          base overlap (2)
        </span>
      </span>
      <span className="spdp-dash-register">
        <DashJoinRegisterView register={READY_REGISTER} altitude="entry" />
      </span>
    </div>
  );
}

function ShadeSection(): React.ReactElement {
  return (
    <section className="sp-section">
      <h2 className="sp-section-title">
        5 · The shade's dash face — three lines, then a fold
      </h2>
      <p className="spdp-prose">
        What you will see when a dash is bound: <strong>three lines</strong>,
        one left margin. Line 1 — who (the session atom, its dash inside, the ⋯
        holding the rare verbs). Line 2 — what the dash is doing (ring · stage ·
        count · note · age · divergence). Line 3 — what its join will do (the
        register, resting green here). Nothing else stands: no outcome chip, no
        "Wait for the turn to finish", no advisory, no subjects, no files.
      </p>
      <p className="spdp-prose">
        <strong>All three lines are one scale.</strong> The shade is the
        surface you came to read, not a rail you glance at, so what the dash is
        doing is set at the register's own size rather than a footnote beneath
        it — and the register spans the block instead of floating as a pill, so
        it reads as line 3 rather than as a widget that landed here. The Lens
        keeps the compact scale; that is the one place the two surfaces differ.
      </p>
      <ProposedBlock />
      <span className="spdp-mock-caption">
        The whole collapsed face. The `clean` chip is gone (line 3's word
        already is the outcome); the standing refusal is gone (it rides the ⋯
        menu item that refuses).
      </span>
      <p className="spdp-prose">
        A dash with no join arc drops line 3 rather than showing a stub —
        <strong> two lines</strong>:
      </p>
      <div className="spdp-shade-row">
        <span className="spdp-eyebrow">
          <CompactAtom
            name="Layout imposer"
            dash="flow-mode"
            review={null}
            phase="tool_work"
            size="full"
          />
          <span className="spdp-eyebrow-rule" />
          <TugPushButton
            size="2xs"
            subtype="icon"
            emphasis="ghost"
            aria-label="Actions for dash flow-mode"
            icon={<EllipsisVertical size={14} />}
          />
        </span>
        <span className="spdp-dash-meta">
          <DotRing current={FLOW_CURRENT} total={12} phase="tool_work" size={16} />
          <StageMark stage="implementing" size={15} />
          <Fraction current={FLOW_CURRENT} total={12} />
          <span className="spdp-dash-note">A slot becomes a place that divides</span>
          <span className="spdp-dash-age">12m</span>
        </span>
      </div>
      <span className="spdp-mock-caption">
        Still being worked: no join arc yet, so no register line.
      </span>
      <p className="spdp-prose">
        Everything that used to stand — the check evidence, the round's
        subjects and files, the join message — moves into the{" "}
        <strong>fold</strong>, which opens on the fronted row only. What you
        will see when you front a dash:
      </p>
      <div className="spdp-fold-frame">
        <ProposedBlock />
        <div className="spdp-fold">
          <div className="spdp-fold-section">
            <TugSectionLabel label={{ name: "report" }} slot="spdp-fold-report" />
            <span className="spdp-fold-tier" data-tone="success">
              <ShieldCheck size={13} />
              <span>Build — vite build exited 0</span>
            </span>
            <span className="spdp-advisory">
              no app-test covers what this candidate changed
            </span>
          </div>
          <div className="spdp-fold-section">
            <TugSectionLabel
              label={{ name: "rounds", qualifier: "1" }}
              slot="spdp-fold-rounds"
            />
            <span className="spdp-subject">
              tugdash(imposer-polish): adopt plan roadmap/layout-imposer-polish.md
            </span>
            <span className="spdp-file">
              <span className="spdp-file-status">N</span>
              roadmap/layout-imposer-polish.md
            </span>
          </div>
          <div className="spdp-fold-section">
            <TugSectionLabel label={{ name: "draft" }} slot="spdp-fold-draft" />
            <span className="spdp-subject" data-muted="true">
              adopt plan roadmap/layout-imposer-polish.md
            </span>
          </div>
        </div>
      </div>
      <span className="spdp-mock-caption">
        The fold, ranked: report (the verdict's evidence, advisories included) ·
        rounds (what would land) · draft (the message it lands with). Same
        eyebrow labels as the shade's own buckets.
      </span>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

function SpikeDashProgress(): React.ReactElement {
  return (
    <div className="sp-content spdp">
      <RingSection />
      <MastheadSection />
      <LensRowSection />
      <DashesSection />
      <ShadeSection />
    </div>
  );
}

export const spike: SpikeDef = {
  name: "dash-progress",
  title: "Dash Progress",
  blurb:
    "The state-colored step ring inside fixed-height rows, and the Dashes section promoted to always-on.",
  icon: "GitBranch",
  size: { min: { width: 480, height: 400 }, preferred: { width: 760, height: 680 } },
  component: () => <SpikeDashProgress />,
};
