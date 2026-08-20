/**
 * spike-dash-progress.tsx — can a dash's step progress live INSIDE the rows we
 * already have, at their existing heights?
 *
 * ROUND 2. The first round showed four treatments; these are the verdicts:
 *
 *   - T1 step strip — PASSED ON. A 30-step plan makes the strip a paragraph
 *     of ticks; the treatment does not survive its own upper bound.
 *   - T2 dot ring — CHOSEN, refined here: the ring takes the session's STATE
 *     color rather than the accent, so it is one system with the phase dot it
 *     wraps — cobalt while working, caution while a question waits, danger on
 *     error, success when every step has landed. Destined for the Lens row
 *     and the session masthead.
 *   - T3 baseline gauge, T4 fraction — the gauge is out; the fraction
 *     survives as the ring's numerate companion where a row has the width.
 *   - The numbered step list — TABLED. The Z2 WORK popover already depicts
 *     the plan's steps; these ideas are held for a refresh of that surface.
 *   - Session identity atoms — a custom-named session should HIDE its
 *     callsign (shown again only to break a name collision). That is separate
 *     work, decided but not begun; the compact worker references in section 4
 *     preview what rows look like once it lands.
 *
 * Sections:
 *   1. The ring, refined — state colors, sizes, and the inline miniature.
 *   2. The masthead at 72px — the ring on the dot, in two states.
 *   3. The Lens row back at three lines — today vs proposed.
 *   4. Dashes, always on — the promoted section, rebuilt as stacked rows.
 *   5. The shade's collapsed row — line 2 underneath the atom, indented.
 *
 * @module spikes/spike-dash-progress
 */

import "./spike.css";
import "./spike-dash-progress.css";

import React from "react";
import { GitBranch } from "lucide-react";

import type { SpikeDef } from "./spike-registry";

import { DashFactsRun, DashReviewMark } from "@/components/lens/sections/dash-facts";
import { DashSigil } from "@/components/tugways/dash-sigil";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugMetaRun } from "@/components/tugways/tug-meta-run";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugSessionIdentity } from "@/components/tugways/tug-session-identity";
import {
  TugSessionRow,
  TUG_SESSION_ROW_INDICATOR_SIZE,
  TUG_SESSION_ROW_STACK_DOT_SIZE,
} from "@/components/tugways/tug-session-row";
import { sessionSessionPhaseVisual } from "@/lib/code-session-store/session-phase-visual";
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
 * With `dotSize` it wraps a live phase dot (the masthead / Lens form); with
 * neither it is the inline miniature — a bare 14px glyph that rides in a text
 * run where the strip used to.
 */
function DotRing({
  current,
  total,
  phase = "tool_work",
  dotSize,
  complete = false,
}: {
  current: number;
  total: number;
  /** The session phase key the ring (and inner dot) take their color from. */
  phase?: string;
  /** Render a live phase dot inside; omitted → the inline miniature. */
  dotSize?: number;
  complete?: boolean;
}): React.ReactElement {
  const role = complete
    ? "success"
    : (sessionSessionPhaseVisual(phase).role ?? "inherit");
  const stroke = 2;
  const box = dotSize !== undefined ? dotSize + 10 : 14;
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
      {dotSize !== undefined ? (
        <span className="spdp-ring-dot">
          <TugProgressIndicator
            variant="pulsing-dot"
            size={dotSize}
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

const FLOW_CURRENT = 7;

/** The compact worker reference: a phase dot and the session's display name.
 *  This PREVIEWS the identity-atom decision — a custom-named session hides
 *  its callsign, so the reference is short enough to sit at a line's end; an
 *  unnamed session would show its callsign here instead. */
function WorkerRef({
  name,
  phase,
}: {
  name: string;
  phase: string;
}): React.ReactElement {
  return (
    <span className="spdp-worker" data-slot="spdp-worker">
      <TugProgressIndicator
        variant="pulsing-dot"
        size={8}
        phase={phase}
        phaseVisual={sessionSessionPhaseVisual}
        aria-hidden
      />
      <span className="spdp-worker-name">{name}</span>
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
  /** Line 2's lead: the step being worked, or the draft's subject. */
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
        The chosen treatment, refined: the ring takes its tone from the{" "}
        <em>same phase mapping the dot inside it reads</em>, never the theme
        accent. One glyph now answers two questions — what the session is
        doing this second (the dot, as today) and how far through its plan the
        dash is (the ring). A session parked on a question wears caution on
        both; every step landed reads success whatever the session is doing.
        The step strip is passed on: at 30 steps it is a paragraph of ticks,
        and a treatment that fails its upper bound fails.
      </p>
      <div className="spdp-specimen-grid">
        <RingSpecimen caption="working — the dot's own fixed cobalt, step 7 of 12">
          <DotRing current={7} total={12} phase="tool_work" dotSize={16} />
        </RingSpecimen>
        <RingSpecimen caption="awaiting an answer — caution ring, caution dot">
          <DotRing
            current={7}
            total={12}
            phase="awaiting_approval"
            dotSize={16}
          />
        </RingSpecimen>
        <RingSpecimen caption="errored — the failure outranks the count">
          <DotRing current={7} total={12} phase="errored" dotSize={16} />
        </RingSpecimen>
        <RingSpecimen caption="idle — quiet ring on a still dot; progress persists">
          <DotRing current={7} total={12} phase="idle" dotSize={16} />
        </RingSpecimen>
        <RingSpecimen caption="complete — every step landed reads success">
          <DotRing current={12} total={12} complete dotSize={16} />
        </RingSpecimen>
        <RingSpecimen caption="N=24 — past 16 steps the ring is one continuous arc">
          <DotRing current={9} total={24} phase="tool_work" dotSize={16} />
        </RingSpecimen>
        <RingSpecimen caption="the Lens monitor size (28px dot)">
          <DotRing
            current={7}
            total={12}
            phase="tool_work"
            dotSize={TUG_SESSION_ROW_INDICATOR_SIZE}
          />
        </RingSpecimen>
        <RingSpecimen caption="the inline miniature, with its fraction — for rows with no dot of their own">
          <span className="spdp-inline-pair">
            <DotRing current={7} total={12} phase="tool_work" />
            <Fraction current={7} total={12} />
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
          <DotRing
            current={FLOW_CURRENT}
            total={12}
            phase={phase}
            dotSize={TUG_SESSION_ROW_STACK_DOT_SIZE}
          />
        }
        name={
          <span className="spdp-title-run">
            <TugSessionIdentity
              identity={WORKER_FLOW}
              tier="line"
              dot={false}
              tooltip={false}
            />
            <DashSigil name="flow-mode" review={null} slot="spdp-title-dash" />
          </span>
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
        The ring wraps the masthead's existing 16px dot: same three lines, same
        tier, no character of the title line spent. The count and the current
        step's title live on the ring's hover. Two states, so the state-color
        rule is visible doing its work:
      </p>
      <MastheadMock phase="tool_work" />
      <span className="spdp-mock-caption">
        working — cobalt dot, cobalt ring, step 7 of 12
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
            <DotRing
              current={FLOW_CURRENT}
              total={12}
              phase="tool_work"
              dotSize={TUG_SESSION_ROW_INDICATOR_SIZE}
            />
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
        indicatorSize={TUG_SESSION_ROW_INDICATOR_SIZE}
        name={
          <span className="spdp-title-run">
            <TugSessionIdentity
              identity={WORKER_FLOW}
              tier="line"
              dot={false}
              tooltip={false}
            />
            <DashSigil name="flow-mode" review={null} slot="spdp-rail-dash" />
          </span>
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
        Today's bound row grows a fourth line, so the rail's rows are two
        heights. Proposed: the 28px monitor dot the row already leads with
        takes the ring, and the row is three lines forever. The stage word and
        the step's title move to the ring's hover and to the Dashes section,
        which is built to hold them.
      </p>
      <div className="spdp-pair">
        <div className="spdp-pair-item">
          <span className="spdp-mock-caption">today — four lines when bound</span>
          <LensRowMock proposed={false} />
        </div>
        <div className="spdp-pair-item">
          <span className="spdp-mock-caption">proposed — three lines, always</span>
          <LensRowMock proposed />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section 4 — Dashes, always on (rebuilt)
// ---------------------------------------------------------------------------

function DashesRowMock({ f }: { f: DashRowFixture }): React.ReactElement {
  const counted = f.current !== null && f.total !== null;
  return (
    <TugListRow
      className="spdp-dashes-row"
      variant="flush"
      density="compact"
      data-dash={f.name}
    >
      <span className="spdp-dashes-lines">
        <span className="spdp-dashes-l1">
          <DashSigil
            name={f.name}
            review={f.review}
            slot="spdp-dashes-name"
            atom
            atomSize="2xs"
          />
          <span className="spdp-dashes-stage">{f.stage}</span>
          {counted ? (
            <>
              <DotRing
                current={f.current!}
                total={f.total!}
                complete={f.complete}
                phase={f.phase ?? "idle"}
              />
              <Fraction current={f.current!} total={f.total!} />
            </>
          ) : null}
          {f.review !== null ? (
            <DashReviewMark review={f.review} size={12} />
          ) : null}
          <span className="spdp-dashes-age">{f.age}</span>
        </span>
        <span className="spdp-dashes-l2">
          {f.detail !== null ? (
            <span className="spdp-dashes-detail">{f.detail}</span>
          ) : (
            <span className="spdp-dashes-detail" data-empty="true">
              no plan adopted
            </span>
          )}
          {f.facts.length > 0 ? (
            <TugMetaRun
              className="spdp-dashes-facts"
              slot="spdp-dashes-facts"
              parts={f.facts.map((fact) => (
                <span
                  key={fact.label}
                  className="spdp-dashes-fact"
                  data-tone={fact.tone}
                >
                  {fact.label}
                </span>
              ))}
            />
          ) : null}
          <span className="spdp-dashes-side">
            {f.workerName !== null ? (
              <WorkerRef
                name={f.workerName}
                phase={f.workerPhase ?? "idle"}
              />
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
          </span>
        </span>
      </span>
    </TugListRow>
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
      <h2 className="sp-section-title">4 · Dashes, always on — rebuilt</h2>
      <p className="spdp-prose">
        The always-on section, relaid after round 1's collision course. The
        rebuild's rules: <strong>the dash leads its own section</strong> —
        every row starts with the caret pill, bound or not, so the eye walks
        one column of names. Everything else stacks under it in a fixed
        two-line grammar with nothing fighting for line 1's width: the facts
        run left, the age is alone at the right edge. Line 2 is indented under
        the pill and ends with the row's "who": a compact reference to the
        bound session, or the verbs for an unbound dash. The worker reference
        assumes the identity-atom decision (callsign hidden under a custom
        name; an unnamed session shows its callsign, as{" "}
        <code>scroll-anchor</code>'s does).
      </p>
      <div className="spdp-rail" data-wide="true">
        <DashesBand count={DASH_ROWS.length} />
        <div className="spdp-dashes-list">
          {DASH_ROWS.map((f) => (
            <DashesRowMock key={f.name} f={f} />
          ))}
        </div>
      </div>
      <span className="spdp-mock-caption">
        Line 1: pill · stage · ring · fraction · review — age right. Line 2,
        indented: the step being worked (or the draft's subject) · divergence
        facts — worker or verbs right.
      </span>
      <div className="spdp-rail" data-wide="true">
        <DashesBand count={0} />
        <div className="spdp-dashes-empty">
          No dashes. <code>tugutil dash create</code> starts one.
        </div>
      </div>
      <span className="spdp-mock-caption">
        Empty state: the band stays. One quiet line costs ~24px of rail and
        buys the section a fixed address.
      </span>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section 5 — the shade's collapsed row
// ---------------------------------------------------------------------------

function ShadeSection(): React.ReactElement {
  return (
    <section className="sp-section">
      <h2 className="sp-section-title">
        5 · The shade's collapsed row — the second line under the atom
      </h2>
      <p className="spdp-prose">
        Two lines, as decided — with the second line positioned{" "}
        <em>underneath the atom</em>, indented under it, rather than beside it
        in a second column. The atom keeps the whole first line's leading
        position; the condition facts hang beneath it like a sub-line, so the
        urgent tail is always visible and the row reads top-down instead of
        left-right-then-wrap.
      </p>
      <div className="spdp-shade-row">
        <span className="spdp-shade-l1">
          <TugSessionIdentity
            identity={WORKER_FLOW}
            tier="chip"
            size="2xs"
            dash={{ name: "theme-audit", review: "stale" }}
            tooltip={false}
          />
          <span className="spdp-shade-facts">
            <span>built</span>
            <DotRing current={5} total={5} complete />
            <Fraction current={5} total={5} />
            <span>draft</span>
            <span>verified</span>
          </span>
        </span>
        <span className="spdp-shade-l2">
          <span data-tone="caution">base overlap (2)</span>
          <span data-tone="muted">base +3</span>
          <span data-tone="subtle">replayed</span>
        </span>
      </div>
      <span className="spdp-mock-caption">
        Line 1: the atom, then stage · ring · fraction · draft · verified.
        Line 2, indented under the atom: the divergence facts, most urgent
        first, never clipped.
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
