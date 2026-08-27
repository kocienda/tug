/**
 * spike-dash-lifecycle.tsx — can one atom, one track, and one line carry a
 * dash through its whole life, on every surface, without any surface growing?
 *
 * The answer is components, and this card is only fixture data and the frames
 * that hold them:
 *
 *   - `TugDashAtom` — the one skin, two sizes. A poke is a dash to it.
 *   - `TugDashTrack` — brief · devise · review · implement (ticks) · join, in
 *     a cap-height strip of CONSTANT width, whose current cell breathes;
 *     `dashTrackModelFromEntry` derives it from the wire.
 *   - `DashPhaseMark` — the same five phases as one glyph, keyed on the
 *     lifecycle phase rather than on the git stage.
 *   - `DashLifecycleMark` — the COMPACT register: glyph · one pill · fraction.
 *     For the two surfaces where a session is the subject and the dash is one
 *     fact about it.
 *   - `DashLifecycleLine` — track · fraction · note · facts. No age.
 *   - `DashLifecycleBlock` — eyebrow (glyph · atom · rule · workers) over the
 *     line: the Lens row and the shade row, at the rail and reading scales.
 *
 * **Two registers, one grammar.** The track went out to six surfaces at once
 * and on two of them it did not fit — it grew with the plan, and on a row that
 * leads with an eliding name it grew into whatever was beside it. So the strip
 * belongs to the three surfaces whose subject IS the dash (the Lens's Dashes
 * section, the Changes shade, the DASH placard) and the two where it is not
 * get the mark instead. The sixth, Z2's DASH cell, is an instrument readout
 * and takes the shape its four neighbours already take: two dots and a word.
 *
 * **Nothing here is drawn by hand, and the masthead least of all.** The
 * masthead frame mounts the real `SessionIdentityRow` at the real
 * `SessionMasthead`'s settings — one mark per row, the dense dot packed at the
 * column, the description ladder beneath — with the dash binding handed to it
 * rather than read from the store. Where an earlier draft of this card
 * assembled a row out of parts, it produced two pulsing dots in two states,
 * which is a thing the app has never shown and would never show. A frame that
 * can differ from the app is a frame that can lie about it.
 *
 * Every moment below is ONE wire entry. The track model, the note, the facts,
 * the masthead's binding, and the honest "today" rendering are all projections
 * of that single object, so no two panels on a row can disagree.
 *
 * @module spikes/spike-dash-lifecycle
 */

import "./spike.css";
import "./spike-dash-lifecycle.css";

import React from "react";

import type { SpikeDef } from "./spike-registry";

import { DashLifecycleBlock } from "@/components/tugways/dash-lifecycle-block";
import { DashLifecycleLine, dashLifecycleNote } from "@/components/tugways/dash-lifecycle-line";
import { DashLifecycleMark, dashMarkFraction } from "@/components/tugways/dash-lifecycle-mark";
import { DashPhaseMark } from "@/components/tugways/dash-phase-mark";

import { dashEntryGlanceFraction, dashMetaFacts } from "@/lib/dash-meta-facts";
import { SessionIdentityRow } from "@/components/tugways/session-identity-row";
import { TugDashAtom } from "@/components/tugways/tug-dash-atom";

import {
  TugDashTrack,
  DASH_PHASE_LABELS,
  dashTrackModel,
  dashTrackModelFromEntry,
  type DashTrackModel,
} from "@/components/tugways/tug-dash-track";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugSessionIdentity } from "@/components/tugways/tug-session-identity";
import { TugStatusCell } from "@/components/tugways/tug-status-cell";
import { TUG_SESSION_ROW_STACK_DOT_SIZE } from "@/components/tugways/tug-session-row";

import type { DashChangesetEntry, DashStep } from "@/lib/changeset-types";
import type { DashSessionFact } from "@/lib/dash-session-index";
import { useSessionIdentity } from "@/lib/session-identity";
import { sessionNameStore } from "@/lib/session-name-store";
import { sessionTagStore } from "@/lib/session-tag-store";

// ---------------------------------------------------------------------------
// Fixtures — one wire entry per point in a dash's life, plus a poke
// ---------------------------------------------------------------------------

const ROOT = "/Users/kocienda/Mounts/u/src/tugtool";
const WORKER = "5d2e9b10-0000-4000-8000-00000000d45c";
const POKER = "5d2e9b10-0000-4000-8000-00000000b0ce";
const TOUCHED = 1_760_000_000_000;
const PLAN = `${ROOT}/.tug/dashes/tugrev-bringup/plan.md`;
const BRIEF = `${ROOT}/.tug/dashes/tugrev-bringup/brief.md`;

sessionNameStore.setName(WORKER, "tugrev bringup");
sessionTagStore.setTag(WORKER, "juicy-river-3");
sessionNameStore.setName(POKER, "Lens polish");
sessionTagStore.setTag(POKER, "amber-fox-7");

function steps(done: number, current: number | null, total: number): DashStep[] {
  return Array.from({ length: total }, (_, i) => ({
    title: `Step ${i + 1}`,
    status: i < done ? "done" : i + 1 === current ? "in progress" : "pending",
  }));
}

function entry(name: string, over: Partial<DashChangesetEntry>): DashChangesetEntry {
  return {
    kind: "dash",
    owner_id: `tugdash/${name}#spike-${name}`,
    display_name: name,
    base: "main",
    rounds: 0,
    worktree: `${ROOT}/.tug/worktrees/${name}`,
    worktree_dirty: false,
    files: [],
    last_activity: new Date(TOUCHED).toISOString(),
    ...over,
  };
}

/** The dash branch's files, once there is a branch. */
const BRANCH_FILES = [
  {
    path: "tugrust/crates/tugrev-core/src/parse.rs",
    git_status: "A",
    op: "write",
    origin: "dash",
    shared: false,
    last_touched: TOUCHED,
  },
];

/** One point in a dash's life. */
interface Moment {
  key: string;
  caption: string;
  workers: readonly string[];
  entry: DashChangesetEntry;
  /** What the masthead's description line carries — this card's last prompt. */
  prompt: string;
  /** False before `dash create` cuts the branch: the Today column has nothing. */
  branched: boolean;
}

const IMPLEMENT_TITLE = "`tugutil file rev`, the `tugrev` bin, and the receipt";
const DRAFT_SUBJECT = "Add tugrev-core and the `.rev` edit language";
const POKE_SUBJECT = "Lens Dashes empty state reads None, centered";
const DASH = "tugrev-bringup";

const MOMENTS: readonly Moment[] = [
  {
    key: "brief",
    caption: "The brief is written; the wheel has not turned yet",
    workers: [WORKER],
    prompt: "/tugplug:dash tugrev — the `.rev` edit language and its gate",
    branched: false,
    entry: entry(DASH, { documents: { brief: BRIEF } }),
  },
  {
    key: "devise",
    caption: "Devise is on the card — the point every surface but the Lens shows nothing for today",
    workers: [WORKER],
    prompt: "/tugplug:dash-devise tugrev-bringup",
    branched: false,
    entry: entry(DASH, { documents: { brief: BRIEF }, arc: { stage: "devise" } }),
  },
  {
    key: "review",
    caption: "Review is on the card; the plan exists and has ten steps",
    workers: [WORKER],
    prompt: "/tugplug:dash-review tugrev-bringup",
    branched: false,
    entry: entry(DASH, {
      documents: { brief: BRIEF, plan: PLAN },
      arc: { stage: "review" },
      steps: steps(0, null, 10),
      step_total: 10,
      review: "never-reviewed",
    }),
  },
  {
    key: "implement",
    caption: "Implement, step 4 of 10 — the one point the app draws on every surface today",
    workers: [WORKER],
    prompt: "/tugplug:dash-implement tugrev-bringup",
    branched: true,
    entry: entry(DASH, {
      branch: `tugdash/${DASH}`,
      bound_sessions: [WORKER],
      stage: "implementing",
      arc: { stage: "implement" },
      step_current: 4,
      step_total: 10,
      run_position: 4,
      run_length: 10,
      step_title: IMPLEMENT_TITLE,
      steps: steps(3, 4, 10),
      documents: { brief: BRIEF, plan: PLAN },
      review: "reviewed",
      rounds: 3,
      files: BRANCH_FILES,
      worktree_dirty: true,
      base_ahead: 1,
    }),
  },
  {
    key: "stopped",
    caption: "The arc stopped in implement — the stop outranks the track",
    workers: [],
    prompt: "/tugplug:dash-implement tugrev-bringup",
    branched: true,
    entry: entry(DASH, {
      branch: `tugdash/${DASH}`,
      stage: "working",
      arc: { stage: "implement", stopped: "card closed", stopped_stage: "implement" },
      step_current: 7,
      step_total: 10,
      run_position: 7,
      run_length: 10,
      step_title: "the receipt's proof-class rows",
      steps: steps(6, 7, 10),
      documents: { brief: BRIEF, plan: PLAN },
      review: "reviewed",
      rounds: 6,
      files: BRANCH_FILES,
    }),
  },
  {
    key: "ready",
    caption: "Every step done; the draft is written and the join is offered",
    workers: [WORKER],
    prompt: "/tugplug:dash-implement tugrev-bringup",
    branched: true,
    entry: entry(DASH, {
      branch: `tugdash/${DASH}`,
      bound_sessions: [WORKER],
      stage: "draft-ready",
      arc: { stage: "implement", done: true },
      step_current: 10,
      step_total: 10,
      run_position: 10,
      run_length: 10,
      steps: steps(10, null, 10),
      documents: { brief: BRIEF, plan: PLAN },
      review: "reviewed",
      rounds: 10,
      files: BRANCH_FILES,
      draft: { fingerprint: "spike", updated_at: TOUCHED, message: `${DRAFT_SUBJECT}\n\nBody.` },
    }),
  },
  {
    key: "poke",
    caption: "A poke — no documents, no arc: two cells, the same atom, the same join",
    workers: [POKER],
    prompt: `/tugplug:poke lens-none-empty ${POKE_SUBJECT}`,
    branched: true,
    entry: entry("lens-none-empty", {
      branch: "tugdash/lens-none-empty",
      bound_sessions: [POKER],
      stage: "working",
      rounds: 2,
      files: BRANCH_FILES,
      worktree_dirty: true,
      draft: { fingerprint: "spike", updated_at: TOUCHED, message: POKE_SUBJECT },
    }),
  },
];

/**
 * The session-scoped binding, projected from the entry exactly as
 * `dashSessionIndex` projects it — so the masthead is reading the same object
 * the two blocks beside it are.
 */
function factFor(m: Moment): DashSessionFact {
  const e = m.entry;
  return {
    ownerId: e.owner_id,
    name: e.display_name,
    stage: e.stage ?? null,
    arc: e.arc ?? null,
    review: e.review ?? null,
    projectDir: ROOT,
    stepCurrent: e.step_current ?? null,
    stepTotal: e.step_total ?? null,
    runPosition: e.run_position ?? null,
    runLength: e.run_length ?? null,
    stepTitle: e.step_title ?? null,
    hasPlan: e.documents?.plan !== undefined,
    entry: e,
  };
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

function Stage({ caption, children }: { caption: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section className="spdl-stage">
      <TugLabel size="2xs" emphasis="calm" className="spdl-caption">
        {caption}
      </TugLabel>
      {children}
    </section>
  );
}

function Worker({ sessionId, size }: { sessionId: string; size: "sm" | "2xs" }): React.ReactElement {
  const identity = useSessionIdentity(sessionId);
  return <TugSessionIdentity identity={identity} tier="chip" size={size} dash={false} tooltip={false} />;
}

const AT_WORK = MOMENTS[3]!;

/**
 * A plan of `total` steps, `current` in progress — the fixture for the one
 * claim a single moment cannot make: that the strip is the same width at three
 * steps and at twenty-four.
 */
function planOf(total: number, current: number): DashTrackModel {
  return dashTrackModel({
    documents: { brief: BRIEF, plan: PLAN },
    arc: { stage: "implement" },
    stage: "implementing",
    steps: steps(current - 1, current, total),
  });
}

export function SpikeDashLifecycle(): React.ReactElement {
  const worker = useSessionIdentity(WORKER);
  return (
    <div className="sp-content spdl" data-testid="spike-dash-lifecycle">
      <section className="sp-section">
        <h2 className="sp-section-title">1 · The atom, once — TugDashAtom</h2>
        <Stage caption="One skin, two sizes (rail 2xs · reading sm), proportional everywhere; who is on it is the atom beside it. A poke is a dash to the atom: both are work on a worktree">
          <div className="spdl-lineup">
            <TugDashAtom name={DASH} size="2xs" />
            <TugDashAtom name={DASH} size="sm" />
            <span className="spdl-pair">
              <Worker sessionId={WORKER} size="sm" />
              <TugDashAtom name={DASH} size="sm" />
            </span>
            <TugDashAtom name="lens-none-empty" size="sm" />
          </div>
        </Stage>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">2 · The lifecycle, as one track — TugDashTrack</h2>
        <Stage caption="brief · devise · review · implement (one tick per step) · join. Each row is the real DashLifecycleLine, so the strip, the fraction, and the word are spaced by the component rather than by this card. Cap-height, so it rides any line the atom is on. What is behind you is a FILL and what is ahead is an OUTLINE: done is the muted text tone, active the theme's key color — the tone the pulsing dot uses for the same claim — the join the theme's selection color, and pending no fill at all">
          <div className="spdl-legend">
            {MOMENTS.map((m) => {
              const model = dashTrackModelFromEntry(m.entry);
              return (
                <DashLifecycleLine
                  key={m.key}
                  model={model}
                  note={dashLifecycleNote(model, null)}
                  size="read"
                />
              );
            })}
          </div>
        </Stage>
        <Stage caption="CONSTANT WIDTH. The implement cell is three cells wide at every plan length and its ticks divide it — three steps, eight, twenty-four, and the strip is the same graphic. A cell that sized to its ticks made the strip's width a function of the plan's length, so it grew under the reader and, on a narrow row, grew into whatever was set beside it">
          <div className="spdl-legend">
            {[3, 8, 24].map((n) => (
              <div className="spdl-legend-row" key={n}>
                <TugDashTrack model={planOf(n, Math.ceil(n / 3))} size="read" />
                <span className="spdl-legend-word">{`${n}-step plan`}</span>
              </div>
            ))}
          </div>
        </Stage>
        <Stage caption="The division of labour. A dash counts its steps in the track and nowhere else; the cell it is IN breathes, on the pulsing dot's own 2s envelope — quick in, slow out — so a strip and a dot on one row read as one instrument. A stopped arc holds still">
          <div className="spdl-legend-row">
            <TugProgressIndicator variant="pulsing-dot" size={12} state="running" aria-hidden />
            <TugDashTrack model={dashTrackModelFromEntry(AT_WORK.entry)} size="read" />
            <span className="spdl-legend-word">on a dash — the bare phase dot, and the track</span>
          </div>
        </Stage>
        <Stage caption="The same five phases as one glyph — DashPhaseMark. Keyed on the lifecycle PHASE, never on the git stage: a dash devising or reviewing a plan has no stage at all, which is how the mark that used to do this job came to be blank for the whole first half of a dash's life">
          <div className="spdl-legend-row">
            {MOMENTS.map((m) => (
              <DashPhaseMark key={m.key} model={dashTrackModelFromEntry(m.entry)} size={16} />
            ))}
            <span className="spdl-legend-word">brief · devise · review · implement · stopped · join · poke</span>
          </div>
        </Stage>
        <p className="spdl-prose">
          The row's indicator is a bare phase dot for the whole of a dash. A second mark drawing the same step count in
          another geometry would be free to disagree whenever one of them lagged, so the track has the subject alone.
          A stop is the one fact that outranks it: the cell paints danger, it stops breathing, and the note says why, in
          the arc receipt's words.
        </p>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">3 · The compact register — DashLifecycleMark</h2>
        <Stage caption="glyph · one pill · fraction. Where the dash is, that it is alive, and how far along — in a box that cannot grow. The dash's NAME is not here: both hosts render the identity's own ^<dash> immediately to its left, and a second spelling of a name already on the line is a second thing to keep in step">
          <div className="spdl-legend">
            {MOMENTS.map((m) => (
              <div className="spdl-legend-row" key={m.key}>
                <DashLifecycleMark
                  model={dashTrackModelFromEntry(m.entry)}
                  size="read"
                  name={m.entry.display_name}
                />
                <span className="spdl-legend-word">{m.caption}</span>
              </div>
            ))}
          </div>
        </Stage>
        <p className="spdl-prose">
          Two surfaces take this rather than the track, and they are the two where a SESSION is the subject and the dash
          is one fact about it: the session card's masthead title line, and the Lens's session rows. Both lead with a
          name that elides, and the strip beside an eliding name is a graphic competing with the thing the row is
          named for. The pill wears the track's own palette and breathes on the track's own cycle, so the two registers
          read as one grammar.
        </p>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">4 · Z2 · the DASH cell — an instrument, not a graphic</h2>
        <Stage caption="STATE's shape, exactly: a dot pinned to each edge of the value wrap and the reading centered between them. NUMBERS whenever there are numbers — the declared run, else the plan's own pair, so a reviewed plan reads 0/10 rather than a word. The word is only for a dash with no plan at all. The cell takes STATE's 18ch because it wears STATE's construction, and JOBS gives back exactly that, so the row's total is the same 80ch either way and every container rung keeps its measured value">
          {/* The real row class, so the cells sit in the row's own 10px font
              and endcap apparatus, and the real `data-dash` flag, so the
              widths under test are the ones the app applies. */}
          <div className="session-telemetry-status-row spdl-z2-row" data-dash="true">
            {MOMENTS.map((m) => {
              const model = dashTrackModelFromEntry(m.entry);
              const pair =
                dashEntryGlanceFraction(m.entry) ?? dashMarkFraction(model);
              const reading =
                pair !== null
                  ? `${pair.current}/${pair.total}`
                  : model.stopped !== null
                    ? "Stopped"
                    : model.poke
                      ? "Poke"
                      : DASH_PHASE_LABELS[model.phase];
              const state = model.stopped !== null ? "aborted" : "running";
              return (
                <TugStatusCell key={m.key} priority="tasks" label="DASH">
                  <TugProgressIndicator variant="pulsing-dot" size={12} state={state} aria-hidden />
                  <span
                    className="session-telemetry-status-value"
                    data-slot="session-telemetry-dash-value"
                    aria-label={`dash ${m.entry.display_name}`}
                  >
                    {reading}
                  </span>
                  <TugProgressIndicator variant="pulsing-dot" size={12} state={state} aria-hidden />
                </TugStatusCell>
              );
            })}
          </div>
        </Stage>
        <p className="spdl-prose">
          The whole track lived in this cell for a while, retuned by four knob overrides to survive a 78px box, and it
          drew ticks a pixel wide — a graphic too small to read at the size it was drawn. The cell now says the one
          thing that changes while somebody watches, and the strip is one press away on this cell's own placard.
        </p>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">5 · In flight — on every surface, no surface taller</h2>
        <Stage
          caption={
            'SETTLED — mark="eyebrow". The glyph leads the dash’s name, where it reads as the dash’s own state rather than as a caption on the strip; and the line below stays what it was, so the strip and the word are not separated by a third mark. The other two are kept as the record of the choice: "line" pushes the glyph between the strip and the fraction, and "both" puts one glyph twice in a two-line block'
          }
        >
          <div className="spdl-surfaces">
            {(["eyebrow", "line", "both"] as const).map((where) => {
              const model = dashTrackModelFromEntry(AT_WORK.entry);
              return (
                <div className="spdl-surface" key={where}>
                  <span className="spdl-surface-name">{`mark="${where}"`}</span>
                  <DashLifecycleBlock
                    name={AT_WORK.entry.display_name}
                    workers={AT_WORK.workers}
                    model={model}
                    note={dashLifecycleNote(model, AT_WORK.entry.step_title ?? null)}
                    facts={dashMetaFacts(AT_WORK.entry)}
                    size="read"
                    mark={where}
                  />
                </div>
              );
            })}
          </div>
        </Stage>
        {MOMENTS.map((m) => {
          const model = dashTrackModelFromEntry(m.entry);
          const note = dashLifecycleNote(model, m.entry.step_title ?? null);
          const facts = dashMetaFacts(m.entry);
          const name = m.entry.display_name;
          return (
            <Stage key={m.key} caption={m.caption}>
              <div className="spdl-surfaces">
                <div className="spdl-surface">
                  <span className="spdl-surface-name">Lens · DashLifecycleBlock size=rail</span>
                  <TugListRow variant="flush" density="compact">
                    <DashLifecycleBlock name={name} workers={m.workers} model={model} note={note} facts={facts} size="rail" />
                  </TugListRow>
                </div>
                <div className="spdl-surface">
                  <span className="spdl-surface-name">Changes shade · DashLifecycleBlock size=read</span>
                  <DashLifecycleBlock name={name} workers={m.workers} model={model} note={note} facts={facts} size="read" />
                </div>
                <div className="spdl-surface" data-wide="true">
                  <span className="spdl-surface-name">Masthead · the real SessionIdentityRow, at SessionMasthead's settings</span>
                  <SessionIdentityRow
                    className="spdl-masthead-row"
                    sessionId={m.workers[0] ?? WORKER}
                    projectDir={ROOT}
                    dash={factFor(m)}
                    dotSize={TUG_SESSION_ROW_STACK_DOT_SIZE}
                    indicatorPacking="column"
                    subAlign="title"
                    activityOverride={m.prompt}
                  />
                </div>

              </div>
            </Stage>
          );
        })}
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">6 · Where each one mounts</h2>
        <ul className="spdl-survey">
          <li>
            <b>Session masthead — and the Lens's session rows</b> — one component serves both: `SessionIdentityRow`
            renders `DashLifecycleMark` in its title run, with the `i/N` handed to it counting the declared run rather
            than the plan. Its own indicator stays the bare phase dot. The row takes a `dash` prop — the binding in
            hand rather than a second read by id — which is what lets this card mount the real thing.
          </li>
          <li>
            <b>Lens · Dashes</b> — `DashLifecycleBlock size=rail` on every row, branch or documents-only: one grammar
            from the brief onward. The row menu is the block's `trailing`, and a documents-only row's next-gesture
            button takes the same slot.
          </li>
          <li>
            <b>Changes shade · dash lane</b> — `DashLifecycleBlock size=read` on the collapsed row and on the
            documents-only row; the fold cue and the Unbind are `trailing`.
          </li>
          <li>
            <b>Transcript footer DASH cell</b> — no strip at all: one `TugProgressIndicator` with a dot on each side and
            the pair of counters between them — the declared run, else the plan's own — falling back to a word only for
            a dash with no plan. STATE's construction, so it takes STATE's 18ch while a dash is up; JOBS gives back the
            4ch, so the row's total never moves.
          </li>
          <li>
            <b>DASH placard and the dash picker</b> — the block at `read` heads the placard; the picker's rows lead with
            `TugDashAtom` and one `DashWorkerAtom` per bound session.
          </li>
          <li>
            <b>Wire</b> — no new field. `useDashForSession` and the shade read the documents-only entry too, through
            `documentDashAsEntry` and `documentDashTrackModel`; `dashTrackModelFromEntry` does the rest.
          </li>
        </ul>
      </section>
    </div>
  );
}

export const spike: SpikeDef = {
  name: "dash-lifecycle",
  title: "Dash Lifecycle",
  blurb:
    "One grammar, two registers: the constant-width track where the dash is the subject, the glyph-pill-fraction mark where it is one fact about a session, and two dots and a word in the instrument row.",
  icon: "Route",
  size: { min: { width: 520, height: 400 }, preferred: { width: 860, height: 720 } },
  component: () => <SpikeDashLifecycle />,
};
