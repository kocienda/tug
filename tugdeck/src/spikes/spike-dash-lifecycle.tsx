/**
 * spike-dash-lifecycle.tsx — can one atom, one track, and one line carry a
 * dash through its whole life, on every surface, without any surface growing?
 *
 * The answer is components, and this card is only fixture data and the frames
 * that hold them:
 *
 *   - `TugDashAtom` — the one skin, two sizes. A poke is a dash to it.
 *   - `TugDashTrack` — brief · devise · review · implement (ticks) · join, in
 *     a cap-height strip; `dashTrackModelFromEntry` derives it from the wire.
 *   - `DashLifecycleLine` — track · fraction · note · facts. No age.
 *   - `DashLifecycleBlock` — eyebrow (atom · rule · workers) over the line:
 *     the Lens row and the shade row, at the rail and reading scales.
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
import { DashMetaLine, dashMetaFacts } from "@/components/tugways/dash-meta-line";
import { SessionIdentityRow } from "@/components/tugways/session-identity-row";
import { TugDashAtom } from "@/components/tugways/tug-dash-atom";
import { TugDashName } from "@/components/tugways/tug-dash-name";
import { TugDashTrack, dashTrackModelFromEntry } from "@/components/tugways/tug-dash-track";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugSessionIdentity } from "@/components/tugways/tug-session-identity";
import { TUG_SESSION_ROW_STACK_DOT_SIZE } from "@/components/tugways/tug-session-row";
import { TugStepRing } from "@/components/tugways/tug-step-ring";
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

export function SpikeDashLifecycle(): React.ReactElement {
  const worker = useSessionIdentity(WORKER);
  return (
    <div className="sp-content spdl" data-testid="spike-dash-lifecycle">
      <section className="sp-section">
        <h2 className="sp-section-title">1 · The atom, once — TugDashAtom</h2>
        <Stage caption="Today — four spellings of one dash: masthead title run · Lens pill · shade unbound (mono) · shade bound · transcript footer">
          <div className="spdl-lineup">
            <span className="spdl-today-masthead">
              <TugSessionIdentity identity={worker} tier="line" dot={false} dash={{ name: DASH, review: null }} tooltip={false} />
            </span>
            <TugDashName name={DASH} review={null} slot="spdl-lineup-lens" workerSlot="spdl-lineup-lw" atomSize="2xs" />
            <TugDashName name={DASH} review={null} slot="spdl-lineup-unbound" workerSlot="spdl-lineup-w" atomSize="sm" />
            <TugDashName name={DASH} review={null} boundSessions={[WORKER]} slot="spdl-lineup-b" workerSlot="spdl-lineup-bw" atomSize="sm" />
            <span className="spdl-today-footer">4/10</span>
          </div>
        </Stage>
        <Stage caption="Proposed — one skin, two sizes (rail 2xs · reading sm), proportional everywhere; who is on it is the atom beside it. A poke is a dash to the atom: both are work on a worktree">
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
        <Stage caption="brief · devise · review · implement (one tick per step) · join. Each row is the real DashLifecycleLine, so the strip, the fraction, and the word are spaced by the component rather than by this card. Cap-height, so it rides any line the atom is on. Pending is the ring's unfilled stroke, done the muted text tone, active the accent, the join the theme's selection color">
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
        <Stage caption="The division of labour. A dash counts its steps in the track and nowhere else; the segmented ring now uniquely means a task list that is NOT a dash">
          <div className="spdl-legend-row">
            <TugProgressIndicator variant="pulsing-dot" size={12} state="running" aria-hidden />
            <TugDashTrack model={dashTrackModelFromEntry(AT_WORK.entry)} size="read" />
            <span className="spdl-legend-word">on a dash — the bare phase dot, and the track</span>
          </div>
          <div className="spdl-legend-row">
            <TugStepRing current={4} total={10} role="action" size={16} />
            <span className="spdl-legend-word">a task list off a dash — the segmented ring, unchanged</span>
          </div>
        </Stage>
        <p className="spdl-prose">
          The row's indicator stays a bare phase dot for the whole of a dash. It used to become the segmented step ring
          once counters existed, and beside the track that was two marks drawing one step count in two geometries — free
          to disagree whenever one of them lagged. The ring yields the subject entirely rather than being tuned to agree.
          A stop is the one fact that outranks the track: the cell paints danger and the note says why, in the arc
          receipt's words.
        </p>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">3 · In flight — on every surface, no surface taller</h2>
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
                <div className="spdl-surface" data-today="true">
                  <span className="spdl-surface-name">Today · DashMetaLine</span>
                  {m.branched ? (
                    <DashMetaLine entry={m.entry} size="sm" />
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
            <b>Session masthead</b> — <i>done, and live in the app.</i> `SessionIdentityRow` renders `TugDashTrack` in
            its title run where `DashStageMark` stood, so a card devising or reviewing a plan now says so instead of
            showing nothing; the `i/N` fraction stays beside it, counting the declared run. Its indicator is now always
            the bare phase dot — the segmented `SessionStepRing` is gone from dash rows, leaving it to mean a task list
            that is not a dash. The row also gained a `dash` prop — the binding in hand rather than a second read by id,
            the same seam `row` already had — which is what lets this card mount the real thing.
          </li>
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
            <b>Transcript footer STATUS cell</b> — `TugDashTrack size=rail` replaces the bare fraction / stage glyph.
          </li>
          <li>
            <b>Everywhere a dash is named</b> — `TugDashAtom`; `TugDashName`'s mono register and `formatDashAge` are
            deleted.
          </li>
          <li>
            <b>Wire</b> — no new field. `useDashForSession` and the shade read the documents-only entry too;
            `dashTrackModelFromEntry` does the rest.
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
