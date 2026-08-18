/**
 * spike-session-identity.tsx — the session-reference design surface.
 *
 * **SHIPPED.** The brief was `roadmap/session-reference-brief.md`: one identity
 * model, one resolver, one component family. Earlier rounds settled the two
 * registers (presence vs citation), the session atom's shape, the flat-text
 * citation, and the fork-lineage grammar. The seventh round settled the
 * CONTENT — what the surfaces actually say, and in what order — and
 * `roadmap/session-identity.md` carried all of it into the app. Every decision
 * below is now the shipped behavior, and `[D132]` is where it is durable; this
 * card is the bench the identity app-tests drive and the place the vocabulary is
 * discussed.
 *
 * Two questions from that round were deferred rather than answered, and they are
 * the surviving open items: whether the atom's sidecar segment should carry the
 * short id, and whether the Changes card's server-side `session_row_title` should
 * adopt the new grammar.
 *
 * What the seventh round decided, all of it shipped:
 *
 * - **The dot is the mark.** The chatbox icon retires from every surface that
 *   names a session; the pulsing phase dot replaces it — in the masthead, the
 *   rows, and the atom itself. One mark, everywhere, and the mark is ALIVE:
 *   it says what the session is doing, not just what kind of thing it is.
 * - **Red means errors.** The dot's idle form is the quiet white/inherit
 *   rung, and it is also the DOUBT form: a session whose live data is
 *   unreachable — closed, external, unbound — wears the idle dot, never a
 *   red one. Red is reserved for genuine failure: an errored turn, a dead
 *   wire under a live card.
 * - **The user's name leads.** A custom name is the user explicitly telling
 *   us what the session is called, and it cannot ride below a callsign we
 *   minted ourselves. The title grammar is
 *   `<custom-name> : <project>/<callsign>` when a name exists, bare
 *   `<project>/<callsign>` when not — in the masthead, the rows, the picker,
 *   and the atom, all four. (An earlier revision dropped the `project/`
 *   prefix from title ink; that is reversed — seeing the project a session
 *   works against is worth the run.) This obliges the resolver to stop
 *   conflating: `SessionIdentity.title` (the `name ?? synopsis` merge)
 *   retires in favor of `customName` and `description` as separate fields.
 * - **Two levels under the title, not three.** The stack is title /
 *   description / activity. The standing-intent line (the old headline
 *   level) is cut as chrome ink — the description already says what the
 *   session is for, and two goal-shaped lines read as an echo. The intent
 *   survives in the history popover, where it heads its run of beats.
 * - **The word PULSE never prints.** It is the feature's internal name —
 *   stores, files, tests — and no longer a label, a legend, or a stand-in
 *   anywhere a user reads. The activity line always has something true to
 *   say instead (see the grammar below), so nothing needs a placeholder.
 * - **The activity line has a grammar.** At rest:
 *   `<turns> turns, <size>. Last updated: <last-updated>. Ready.` — with the
 *   stamp omitted at zero turns. During a turn it carries the live beat, and
 *   the sparkline beside it animates. A fresh or resumed session with no
 *   description yet shows its creation stamp on the description line, so the
 *   line is never blank and never a placeholder word.
 * - **The masthead slims its controls.** The width-control icon leaves the
 *   title row; the wave (telemetry) widget and close remain. Right-clicking
 *   the title copies the session ATOM — all flavors — and the telemetry
 *   popover displays the atom itself alongside the flat citation.
 * - **The atom is live.** It renders `[dot] <project>/<callsign>` or
 *   `[dot] <custom-name> : <project>/<callsign>`, and both the dot and the name track
 *   the running app — a rename mid-conversation repaints every mounted atom.
 *   So the atom is a COMPONENT with subscriptions, never a static string or
 *   a baked image. The liveness plumbing is designed in the atom section's
 *   prose: identity through `useSessionIdentity`, phase through a new
 *   session-keyed `useSessionPhase` that resolves card-bound sessions to
 *   their card's `codeSessionStore` and everything else to the idle dot.
 * - **The atom's ink is text color.** The theme's session color leaves the
 *   atom face: the run and the border paint from the ordinary text ink, and
 *   the DOT is the pill's only color channel — a colored pill around a
 *   colored dot was two tints saying one thing. Right-click on any atom
 *   offers Copy, exactly as the shipped chip already does.
 * - **The missing atom loses its slash.** With the icon gone, the
 *   unresolvable citation states its failure by shape alone: dashed border,
 *   muted ink, the still idle dot, inert. Same tooltip sentence as before.
 *
 * Retired by this round, recorded so they are not re-proposed: the chatbox
 * session icon (`MessageSquareText`) as the session mark; the three-level
 * description + intent + activity stack; the `PULSE` legend/stand-in as
 * user-facing ink; the four-line row (its metadata line folds into the
 * activity grammar); the masthead width control; red for anything but
 * errors; the session-colored pill paint (the dot is the atom's only color
 * now); the tape on picker rows (the picker reads at rest — the masthead
 * and the Lens keep theirs). Still standing from earlier rounds: no
 * per-session hashed tint; no monospace in session chrome; the citation
 * `<tag> (<shortid>)` as the only flat-text form; the fork-lineage grammar;
 * the three clipboard flavors (`text/html` stays struck).
 *
 * **What is real here and what is a drawing.** The shipped-component frame mounts
 * the real `TugSessionIdentity` at every state it renders — the line tier, both
 * chip sizes, a named chip, a narrow named chip, and the missing chip — and it is
 * load-bearing beyond illustration: `at0374` and `at0376` drive exactly those
 * mounts, so a claim proved there is a claim about what ships. The dot and the
 * tape are the real `TugProgressIndicator` and `TugSparkline` throughout. The
 * masthead mock and the `.gsi-*` title/atom prototypes remain as DRAWINGS of the
 * settled decisions, kept because a design surface that showed only the shipped
 * component could no longer show why it looks the way it does — and they are the
 * reference: where the component disagrees with a drawing, the component is the
 * bug.
 * Nothing in `gallery-session-identity.css` is a rule the app inherits.
 *
 * The masthead mock's title row draws dot + title + wave + close. That frame is
 * INCOMPLETE about the pane, and it taught the rollout plan the wrong control
 * inventory: the pane's own controls cluster sits beside the masthead and holds,
 * in order, the slot-stack badge, the `…` section menu, and the close X. Only the
 * width control left. See the caption on that section.
 *
 * @module components/tugways/cards/gallery-session-identity
 */

import "./spike.css";
import type { SpikeDef } from "./spike-registry";
import "./spike-session-identity.css";

import React from "react";
import { Waves, X } from "lucide-react";

import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { useCopyableButton } from "@/components/tugways/use-copyable-text";
import { TugSeparator } from "@/components/tugways/tug-separator";
import { TugSessionIdentity } from "@/components/tugways/tug-session-identity";
import {
  TUG_SESSION_ROW_INDICATOR_SIZE,
  TUG_SESSION_ROW_SPARK_HEIGHT,
  TUG_SESSION_ROW_SPARK_WIDTH,
  TUG_SESSION_SPARK_CURVE,
  TUG_SESSION_SPARK_FULL_SCALE_CHARS,
} from "@/components/tugways/tug-session-row";
import { TugSparkline } from "@/components/tugways/tug-sparkline";
import { ACTIVITY_BIN_MS } from "@/lib/session-activity-store";
import { sessionSessionPhaseVisual } from "@/lib/code-session-store/session-phase-visual";
import {
  composeSessionIdentity,
  type SessionIdentity,
} from "@/lib/session-identity";

// ---------------------------------------------------------------------------
// Fixtures — the roster every section draws from
// ---------------------------------------------------------------------------

interface IdentityFixture {
  /** The callsign, including any lineage suffix. */
  tag: string;
  project: string;
  branch: string | null;
  /** The user's own name for the session — `/rename`. Null when never named. */
  userName: string | null;
  /** The SharedAgent's description. Null before the first summary exists. */
  description: string | null;
  shortId: string;
  /** Phase key for the dot (`session-phase-visual` vocabulary). */
  phase: string;
  /** The live activity beat, for fixtures caught mid-turn. */
  beat: string | null;
  turns: number;
  /** Session size on disk, already humanized. */
  size: string;
  createdAt: string;
  /** Last-updated stamp; null only while `turns` is zero. */
  lastUsed: string | null;
  /** One-phrase situation label for frame captions. */
  note: string;
}

const ROSTER: readonly IdentityFixture[] = [
  {
    tag: "stocky-pixie",
    project: "tugtool",
    branch: null,
    userName: null,
    description: null,
    shortId: "7c21d3aa",
    phase: "idle",
    beat: null,
    turns: 0,
    size: "8 KB",
    createdAt: "Aug 9, 9:41 AM",
    lastUsed: null,
    note: "fresh — no turns, no description yet",
  },
  {
    tag: "syrupy-beam",
    project: "tugtool",
    branch: null,
    userName: null,
    description: "Explaining commitImposition in the deck manager",
    shortId: "f6e43925",
    phase: "streaming",
    beat: "Edit pane-flip.ts",
    turns: 2,
    size: "885 KB",
    createdAt: "Aug 9, 8:12 AM",
    lastUsed: "Aug 9, 9:37 AM",
    note: "un-renamed, mid-turn",
  },
  {
    tag: "bendy-sweet",
    project: "tugtool",
    branch: "content-width",
    userName: "card resize animation",
    description: "Animating card resize in Lens layouts",
    shortId: "ab7579ac",
    phase: "tool_work",
    beat: "Bash just app-test-changed",
    turns: 11,
    size: "4.7 MB",
    createdAt: "Aug 8, 7:02 AM",
    lastUsed: "Aug 9, 10:44 AM",
    note: "custom-named, mid-turn",
  },
  {
    tag: "juicy-silt",
    project: "tugtool",
    branch: null,
    userName: "message dates",
    description: "Making message dates context-aware relative to today",
    shortId: "26b43a66",
    phase: "idle",
    beat: null,
    turns: 7,
    size: "2.1 MB",
    createdAt: "Aug 8, 3:20 PM",
    lastUsed: "Aug 9, 11:02 AM",
    note: "custom-named, at rest",
  },
  {
    tag: "brisk-otter",
    project: "tugdash",
    branch: null,
    userName: null,
    description: "Wiring the dash join resolver",
    shortId: "9e02c1b4",
    phase: "idle",
    beat: null,
    turns: 19,
    size: "8.9 MB",
    createdAt: "Aug 5, 9:15 AM",
    lastUsed: "Aug 7, 4:48 PM",
    note: "external — live data unreachable, so the idle dot",
  },
  {
    tag: "stocky-pixie-A1",
    project: "tugtool",
    branch: null,
    userName: null,
    description: "Tracing the slot-picker's keyboard route",
    shortId: "d41c77e0",
    phase: "streaming",
    beat: "Read tug-slot-picker.tsx",
    turns: 1,
    size: "214 KB",
    createdAt: "Aug 9, 11:20 AM",
    lastUsed: "Aug 9, 11:21 AM",
    note: "fork of stocky-pixie, mid-turn",
  },
  {
    tag: "dented-prism",
    project: "tugtool",
    branch: null,
    userName: null,
    description: "Rebuilding the tokenizer wasm embed",
    shortId: "41be09c7",
    phase: "errored",
    beat: null,
    turns: 5,
    size: "1.4 MB",
    createdAt: "Aug 9, 6:58 AM",
    lastUsed: "Aug 9, 7:31 AM",
    note: "errored — the one red on this card",
  },
] as const;

/** The lineage family, for the fork-grammar section. */
const LINEAGE: readonly string[] = [
  "stocky-pixie",
  "stocky-pixie-A1",
  "stocky-pixie-A2",
  "stocky-pixie-B1",
  "stocky-pixie-A1-B2",
];

/** The citation, exactly as the brief's flat-text grammar writes it. */
function citation(f: IdentityFixture): string {
  return `${f.tag} (${f.shortId})`;
}

/** Phases during which a turn is in flight and the tape animates. */
const RUNNING_PHASES: ReadonlySet<string> = new Set([
  "submitting",
  "awaiting_first_token",
  "streaming",
  "tool_work",
  "waking",
]);

function isRunning(f: IdentityFixture): boolean {
  return RUNNING_PHASES.has(f.phase);
}

/**
 * The activity line at rest — the grammar, in one place:
 * `<turns> turns, <size>. Last updated: <last-updated>. Ready.` The labeled
 * stamp appears only for a session with turns to have been updated by; a
 * fresh session's line is `No turns, 8 KB. Ready.` and nothing more — the
 * zero is spelled as prose, never as a digit.
 */
function restLine(f: IdentityFixture): string {
  const count =
    f.turns === 0
      ? "No turns"
      : `${f.turns} ${f.turns === 1 ? "turn" : "turns"}`;
  const turns = `${count}, ${f.size}.`;
  const stamp =
    f.turns > 0 && f.lastUsed !== null ? ` Last updated: ${f.lastUsed}.` : "";
  return `${turns}${stamp} Ready.`;
}

/** What the activity line says right now: the beat mid-turn, the rest line
 *  otherwise. */
function activityLine(f: IdentityFixture): string {
  return isRunning(f) && f.beat !== null ? f.beat : restLine(f);
}

/** What the description line says: the description, else the birth stamp —
 *  never blank, never a placeholder word. */
function descriptionLine(f: IdentityFixture): string {
  return f.description ?? `Created ${f.createdAt}`;
}

// ---------------------------------------------------------------------------
// The dot — the one session mark
// ---------------------------------------------------------------------------

/** The masthead's and the picker's dot box. Ring box, not glyph box: the dot
 *  paints at 60% of it and the ring overhangs into the line's padding. */
const SMALL_DOT_SIZE = 16;

/** The atom's dot box, per chip size. */
const ATOM_DOT_SIZE = { sm: 12, "2xs": 10 } as const;

function Dot({
  phase,
  size,
}: {
  phase: string;
  size: number;
}): React.ReactElement {
  return (
    <TugProgressIndicator
      variant="pulsing-dot"
      size={size}
      phase={phase}
      phaseVisual={sessionSessionPhaseVisual}
      aria-hidden
    />
  );
}

// ---------------------------------------------------------------------------
// The title grammar — the user's name leads
// ---------------------------------------------------------------------------

/** The Line run a fixture's callsign wears: `<project>/<callsign>`. */
function line(f: IdentityFixture): string {
  return `${f.project}/${f.tag}`;
}

/**
 * The title run: `<custom-name> : <project>/<callsign>` when the user has
 * named the session, bare `<project>/<callsign>` when not. The custom name
 * carries the title weight — it is the user's explicit word on what this
 * session is called — and the project-prefixed callsign steps back to a
 * quieter regular-weight run beside it, still present because it is the
 * session's permanent, citable handle and the project is how a reader places
 * it among sessions from many projects.
 */
function TitleRun({ f }: { f: IdentityFixture }): React.ReactElement {
  if (f.userName === null) {
    return (
      <span className="gsi-title">
        <span className="gsi-title-name">{line(f)}</span>
      </span>
    );
  }
  return (
    <span className="gsi-title">
      <span className="gsi-title-name">{f.userName}</span>
      <span className="gsi-title-callsign">{` : ${line(f)}`}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// The live tape — a synthetic series so the audition ANIMATES
// ---------------------------------------------------------------------------

/** Deterministic pseudo-noise per bin: bursty above a floor of murmur. */
function synthRate(bin: number, seed: number): number {
  const raw = Math.sin((bin + seed) * 12.9898) * 43758.5453;
  const r = raw - Math.floor(raw);
  return r > 0.6 ? r * TUG_SESSION_SPARK_FULL_SCALE_CHARS : r * 60;
}

/** How many bins the fixture series carries — comfortably past the window. */
const SYNTH_BINS = 40;

/**
 * The real `TugSparkline` on a synthetic series, so the masthead frames show
 * the actual instrument scrolling smoothly rather than a still picture of
 * one. An inactive tape gets an empty series and no wake — which is exactly
 * how the real instrument sits on a quiet session.
 */
function FixtureTape({
  seed,
  active,
  width,
  height,
}: {
  seed: number;
  active: boolean;
  width: number;
  height: number;
}): React.ReactElement {
  const getSeries = React.useCallback(
    (nowMs: number): number[] => {
      if (!active) return [];
      const current = Math.floor(nowMs / ACTIVITY_BIN_MS);
      const out: number[] = [];
      for (let i = SYNTH_BINS - 1; i >= 0; i -= 1) {
        out.push(synthRate(current - i, seed));
      }
      return out;
    },
    [seed, active],
  );
  const subscribeActivity = React.useCallback(
    (wake: () => void): (() => void) => {
      if (!active) return () => {};
      const timer = window.setInterval(wake, 400);
      return () => window.clearInterval(timer);
    },
    [active],
  );
  return (
    <TugSparkline
      getSeries={getSeries}
      subscribeActivity={subscribeActivity}
      binMs={ACTIVITY_BIN_MS}
      fullScale={TUG_SESSION_SPARK_FULL_SCALE_CHARS}
      curve={TUG_SESSION_SPARK_CURVE}
      width={width}
      height={height}
      title="Session activity (fixture series)"
    />
  );
}

// ---------------------------------------------------------------------------
// PROTOTYPE: the masthead — three rows, two naming states
// ---------------------------------------------------------------------------

/** The masthead tape's cut of the instrument — the ROW's, exactly. The two
 *  surfaces draw the same window of the same series, and a tape is read at a
 *  glance; a wider cut on the masthead bought resolution nobody was reading
 *  and spent it out of the description's measure. Mirrored in the stylesheet
 *  as `--gsi-masthead-tape-width`, which is what the description reserves. */
const MASTHEAD_TAPE_WIDTH = TUG_SESSION_ROW_SPARK_WIDTH;
const MASTHEAD_TAPE_HEIGHT = TUG_SESSION_ROW_SPARK_HEIGHT;

function ProtoMasthead({
  f,
  seed,
}: {
  f: IdentityFixture;
  seed: number;
}): React.ReactElement {
  return (
    <div className="gsi-masthead">
      <div className="gsi-masthead-lead">
        <span className="gsi-masthead-dot">
          <Dot phase={f.phase} size={SMALL_DOT_SIZE} />
        </span>
        <TitleRun f={f} />
        <span className="gsi-spacer" />
        <span className="gsi-masthead-widget" title="Telemetry">
          <Waves size={14} aria-hidden />
        </span>
        <span className="gsi-masthead-widget" title="Close">
          <X size={14} aria-hidden />
        </span>
      </div>
      <div
        className="gsi-masthead-description"
        data-stamp={f.description === null ? "true" : undefined}
      >
        {descriptionLine(f)}
      </div>
      <div className="gsi-masthead-activity">
        <span className="gsi-activity-run">{activityLine(f)}</span>
        {/* Lifted so the tape reads visually centered on rows two and three
            together, not seated on row three alone. */}
        <span className="gsi-masthead-tape">
          <FixtureTape
            seed={seed}
            active={isRunning(f)}
            width={MASTHEAD_TAPE_WIDTH}
            height={MASTHEAD_TAPE_HEIGHT}
          />
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PROTOTYPE: the row — the masthead model on a list ground
// ---------------------------------------------------------------------------

/**
 * One session as a row: the same three lines the masthead wears, with the
 * dot size exchanged — the Lens keeps its across-the-room
 * {@link TUG_SESSION_ROW_INDICATOR_SIZE}; the picker reads up close and
 * takes the masthead's {@link SMALL_DOT_SIZE}. The old fourth line is gone:
 * its facts (time, turns, size) live in the activity grammar now. The
 * picker's rows carry no tape — a picker is read at rest, choosing, and the
 * dot already says which rows are working.
 */
function ProtoRow({
  f,
  seed,
  dot,
}: {
  f: IdentityFixture;
  seed: number;
  dot: "lens" | "picker";
}): React.ReactElement {
  const dotSize =
    dot === "lens" ? TUG_SESSION_ROW_INDICATOR_SIZE : SMALL_DOT_SIZE;
  return (
    <div className="gsi-prow" data-dot={dot}>
      <div className="gsi-prow-lead">
        <span className="gsi-prow-dot">
          <Dot phase={f.phase} size={dotSize} />
        </span>
        <TitleRun f={f} />
      </div>
      <div className="gsi-prow-description">{descriptionLine(f)}</div>
      <div className="gsi-prow-activity">
        <span className="gsi-activity-run">{activityLine(f)}</span>
        {dot === "lens" ? (
          <FixtureTape
            seed={seed}
            active={isRunning(f)}
            width={64}
            height={16}
          />
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PROTOTYPE: the atom — a live pill, dot-led
// ---------------------------------------------------------------------------

/**
 * The proposed atom face: `[dot] <project>/<callsign>`, or
 * `[dot] <custom-name> : <project>/<callsign>` once the user names the session. The
 * rounded pill shape survives from the shipped chip; the session color does
 * not — the run and the border paint in ordinary text ink, and the LIVE dot
 * is the pill's only color channel. A missing (unresolvable) atom forces
 * the idle dot, mutes the ink, and dashes its border — shape states the
 * failure now that there is no icon to slash.
 *
 * Right-click offers Copy — here the flat citation; the rollout writes the
 * atom's full flavor set exactly as the shipped chip already does.
 */
function ProtoAtom({
  f,
  size = "sm",
  missing = false,
}: {
  f: IdentityFixture;
  size?: "sm" | "2xs";
  missing?: boolean;
}): React.ReactElement {
  const copy = useCopyableButton(`${f.project}/${citation(f)}`);
  return (
    <span
      ref={copy.ref as React.Ref<HTMLSpanElement>}
      onContextMenu={copy.onContextMenu}
      className="gsi-atom"
      data-size={size}
      data-missing={missing ? "true" : undefined}
      title={missing ? "Session not found" : citation(f)}
    >
      <span className="gsi-atom-dot">
        <Dot phase={missing ? "idle" : f.phase} size={ATOM_DOT_SIZE[size]} />
      </span>
      <span className="gsi-atom-run">
        {f.userName === null ? (
          <span className="gsi-atom-name">{line(f)}</span>
        ) : (
          <>
            <span className="gsi-atom-name">{f.userName}</span>
            <span className="gsi-atom-callsign">{` : ${line(f)}`}</span>
          </>
        )}
      </span>
      {copy.contextMenu}
    </span>
  );
}

/** A fixture identity for the one shipped-component contrast frame. */
function fixtureIdentity(f: IdentityFixture): SessionIdentity {
  return composeSessionIdentity({
    sessionId: `${f.shortId}-0000-4000-8000-000000000000`.padEnd(36, "0"),
    name: f.userName,
    synopsis: f.description,
    tag: f.tag,
    projectDir: `/Users/tester/src/${f.project}`,
  });
}

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

function Section({
  title,
  blurb,
  children,
}: {
  title: string;
  blurb?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="gsi-section">
      <h3 className="gsi-section-title">{title}</h3>
      {blurb !== undefined ? <p className="gsi-blurb">{blurb}</p> : null}
      {children}
    </section>
  );
}

function Frame({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="gsi-frame">
      <span className="gsi-frame-label">{label}</span>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

const FRESH = ROSTER[0];
const LIVE = ROSTER[1];
const NAMED_LIVE = ROSTER[2];
const NAMED_REST = ROSTER[3];
const EXTERNAL = ROSTER[4];
const FORK = ROSTER[5];
const ERRORED = ROSTER[6];

/** The dot vocabulary strip: every reading the mark can give, in one place. */
const DOT_VOCABULARY: readonly {
  phase: string;
  label: string;
  meaning: string;
}[] = [
  {
    phase: "idle",
    label: "Idle",
    meaning: "quiet — and also unknown, closed, or unreachable",
  },
  { phase: "streaming", label: "Working", meaning: "a turn is in flight" },
  {
    phase: "awaiting_approval",
    label: "Awaiting",
    meaning: "parked on the user's answer",
  },
  {
    phase: "background",
    label: "Active",
    meaning: "no turn, but agents still working",
  },
  {
    phase: "errored",
    label: "Error",
    meaning: "genuine failure — the only red",
  },
];

export function SpikeSessionIdentity(): React.ReactElement {
  return (
    <div className="gsi-root" data-testid="gallery-session-identity">
      <p className="gsi-blurb">
        A session is referred to five ways — UUID, 8-char short id, minted{" "}
        <code>adjective-noun</code> callsign, agent-written description, and
        an optional user name — across five surfaces: the card masthead, the
        picker, the Lens rows, the atom, and the flat-text citation. This
        round decides the <strong>content</strong>: the pulsing dot replaces
        the session icon everywhere, the user&apos;s name leads the title,
        the stack under the title is two levels (description, then
        activity), and the word PULSE never prints again.
      </p>

      <TugSeparator />

      {/* ================================================================ */}
      <Section
        title="The dot is the mark"
        blurb={
          <>
            The chatbox icon retires. Every surface that names a session
            leads with the pulsing phase dot — a mark that says what the
            session is <em>doing</em>, not just what kind of thing it is.
            Two rules govern it. <strong>White means idle, and idle is the
            default:</strong> a quiet session, a closed one, an external
            one, any session whose live data cannot be reached — all wear
            the still idle dot. <strong>Red means errors:</strong> an
            errored turn, a dead wire under a live card. Red never says
            &quot;idle&quot;, and doubt never says red.
          </>
        }
      >
        <Frame label="the vocabulary — every reading, at the Lens size and the masthead size">
          <div className="gsi-dot-table">
            {DOT_VOCABULARY.map((entry) => (
              <div className="gsi-dot-row" key={entry.phase}>
                <span className="gsi-dot-cell">
                  <Dot
                    phase={entry.phase}
                    size={TUG_SESSION_ROW_INDICATOR_SIZE}
                  />
                </span>
                <span className="gsi-dot-cell">
                  <Dot phase={entry.phase} size={SMALL_DOT_SIZE} />
                </span>
                <span className="gsi-dot-label">{entry.label}</span>
                <span className="gsi-dot-meaning">{entry.meaning}</span>
              </div>
            ))}
          </div>
        </Frame>
        <p className="gsi-blurb">
          The mapping is the shipped one (<code>session-phase-visual</code>):
          idle draws the quiet inherit rung at half the box, work pulses in
          the key tone, awaiting pulses caution, background breathes, danger
          is red. What changes is the <em>reach</em> — the dot becomes the
          session mark on every surface, including ones with no live card,
          which is where the doubt rule does its work.
        </p>
      </Section>

      <TugSeparator />

      {/* ================================================================ */}
      <Section
        title="The title grammar — the user's name leads"
        blurb={
          <>
            When a user names a session they are explicitly telling us what
            it is called, and that name cannot sit below a callsign we
            minted. The grammar:{" "}
            <code>{"<custom-name> : <project>/<callsign>"}</code> when named,
            bare <code>{"<project>/<callsign>"}</code> when not. The custom
            name takes the title weight; the project-prefixed callsign steps
            back to a quieter run — still present, because it is the
            permanent citable handle a rename never changes, and the project
            is how a reader places the session among sessions from many
            projects. This obliges the resolver to stop conflating:{" "}
            <code>SessionIdentity.title</code> (the{" "}
            <code>name ?? synopsis</code> merge) splits into{" "}
            <code>customName</code> and <code>description</code>.
          </>
        }
      >
        <div className="gsi-candidate-grid">
          <Frame label="un-named — the callsign is the title">
            <div className="gsi-title-sample">
              <Dot phase={LIVE.phase} size={SMALL_DOT_SIZE} />
              <TitleRun f={LIVE} />
            </div>
          </Frame>
          <Frame label="custom-named — the user's word leads, the callsign steps back">
            <div className="gsi-title-sample">
              <Dot phase={NAMED_REST.phase} size={SMALL_DOT_SIZE} />
              <TitleRun f={NAMED_REST} />
            </div>
          </Frame>
          <Frame label="a longer pair, under a narrow budget — the name truncates, the callsign survives">
            <div className="gsi-title-sample gsi-title-narrow">
              <Dot phase={NAMED_LIVE.phase} size={SMALL_DOT_SIZE} />
              <TitleRun f={NAMED_LIVE} />
            </div>
          </Frame>
        </div>
      </Section>

      <TugSeparator />

      {/* ================================================================ */}
      <Section
        title="The masthead — three rows, two naming states"
        blurb={
          <>
            Row one: the dot, the title, the telemetry wave. Row two: the
            description, or the session&apos;s own first prompt, or the creation
            stamp — so the line is never blank. Row three: the activity line
            and the tape, lifted to sit visually centered on rows two and three
            together. At rest the activity reads{" "}
            <code>
              {"<turns> turns, <size>. Last updated: <stamp>. Ready."}
            </code>
            ; mid-turn it carries the live beat and the tape animates.
            Right-clicking the title copies the session <em>atom</em> — all
            flavors.
            <br />
            <br />
            <strong>The frame below is incomplete about the pane, and it
            misled the rollout plan.</strong> The <em>width control</em> is the
            only thing that left the title row. The pane&apos;s own controls
            cluster sits beside the masthead — outside it — and still holds the
            slot-stack badge (whenever the pane stands in a stack of more than
            one), the <code>…</code> section menu, and the close X. The badge in
            particular describes the <em>slot</em> rather than the card, and it
            is the only way into the panes behind this one.
          </>
        }
      >
        <Frame label={`fresh session — no turns: the creation stamp holds the description line (${FRESH.note})`}>
          <div className="gsi-pane-mock">
            <ProtoMasthead f={FRESH} seed={11} />
          </div>
        </Frame>
        <Frame label={`resumed, un-named, at rest (${EXTERNAL.note})`}>
          <div className="gsi-pane-mock">
            <ProtoMasthead f={EXTERNAL} seed={23} />
          </div>
        </Frame>
        <Frame label={`custom-named, at rest (${NAMED_REST.note})`}>
          <div className="gsi-pane-mock">
            <ProtoMasthead f={NAMED_REST} seed={31} />
          </div>
        </Frame>
        <Frame label={`custom-named, mid-turn — live beat, animated tape (${NAMED_LIVE.note})`}>
          <div className="gsi-pane-mock">
            <ProtoMasthead f={NAMED_LIVE} seed={47} />
          </div>
        </Frame>
        <Frame label={`errored (${ERRORED.note})`}>
          <div className="gsi-pane-mock">
            <ProtoMasthead f={ERRORED} seed={53} />
          </div>
        </Frame>
        <p className="gsi-blurb">
          One delta from the earlier masthead, deliberate: the
          standing-intent line is cut — the stack is two levels under the
          title, description then activity, because the description already
          says what the session is for and two goal-shaped lines read as an
          echo. The intent survives in the activity history popover, heading
          its run of beats. Mid-turn the description stays the description —
          it updates when the agent rewrites it, on its own clock — and the
          activity line alone carries the turn&apos;s live beat. The{" "}
          <code>project/</code> prefix stays in the title ink — a revision
          briefly dropped it, and it came back: even inside the
          project&apos;s own card, the prefix is how a glance across many
          cards says which project each session works against.
        </p>
      </Section>

      <TugSeparator />

      {/* ================================================================ */}
      <Section
        title="The rows — the Lens and the picker wear the masthead model"
        blurb={
          <>
            One stack, three mounts. The Lens exchanges the small dot for
            its across-the-room 28px indicator; the picker keeps the
            masthead&apos;s 16 and carries <strong>no tape</strong> — a
            picker is read at rest, choosing, and the dot already says
            which rows are working. The old fourth line is gone — its facts
            (time, turns, size) are the activity grammar&apos;s rest form
            now, so a row at rest carries them and a row mid-turn shows the
            beat instead, exactly like the masthead.
          </>
        }
      >
        <Frame label="the Lens Sessions section — large dot, same three lines">
          <div className="gsi-list">
            {[LIVE, NAMED_REST, EXTERNAL, ERRORED].map((f, i) => (
              <ProtoRow key={f.tag} f={f} seed={60 + i} dot="lens" />
            ))}
          </div>
        </Frame>
        <Frame label="the new-session picker — small dot, same three lines">
          <div className="gsi-list">
            {[FRESH, LIVE, NAMED_LIVE, NAMED_REST, FORK].map((f, i) => (
              <ProtoRow key={f.tag} f={f} seed={70 + i} dot="picker" />
            ))}
          </div>
        </Frame>
      </Section>

      <TugSeparator />

      {/* ================================================================ */}
      <Section
        title="The atom — a live pill"
        blurb={
          <>
            The atom face becomes <code>{"[dot] <project>/<callsign>"}</code>{" "}
            — or <code>{"[dot] <custom-name> : <project>/<callsign>"}</code>{" "}
            once the user names the session. Both parts are <strong>live</strong>: the dot
            reads the session&apos;s phase this second, and a rename
            repaints every mounted atom. So the atom is a component with
            subscriptions, never a static string or a baked image — pasted
            atoms, Overview refs, and History chips all stay current for as
            long as they are on screen. The ink is <strong>text color</strong>:
            the theme&apos;s session tint leaves the pill, and the dot is
            its only color channel. Right-click any atom for Copy.
          </>
        }
      >
        <p className="gsi-blurb">The atom across the roster, phases live:</p>
        <div className="gsi-chip-row">
          {ROSTER.map((f) => (
            <ProtoAtom key={f.tag} f={f} />
          ))}
        </div>
        <div className="gsi-candidate-grid">
          {/* The shipped component at every state it renders. This frame is
              load-bearing: the gallery is the fixture bench the identity
              app-tests (at0374, at0376) drive, so the line tier, both chip
              sizes, the named chip, the narrow named chip, and the missing
              chip must all stay mounted here. */}
          <Frame label="the shipped TugSessionIdentity — line, chip, 2xs, named, narrow, missing">
            <div className="gsi-chip-row">
              <TugSessionIdentity identity={fixtureIdentity(LIVE)} tier="line" />
              <TugSessionIdentity identity={fixtureIdentity(LIVE)} tier="chip" />
              <TugSessionIdentity
                identity={fixtureIdentity(LIVE)}
                tier="chip"
                size="2xs"
              />
              <TugSessionIdentity
                identity={fixtureIdentity(NAMED_LIVE)}
                tier="chip"
                data-gsi-shipped="named"
              />
              {/* The truncation rule, on the real component: the name survives
                  and the callsign gives way. Only a live browser can show it. */}
              <span className="gsi-chip-narrow" data-gsi-shipped="narrow">
                <TugSessionIdentity
                  identity={fixtureIdentity(NAMED_LIVE)}
                  tier="chip"
                />
              </span>
              <TugSessionIdentity
                identity={fixtureIdentity(EXTERNAL)}
                tier="chip"
                missing
              />
            </div>
          </Frame>
          <Frame label="proposed — dot-led, name-first">
            <ProtoAtom f={LIVE} />
          </Frame>
          <Frame label="missing — dashed shape, idle dot, inert (the slash retired with the icon)">
            <ProtoAtom f={EXTERNAL} missing />
          </Frame>
          <Frame label="dense list ink — the 2xs cut">
            <div className="gsi-chip-row">
              <ProtoAtom f={LIVE} size="2xs" />
              <ProtoAtom f={NAMED_REST} size="2xs" />
            </div>
          </Frame>
          <Frame label="a named atom under a narrow budget — the user's name survives, the callsign gives way">
            <span className="gsi-chip-narrow">
              <ProtoAtom f={NAMED_LIVE} />
            </span>
          </Frame>
        </div>
        <p className="gsi-blurb">
          <strong>How the liveness works.</strong> Identity is already live:
          the atom subscribes through <code>useSessionIdentity</code>, so a
          rename or a callsign reroll repaints it with no new machinery.
          Phase needs one new door: <code>useSessionPhase(sessionId)</code>,
          a session-keyed hook that resolves the dot&apos;s reading in
          precedence order — a card bound to the session answers from that
          card&apos;s <code>codeSessionStore</code> (via{" "}
          <code>cardSessionBindingStore</code> →{" "}
          <code>cardServicesStore</code>); no bound card answers idle,
          which the doubt rule makes correct rather than approximate. The
          hook&apos;s snapshot is the flattened phase <em>key</em>, so the
          per-card store&apos;s transcript-event churn wakes the
          subscription but re-renders the atom only when the key actually
          changes — the same discipline that keeps [P15]&apos;s identity
          path quiet. All of it enters React through{" "}
          <code>useSyncExternalStore</code> ([L02]), and the identity record
          itself still carries no phase field — liveness and identity remain
          two subscriptions with two keys that meet in the component.
        </p>
      </Section>

      <TugSeparator />

      {/* ================================================================ */}
      <Section
        title="The telemetry popover — where the atom shows itself"
        blurb={
          <>
            The wave widget&apos;s popover keeps its facts and gains the
            atom: the rendered pill, live, right above the flat citation —
            so the two copyable forms of the session sit together, each
            labeled by what a paste of it yields.
          </>
        }
      >
        <Frame label="the popover, updated — atom above citation; no PULSE ink anywhere in it">
          <div className="gsi-placard">
            <div className="gsi-placard-row">
              <span className="gsi-placard-key">STATE</span>
              <span className="gsi-placard-value">live · working</span>
            </div>
            <div className="gsi-placard-row">
              <span className="gsi-placard-key">TURNS</span>
              <span className="gsi-placard-value">
                {NAMED_LIVE.turns} · {NAMED_LIVE.size}
              </span>
            </div>
            <div className="gsi-placard-row">
              <span className="gsi-placard-key">CREATED</span>
              <span className="gsi-placard-value">{NAMED_LIVE.createdAt}</span>
            </div>
            <div className="gsi-placard-row">
              <span className="gsi-placard-key">BRANCH</span>
              <span className="gsi-placard-value">{NAMED_LIVE.branch}</span>
            </div>
            <div className="gsi-placard-row">
              <span className="gsi-placard-key">ATOM</span>
              <span className="gsi-placard-value">
                <ProtoAtom f={NAMED_LIVE} size="2xs" />
              </span>
            </div>
            <div className="gsi-placard-row">
              <span className="gsi-placard-key">CITATION</span>
              <span className="gsi-placard-value gsi-placard-citation">
                {citation(NAMED_LIVE)}
              </span>
            </div>
          </div>
        </Frame>
        <p className="gsi-blurb">
          Copy paths, after this round: click the atom row&apos;s pill or
          the citation&apos;s copy badge here; or right-click the
          masthead&apos;s title anywhere, which writes the atom&apos;s full
          flavor set without opening anything.
        </p>
      </Section>

      <TugSeparator />

      {/* ================================================================ */}
      <Section
        title="The citation — flat text, and the History card"
        blurb={
          <>
            Unchanged in grammar: <code>{"<tag> (<short-id>)"}</code> is the
            only flat-text form, mono belongs to it alone, and the commit
            carries the human trailer plus the machine{" "}
            <code>Tug-Session-Id</code>. What changes is the chip the
            History card resolves it into — the dot-led atom, live like
            every other mount.
          </>
        }
      >
        <Frame label="the trailer pair — citation + machine id">
          <pre className="gsi-trailer">
            {`Tug-Session: ${citation(LIVE)}\nTug-Session-Id: 4ad2f45e-f9af-46d6-ad4e-97f577156be1`}
          </pre>
        </Frame>
        <Frame label="History identity line — the atom beside the sha">
          <div className="gsi-history-line">
            <code className="gsi-history-sha">8ab71840</code>
            <span className="gsi-history-subject">
              tugdeck(content-width-scale): scale panes on the FLIP tween
            </span>
            <ProtoAtom f={LIVE} size="2xs" />
          </div>
        </Frame>
        <Frame label="History identity line — session unknown to this ledger: dashed, idle-dotted, inert">
          <div className="gsi-history-line">
            <code className="gsi-history-sha">b8b7f0c1</code>
            <span className="gsi-history-subject">
              tugdeck(content-width): let Settings follow content width
            </span>
            <ProtoAtom f={EXTERNAL} size="2xs" missing />
          </div>
        </Frame>
      </Section>

      <TugSeparator />

      {/* ================================================================ */}
      <Section
        title="The atom on the clipboard — unchanged flavors, live face"
        blurb={
          <>
            Copying an atom still writes the flavors Tug already speaks —
            the private sidecar, the plain-text citation, and the wire
            marker at submit; <code>text/html</code> stays struck. The
            change is on the paste side: what re-materializes in a Tug
            surface is the live dot-led component, so a pasted atom&apos;s
            dot starts reporting the session&apos;s phase the moment it
            lands.
          </>
        }
      >
        <div className="gsi-flavors">
          {(
            [
              [
                "dev.tug.prompt-atoms",
                "the Tug-private sidecar (one session segment; whether it should also carry the short id is open)",
                `{"version":1,"text":"￼","atoms":[{"position":0,"segment":{"kind":"atom","type":"session","label":"${LIVE.project}/${LIVE.tag}","value":"${LIVE.project}/${LIVE.tag}"}}]}`,
                "Paste into a Tug composer, a Jot, a Overview reply → the live atom re-materializes.",
              ],
              [
                "text/plain",
                "the citation — the flat-text form",
                `${LIVE.project}/${LIVE.tag} (${LIVE.shortId})`,
                "Paste into a terminal, a commit message, another app → the citation, exactly the trailer grammar.",
              ],
              [
                "wire marker",
                "what the model reads, and what replay re-mints",
                `\`@${LIVE.project}/${LIVE.tag}\``,
                "Submitted prompt text keeps the mention's structural identity, so a replayed transcript shows the atom and not prose.",
              ],
            ] as const
          ).map(([flavor, role, payload, effect]) => (
            <div className="gsi-flavor" key={flavor}>
              <span className="gsi-flavor-name">{flavor}</span>
              <span className="gsi-flavor-role">{role}</span>
              <code className="gsi-flavor-payload">{payload}</code>
              <span className="gsi-flavor-effect">{effect}</span>
            </div>
          ))}
        </div>
        <Frame label="the round trip — copied from a History line, pasted into a composer">
          <div className="gsi-roundtrip">
            <ProtoAtom f={LIVE} />
            <span className="gsi-roundtrip-arrow" aria-hidden="true">
              →
            </span>
            <span className="gsi-roundtrip-composer">
              Pick up where <ProtoAtom f={LIVE} /> left off
            </span>
          </div>
        </Frame>
      </Section>

      <TugSeparator />

      {/* ================================================================ */}
      <Section
        title="Lineage — the fork grammar at atom size"
        blurb={
          <>
            <code>{"<root>-<Letter><Number>"}</code>: the letter names the
            branch point, the number sequences forks from it, chains extend.
            Unchanged by this round except for the face it rides on.
          </>
        }
      >
        <div className="gsi-chip-row">
          {LINEAGE.map((tag) => (
            <ProtoAtom key={tag} f={{ ...FRESH, tag }} />
          ))}
        </div>
      </Section>
    </div>
  );
}

export const spike: SpikeDef = {
  name: "session-identity",
  title: "Session Identity",
  blurb: "The shipped session-reference vocabulary: the two registers, the atom, the citation, the fork grammar. Driven by the identity app-tests.",
  component: () => <SpikeSessionIdentity />,
};
