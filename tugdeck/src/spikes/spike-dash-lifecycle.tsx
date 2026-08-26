/**
 * spike-dash-lifecycle.tsx — can one atom, one track, and one line carry a
 * dash through its whole life, on every surface, without any surface growing?
 *
 * The answer is four real components, and this card is only the fixture data
 * and the frames that show them beside what ships today:
 *
 *   - `TugDashAtom` — the one skin, two sizes, and the poke's kind-word.
 *   - `TugDashTrack` — brief · devise · review · implement (ticks) · join, in
 *     a cap-height strip; `dashTrackModel` derives it from the feed's fields.
 *   - `DashLifecycleLine` — track · fraction · note · facts. No age.
 *   - `DashLifecycleBlock` — eyebrow (atom · rule · workers) over the line:
 *     the Lens row and the shade row, at the rail and reading scales.
 *
 * Nothing drawn here is authored here. Refine the components until they are
 * right, then mount them where they go — the Lens section, the shade's lane,
 * the masthead's title run, the footer's status cell — and the design arrives
 * whole.
 *
 * @module spikes/spike-dash-lifecycle
 */

import "./spike.css";
import "./spike-dash-lifecycle.css";

import React from "react";

import type { SpikeDef } from "./spike-registry";

import { DashLifecycleBlock } from "@/components/tugways/dash-lifecycle-block";
import { dashLifecycleNote } from "@/components/tugways/dash-lifecycle-line";
import { DashMetaLine, dashMetaFacts, type DashMetaFact } from "@/components/tugways/dash-meta-line";
import { TugDashAtom } from "@/components/tugways/tug-dash-atom";
import { TugDashName } from "@/components/tugways/tug-dash-name";
import { TugDashTrack, dashTrackModel, type DashTrackInput, type DashTrackModel } from "@/components/tugways/tug-dash-track";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugSessionIdentity } from "@/components/tugways/tug-session-identity";
import { TugStepRing } from "@/components/tugways/tug-step-ring";
import type { DashChangesetEntry, DashStep } from "@/lib/changeset-types";
import { useSessionIdentity } from "@/lib/session-identity";
import { sessionNameStore } from "@/lib/session-name-store";
import { sessionTagStore } from "@/lib/session-tag-store";

// ---------------------------------------------------------------------------
// Fixtures — the same dash at every point of its life, plus a poke
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

/** One point in a dash's life: what the feed would carry, and the caption. */
interface Moment {
  key: string;
  caption: string;
  name: string;
  workers: readonly string[];
  input: DashTrackInput;
  stepTitle?: string;
  draftSubject?: string;
  /** The shipping wire entry, for the honest "today" column; null before the branch exists. */
  today: DashChangesetEntry | null;
}

function entry(name: string, over: Partial<DashChangesetEntry>): DashChangesetEntry {
  return {
    kind: "dash",
    owner_id: `tugdash/${name}#spike-${name}`,
    display_name: name,
    branch: `tugdash/${name}`,
    base: "main",
    rounds: 0,
    worktree: `${ROOT}/.tug/worktrees/${name}`,
    worktree_dirty: false,
    files: [
      { path: "tugrust/crates/tugrev-core/src/parse.rs", git_status: "A", op: "write", origin: "dash", shared: false, last_touched: TOUCHED },
    ],
    last_activity: new Date(TOUCHED).toISOString(),
    ...over,
  };
}

const IMPLEMENT_TITLE = "`tugutil file rev`, the `tugrev` bin, and the receipt";
const DRAFT_SUBJECT = "Add tugrev-core and the `.rev` edit language";
const POKE_SUBJECT = "Lens Dashes empty state reads None, centered";

const MOMENTS: readonly Moment[] = [
  {
    key: "brief",
    caption: "The brief is written; the wheel has not turned yet",
    name: "tugrev-bringup",
    workers: [WORKER],
    input: { documents: { brief: BRIEF } },
    today: null,
  },
  {
    key: "devise",
    caption: "Devise is on the card — the point every surface but the Lens shows nothing for today",
    name: "tugrev-bringup",
    workers: [WORKER],
    input: { documents: { brief: BRIEF }, arc: { stage: "devise" } },
    today: null,
  },
  {
    key: "review",
    caption: "Review is on the card; the plan exists and has ten steps",
    name: "tugrev-bringup",
    workers: [WORKER],
    input: { documents: { brief: BRIEF, plan: PLAN }, arc: { stage: "review" }, steps: steps(0, null, 10) },
    today: null,
  },
  {
    key: "implement",
    caption: "Implement, step 4 of 10 — the one point the app draws on every surface today",
    name: "tugrev-bringup",
    workers: [WORKER],
    input: { documents: { brief: BRIEF, plan: PLAN }, arc: { stage: "implement" }, steps: steps(3, 4, 10), stage: "implementing" },
    stepTitle: IMPLEMENT_TITLE,
    today: entry("tugrev-bringup", {
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
      worktree_dirty: true,
      base_ahead: 1,
    }),
  },
  {
    key: "stopped",
    caption: "The arc stopped in implement — the stop outranks the track",
    name: "tugrev-bringup",
    workers: [],
    input: {
      documents: { brief: BRIEF, plan: PLAN },
      arc: { stage: "implement", stopped: "card closed", stopped_stage: "implement" },
      steps: steps(6, 7, 10),
      stage: "working",
    },
    stepTitle: "the receipt's proof-class rows",
    today: entry("tugrev-bringup", {
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
    }),
  },
  {
    key: "ready",
    caption: "Every step done; the draft is written and the join is offered",
    name: "tugrev-bringup",
    workers: [WORKER],
    input: { documents: { brief: BRIEF, plan: PLAN }, arc: { stage: "implement", done: true }, steps: steps(10, null, 10), stage: "draft-ready" },
    draftSubject: DRAFT_SUBJECT,
    today: entry("tugrev-bringup", {
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
      draft: { fingerprint: "spike", updated_at: TOUCHED, message: `${DRAFT_SUBJECT}\n\nBody.` },
    }),
  },
  {
    key: "poke",
    caption: "A poke — no documents, no arc: two cells, the same atom, the same join",
    name: "lens-none-empty",
    workers: [POKER],
    input: { stage: "working" },
    draftSubject: POKE_SUBJECT,
    today: entry("lens-none-empty", {
      bound_sessions: [POKER],
      stage: "working",
      rounds: 2,
      worktree_dirty: true,
      draft: { fingerprint: "spike", updated_at: TOUCHED, message: POKE_SUBJECT },
    }),
  },
];

/** The three things a surface hands the components, derived once per moment. */
function derive(m: Moment): { model: DashTrackModel; note: string; facts: DashMetaFact[] } {
  const model = dashTrackModel(m.input);
  const note = dashLifecycleNote(model, m.stepTitle ?? null, m.draftSubject ?? null);
  const facts = m.today !== null ? dashMetaFacts(m.today) : [];
  return { model, note, facts };
}

// ---------------------------------------------------------------------------
// Frames — where each component would stand
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

/**
 * The masthead's title line at its shipping height (36px): the indicator, the
 * identity run, and the track in the width the hidden callsign frees. The
 * `^name` run is dropped from the identity — the track and the Lens carry it.
 */
function Masthead({ m, model }: { m: Moment; model: DashTrackModel }): React.ReactElement {
  const identity = useSessionIdentity(m.workers[0] ?? WORKER);
  const s = model.steps;
  return (
    <div className="spdl-masthead">
      {s !== null && s.current !== null ? (
        <TugStepRing current={s.current} total={s.total} complete={s.done === s.total} size={16} />
      ) : (
        <span className="spdl-masthead-dot" aria-hidden="true" />
      )}
      <TugSessionIdentity identity={identity} tier="line" dash={false} tooltip={false} />
      <TugDashTrack model={model} size="read" />
    </div>
  );
}

const AT_WORK = MOMENTS[3]!;

export function SpikeDashLifecycle(): React.ReactElement {
  const worker = useSessionIdentity(WORKER);
  return (
    <div className="sp-content spdl" data-testid="spike-dash-lifecycle">
      <section className="sp-section">
        <h2 className="sp-section-title">1 · The atom, once — TugDashAtom</h2>
        <Stage caption="Today — four spellings of one dash: masthead title run · Lens pill · shade unbound (mono) · shade bound · transcript footer">
          <div className="spdl-lineup">
            <span className="spdl-today-masthead">
              <TugSessionIdentity identity={worker} tier="line" dash={{ name: AT_WORK.name, review: null }} tooltip={false} />
            </span>
            <TugDashName name={AT_WORK.name} review={null} slot="spdl-lineup-lens" workerSlot="spdl-lineup-lw" atomSize="2xs" />
            <TugDashName name={AT_WORK.name} review={null} slot="spdl-lineup-unbound" workerSlot="spdl-lineup-w" atomSize="sm" />
            <TugDashName name={AT_WORK.name} review={null} boundSessions={[WORKER]} slot="spdl-lineup-b" workerSlot="spdl-lineup-bw" atomSize="sm" />
            <span className="spdl-today-footer">4/10</span>
          </div>
        </Stage>
        <Stage caption="Proposed — one skin, two sizes (rail 2xs · reading sm), proportional everywhere; who is on it is the atom beside it">
          <div className="spdl-lineup">
            <TugDashAtom name={AT_WORK.name} size="2xs" />
            <TugDashAtom name={AT_WORK.name} size="sm" />
            <span className="spdl-pair">
              <Worker sessionId={WORKER} size="sm" />
              <TugDashAtom name={AT_WORK.name} size="sm" />
            </span>
            <TugDashAtom name="lens-none-empty" size="sm" poke />
          </div>
        </Stage>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">2 · The lifecycle, as one track — TugDashTrack</h2>
        <Stage caption="variant=track: brief · devise · review · implement (one tick per step) · join. Cap-height, so it rides any line the atom is on">
          <div className="spdl-legend">
            {MOMENTS.map((m) => {
              const model = dashTrackModel(m.input);
              return (
                <div key={m.key} className="spdl-legend-row">
                  <TugDashTrack model={model} size="read" />
                  <span className="spdl-legend-word">{model.stopped !== null ? `stopped · ${model.stopped}` : model.phase}</span>
                </div>
              );
            })}
          </div>
        </Stage>
        <Stage caption="variant=pips: the same model as numbered discs. Reads the count without a fraction; wide past a dozen steps">
          <div className="spdl-legend">
            {MOMENTS.map((m) => (
              <div key={m.key} className="spdl-legend-row">
                <TugDashTrack model={dashTrackModel(m.input)} variant="pips" />
              </div>
            ))}
          </div>
        </Stage>
        <p className="spdl-prose">
          The ring stays the session's indicator, phase-toned, counting the plan; the track is the dash's. They agree by
          construction because `dashTrackModel` reads the same ledger the ring does. A stop is the one fact that outranks
          the track: the cell paints danger and the note says why, in the arc receipt's words.
        </p>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">3 · In flight — DashLifecycleBlock on every surface, no surface taller</h2>
        {MOMENTS.map((m) => {
          const { model, note, facts } = derive(m);
          return (
            <Stage key={m.key} caption={m.caption}>
              <div className="spdl-surfaces">
                <div className="spdl-surface">
                  <span className="spdl-surface-name">Lens · size=rail</span>
                  <TugListRow variant="flush" density="compact">
                    <DashLifecycleBlock name={m.name} workers={m.workers} model={model} note={note} facts={facts} size="rail" />
                  </TugListRow>
                </div>
                <div className="spdl-surface">
                  <span className="spdl-surface-name">Changes shade · size=read</span>
                  <DashLifecycleBlock name={m.name} workers={m.workers} model={model} note={note} facts={facts} size="read" />
                </div>
                <div className="spdl-surface">
                  <span className="spdl-surface-name">Masthead · TugDashTrack in the title run</span>
                  <Masthead m={m} model={model} />
                </div>
                <div className="spdl-surface" data-today="true">
                  <span className="spdl-surface-name">Today · DashMetaLine</span>
                  {m.today !== null ? (
                    <DashMetaLine entry={m.today} size="sm" />
                  ) : (
                    <span className="spdl-today-nothing">nothing — the dash has no branch yet</span>
                  )}
                </div>
              </div>
            </Stage>
          );
        })}
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">4 · Where each one mounts</h2>
        <ul className="spdl-survey">
          <li>
            <b>Lens · Dashes</b> — `DashLifecycleBlock size=rail` replaces the row's eyebrow + `DashMetaLine`, and the
            documents-only `lens-plans-row` grammar goes: one row from the brief onward. The row menu is the block's
            `trailing`.
          </li>
          <li>
            <b>Changes shade · dash lane</b> — `DashLifecycleBlock size=read` replaces `TugDashName` + `DashMetaLine`
            on the collapsed row; the fold cue is `trailing`. The lane also lists the documents-only entry.
          </li>
          <li>
            <b>Session masthead</b> — `TugDashTrack size=read` in `session-identity-row-progress`, replacing
            `DashStageMark` + `TugStepFraction`; the identity's `^name` run is dropped. Height unchanged.
          </li>
          <li>
            <b>Transcript footer STATUS cell</b> — `TugDashTrack size=rail` replaces the bare fraction / stage glyph.
          </li>
          <li>
            <b>Everywhere a dash is named</b> — `TugDashAtom`; `TugDashName`'s mono register and `formatDashAge` are
            deleted.
          </li>
          <li>
            <b>Wire</b> — no new field. `useDashForSession` and the shade read the documents-only entry too;
            `dashTrackModel` does the rest. Every model on this card came from feed-shaped input.
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
    "One atom, one track, one line: TugDashAtom, TugDashTrack, and DashLifecycleBlock carry a dash from brief to join on every surface without growing any of them.",
  icon: "Route",
  size: { min: { width: 520, height: 400 }, preferred: { width: 860, height: 720 } },
  component: () => <SpikeDashLifecycle />,
};
