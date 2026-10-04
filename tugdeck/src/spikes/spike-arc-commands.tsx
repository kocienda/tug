/**
 * spike-arc-commands.tsx — one way to reach an arc's verbs, on every surface
 * that shows an arc.
 *
 * Three surfaces wear the same `ArcLifecycleBlock` and disagree about
 * everything around it:
 *
 *   - The **Arcs card** seats the transport as a bare icon (■ / ▶) beside the
 *     fold cue, and hides Bind, Replay and Discard behind a right-click.
 *   - The **ARC popup** seats the transport as an outlined WORD ("STOP") and
 *     adds a ghost "SHOW IN CHANGES" — and offers none of the row verbs.
 *   - The **Changes shade** has no transport at all, and puts Unbind, Replay
 *     and Discard behind a ⋮ beside a pop-out icon and the fold cue.
 *
 * The question: can one verb set, in one order and one form, ride all three?
 * The spike fixes the set and its order once — the arc's next act (Start /
 * Stop / Resume / Join), then the way to look at it (Show in Changes, or the
 * diff when you are already there), then the housekeeping (Bind/Unbind,
 * Replay, Discard) — and lets the reader flip between four treatments of it
 * across four arc states. "As shipped" is today's mix, kept as the baseline.
 *
 * Nothing here sends a wire frame. Every press lands in the readout at the
 * top, so the reader can see which verb a control would have fired.
 */

import "./spike.css";
import "./spike-arc-commands.css";

import React, { useCallback, useId, useMemo, useState } from "react";
import {
  ChevronDown,
  EllipsisVertical,
  GitCommitHorizontal,
  GitMerge,
  Link2Off,
  Play,
  RotateCcw,
  Square,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react";

import type { SpikeDef } from "./spike-registry";
import { ArcLifecycleBlock } from "@/components/tugways/arc-lifecycle-block";
import { ArcStepItems } from "@/components/tugways/arc-step-list";
import { BlockFoldCue } from "@/components/tugways/body-kinds/affordances/block-fold-cue";
import { useArcRowMenu } from "@/components/tugways/cards/session-changes/arc-row-menu";
import { TugArcAtom } from "@/components/tugways/tug-arc-atom";
import { arcTrackModel, type ArcTrackModel } from "@/components/tugways/tug-arc-track";
import { TugChoiceGroup, type TugChoiceItem } from "@/components/tugways/tug-choice-group";
import { TugLabel } from "@/components/tugways/tug-label";
import {
  TugPopupListFooter,
  TugPopupListFrame,
  TugPopupListScroller,
} from "@/components/tugways/tug-popup-list";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import type { ArcRunState, ArcStep } from "@/lib/changeset-types";
import { sessionNameStore } from "@/lib/session-name-store";
import { sessionTagStore } from "@/lib/session-tag-store";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ARC = "settle-engine-and-beat";
const WORKER = "5d2e9b10-0000-4000-8000-0000000a2c05";
const ROOT = "/Users/kocienda/Mounts/u/src/tug";
const BRIEF = `${ROOT}/.tug/arcs/${ARC}/brief.md`;
const PLAN = `${ROOT}/.tug/arcs/${ARC}/plan.md`;

sessionNameStore.setName(WORKER, "settle engine");
sessionTagStore.setTag(WORKER, "glossy-bowl");

const STEP_TITLES = [
  "Take the baseline reading",
  "Extract pane-stacking.ts",
  "Extract settle-engine.ts",
  "Write the Beat; the pre-launched move becomes the first Beat",
  "The six Last-pass beats become Beats",
  "Convert or declare the raw sites, and land the motion lint",
  "Final reading, fan-out pay-down, and @covers",
];

function stepsAt(done: number, current: number | null): ArcStep[] {
  return STEP_TITLES.map((title, i) => ({
    title,
    status: i < done ? "done" : i + 1 === current ? "in progress" : "pending",
  }));
}

type ArcState = "briefed" | "executing" | "stopped" | "ready";

interface Moment {
  model: ArcTrackModel;
  steps: ArcStep[];
  /** Whether the base has moved past the arc — what makes Replay available. */
  diverged: boolean;
  /** Whether the arc has a branch yet. A briefed arc is paperwork. */
  branch: boolean;
}

function moment(state: ArcState): Moment {
  const documents = { brief: BRIEF, plan: PLAN };
  const run = (over: ArcRunState): ArcRunState => over;
  switch (state) {
    case "briefed":
      return {
        model: arcTrackModel({ documents, arcKind: "planned", arc: null }),
        steps: stepsAt(0, null),
        diverged: false,
        branch: false,
      };
    case "executing":
      return {
        model: arcTrackModel({
          documents,
          arcKind: "planned",
          arc: run({ stage: "implement" }),
          stage: "implementing",
          steps: stepsAt(5, 6),
          holdersBusy: true,
        }),
        steps: stepsAt(5, 6),
        diverged: false,
        branch: true,
      };
    case "stopped":
      return {
        model: arcTrackModel({
          documents,
          arcKind: "planned",
          arc: run({
            stage: "implement",
            stopped: "user",
            stopped_stage: "implement",
            stopped_why: "stopped by you",
          }),
          stage: "implementing",
          steps: stepsAt(5, 6),
        }),
        steps: stepsAt(5, 6),
        diverged: true,
        branch: true,
      };
    case "ready":
      return {
        model: arcTrackModel({
          documents,
          arcKind: "planned",
          arc: run({ done: true }),
          stage: "audited",
          steps: stepsAt(7, null),
        }),
        steps: stepsAt(7, null),
        diverged: true,
        branch: true,
      };
  }
}

// ---------------------------------------------------------------------------
// The verb set — fixed once, in one order, for every surface
// ---------------------------------------------------------------------------

type Surface = "arcs" | "popup" | "changes";

const SURFACE_NAME: Record<Surface, string> = {
  arcs: "Arcs card",
  popup: "ARC popup",
  changes: "Changes shade",
};

interface Verb {
  key: string;
  word: string;
  icon: React.ReactNode;
  /** Why it is refused right now; null when it is available. */
  reason: string | null;
  danger?: boolean;
}

interface VerbSet {
  /** The arc's next act. Null when the arc has none from a row. */
  act: Verb | null;
  /** The way to look at the arc from here. */
  look: Verb;
  /** Bind/Unbind, Replay, Discard — in that order, always. */
  keep: Verb[];
}

const ICON = 14;

function verbsFor(state: ArcState, surface: Surface, m: Moment): VerbSet {
  const act: Verb | null =
    state === "briefed"
      ? { key: "start", word: "Start", icon: <Play size={ICON} />, reason: null }
      : state === "executing"
        ? { key: "stop", word: "Stop", icon: <Square size={ICON} />, reason: null }
        : state === "stopped"
          ? { key: "resume", word: "Resume", icon: <Play size={ICON} />, reason: null }
          : { key: "join", word: "Join", icon: <GitMerge size={ICON} />, reason: null };
  // Already in Changes, "show in Changes" has nowhere to go; the look there is
  // the arc's own diff. One slot, one meaning: the view of this arc.
  const look: Verb =
    surface === "changes"
      ? {
          key: "diff",
          word: "Diff",
          icon: <SquareArrowOutUpRight size={ICON} />,
          reason: m.branch ? null : "nothing to diff yet",
        }
      : {
          key: "show",
          word: "Changes",
          icon: <GitCommitHorizontal size={ICON} />,
          reason: null,
        };
  const keep: Verb[] = [
    { key: "unbind", word: "Unbind", icon: <Link2Off size={ICON} />, reason: null },
  ];
  if (m.branch) {
    keep.push({
      key: "replay",
      word: "Replay",
      icon: <RotateCcw size={ICON} />,
      reason: m.diverged ? null : "already current with main",
    });
  }
  // A branchless arc's Discard is today's "Delete documents" — the same act
  // on an arc that has nothing else to lose, so it wears the same word.
  keep.push({
    key: "discard",
    word: "Discard",
    icon: <Trash2 size={ICON} />,
    reason: null,
    danger: true,
  });
  return { act, look, keep };
}

// ---------------------------------------------------------------------------
// Treatments
// ---------------------------------------------------------------------------

type Treatment = "shipped" | "verb-row" | "act-menu" | "icons";

const TREATMENT_BLURB: Record<Treatment, string> = {
  shipped:
    "Today. Icon transport on the Arcs card, word transport on the popup, none in Changes; row verbs behind a right-click on one surface and a ⋮ on another.",
  "verb-row":
    "Every verb visible, icon + word, in one row under the block — the popup's footer IS that row. The act leads, outlined; the look follows; the housekeeping trails. Nothing behind a menu.",
  "act-menu":
    "The act and the look stay visible as icon + word; the housekeeping goes behind a labeled “Arc ▾” button rather than a ⋮ — and right-click opens the same menu on every surface.",
  icons:
    "Every verb as an icon, same order everywhere, the word in a tooltip. The densest option, kept as the foil: it is what the Arcs card does today, generalised.",
};

type Press = (surface: Surface, verb: string) => void;

interface FrameProps {
  surface: Surface;
  treatment: Treatment;
  state: ArcState;
  m: Moment;
  press: Press;
}

function VerbButton({
  verb,
  form,
  primary = false,
  onPress,
}: {
  verb: Verb;
  form: "word" | "icon-text" | "icon";
  primary?: boolean;
  onPress: () => void;
}): React.ReactElement {
  const refused = verb.reason !== null;
  const label = refused ? `${verb.word} — ${verb.reason}` : verb.word;
  const button = (
    <TugPushButton
      size="2xs"
      subtype={form === "word" ? "text" : form}
      emphasis={primary ? "outlined" : "ghost"}
      {...(verb.danger === true ? { role: "danger" } : {})}
      {...(form !== "word" ? { icon: verb.icon } : {})}
      aria-label={`${label} arc ${ARC}`}
      aria-disabled={refused || undefined}
      data-refused={refused || undefined}
      onClick={onPress}
    >
      {form === "icon" ? undefined : verb.word}
    </TugPushButton>
  );
  return form === "icon" || refused ? (
    <TugTooltip content={label}>{button}</TugTooltip>
  ) : (
    button
  );
}

/** The menu the housekeeping verbs ride in, built on the shipping hook. */
function useKeepMenu(set: VerbSet, surface: Surface, press: Press) {
  const find = (key: string) => set.keep.find((v) => v.key === key) ?? null;
  const unbind = find("unbind");
  const replay = find("replay");
  const discard = find("discard");
  return useArcRowMenu({
    binding:
      unbind === null
        ? null
        : { bound: true, disabledReason: null, perform: () => press(surface, "Unbind") },
    discard:
      discard === null
        ? null
        : { disabledReason: null, perform: () => press(surface, "Discard") },
    replay:
      replay === null
        ? null
        : {
            disabledReason: replay.reason,
            label: "Replay onto main",
            perform: () => press(surface, "Replay onto main"),
          },
  });
}

function Fold({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: (next: boolean) => void;
}): React.ReactElement {
  return (
    <BlockFoldCue
      collapsed={collapsed}
      onToggle={onToggle}
      collapsedLabel="Expand"
      expandedLabel="Collapse"
      ariaLabelExpand="Expand"
      ariaLabelCollapse="Collapse"
      size="xs"
      subtype="icon"
      stabilizeScroll={false}
    />
  );
}

/**
 * The controls a treatment puts on a surface, in the slot each surface owns:
 * `inline` rides the block (the Arcs card's line, the shade's eyebrow), `row`
 * is a run of its own under the block (or, on the popup, its footer).
 */
function useControls({ surface, treatment, state, m, press }: FrameProps): {
  inline: React.ReactNode;
  row: React.ReactNode;
  menu: React.ReactNode;
  onContextMenu?: (e: React.MouseEvent) => void;
} {
  const set = verbsFor(state, surface, m);
  const keepMenu = useKeepMenu(set, surface, press);
  const fire = (v: Verb) => () =>
    press(surface, v.reason === null ? v.word : `${v.word} (refused — ${v.reason})`);
  const contextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    keepMenu.openMenuAt(e.clientX, e.clientY);
  };

  if (treatment === "shipped") {
    // Today's arrangement, surface by surface. Join is composer-only today, so
    // a ready arc's act slot is empty here.
    const act = set.act !== null && set.act.key !== "join" ? set.act : null;
    if (surface === "arcs") {
      return {
        inline: act ? <VerbButton verb={act} form="icon" onPress={fire(act)} /> : null,
        row: null,
        menu: keepMenu.menu,
        onContextMenu: contextMenu,
      };
    }
    if (surface === "popup") {
      return {
        inline: null,
        row: (
          <>
            {act && act.key !== "start" ? (
              <VerbButton verb={act} form="word" primary onPress={fire(act)} />
            ) : null}
            <TugPushButton size="2xs" emphasis="ghost" onClick={fire(set.look)}>
              Show in Changes
            </TugPushButton>
          </>
        ),
        menu: null,
      };
    }
    return {
      inline: (
        <>
          <TugPushButton
            size="2xs"
            subtype="icon"
            emphasis="ghost"
            icon={<EllipsisVertical size={ICON} />}
            aria-label={`Actions for arc ${ARC}`}
            onClick={(e) => keepMenu.openMenu((e?.currentTarget as HTMLElement) ?? null)}
          />
          {m.branch ? (
            <VerbButton verb={set.look} form="icon" onPress={fire(set.look)} />
          ) : null}
        </>
      ),
      row: null,
      menu: keepMenu.menu,
    };
  }

  if (treatment === "verb-row") {
    return {
      inline: null,
      row: (
        <>
          {set.act ? (
            <VerbButton verb={set.act} form="icon-text" primary onPress={fire(set.act)} />
          ) : null}
          <VerbButton verb={set.look} form="icon-text" onPress={fire(set.look)} />
          <span className="sp-arc-commands-spacer" />
          {set.keep.map((v) => (
            <VerbButton key={v.key} verb={v} form="icon-text" onPress={fire(v)} />
          ))}
        </>
      ),
      menu: null,
    };
  }

  if (treatment === "act-menu") {
    const cluster = (
      <>
        {set.act ? (
          <VerbButton verb={set.act} form="icon-text" primary onPress={fire(set.act)} />
        ) : null}
        <VerbButton verb={set.look} form="icon-text" onPress={fire(set.look)} />
        <TugPushButton
          size="2xs"
          subtype="text"
          emphasis="ghost"
          trailingIcon={<ChevronDown size={12} />}
          aria-label={`More verbs for arc ${ARC}`}
          onClick={(e) => keepMenu.openMenu((e?.currentTarget as HTMLElement) ?? null)}
        >
          Arc
        </TugPushButton>
      </>
    );
    return {
      inline: null,
      row: cluster,
      menu: keepMenu.menu,
      onContextMenu: contextMenu,
    };
  }

  // icons
  const all = [...(set.act ? [set.act] : []), set.look, ...set.keep];
  const strip = (
    <>
      {all.map((v) => (
        <VerbButton key={v.key} verb={v} form="icon" onPress={fire(v)} />
      ))}
    </>
  );
  return {
    inline: surface === "popup" ? null : strip,
    row: surface === "popup" ? strip : null,
    menu: null,
  };
}

// ---------------------------------------------------------------------------
// The three surfaces
// ---------------------------------------------------------------------------

function ArcsCardFrame(props: FrameProps): React.ReactElement {
  const [collapsed, setCollapsed] = useState(true);
  const c = useControls(props);
  const showSteps = !collapsed;
  return (
    <div className="sp-arc-commands-arcs" onContextMenu={c.onContextMenu}>
      <ArcLifecycleBlock
        name={ARC}
        worker={WORKER}
        model={props.m.model}
        lineTrailing={
          <>
            {c.inline}
            <Fold collapsed={collapsed} onToggle={setCollapsed} />
          </>
        }
      />
      {c.row !== null ? <div className="sp-arc-commands-row">{c.row}</div> : null}
      {showSteps ? (
        <TugPopupListFrame kind="item" className="sp-arc-commands-steps">
          <ArcStepItems steps={props.m.steps} live={props.m.model.live} />
        </TugPopupListFrame>
      ) : null}
      {c.menu}
    </div>
  );
}

function PopupFrame(props: FrameProps): React.ReactElement {
  const c = useControls(props);
  return (
    <div className="sp-arc-commands-popup" onContextMenu={c.onContextMenu}>
      <TugPopupListFrame
        kind="item"
        title="ARC"
        footer={
          c.row !== null ? (
            <TugPopupListFooter>
              <span className="sp-arc-commands-row" data-in="footer">
                {c.row}
              </span>
            </TugPopupListFooter>
          ) : undefined
        }
      >
        <TugPopupListScroller>
          <div className="sp-arc-commands-popup-head">
            <ArcLifecycleBlock
              name={ARC}
              worker={WORKER}
              model={props.m.model}
              troublePlacement="mark"
            />
          </div>
          <ArcStepItems steps={props.m.steps} live={props.m.model.live} />
        </TugPopupListScroller>
      </TugPopupListFrame>
      {c.menu}
    </div>
  );
}

function ChangesFrame(props: FrameProps): React.ReactElement {
  const [collapsed, setCollapsed] = useState(true);
  const c = useControls(props);
  return (
    <div className="sp-arc-commands-changes" onContextMenu={c.onContextMenu}>
      <TugLabel size="2xs" emphasis="calm" className="sp-arc-commands-lane-label">
        ARC BOUND TO THIS SESSION
      </TugLabel>
      <ArcLifecycleBlock
        name={ARC}
        worker={WORKER}
        model={props.m.model}
        trailing={
          <>
            {c.inline}
            <Fold collapsed={collapsed} onToggle={setCollapsed} />
          </>
        }
      />
      {c.row !== null ? <div className="sp-arc-commands-row">{c.row}</div> : null}
      {!collapsed ? (
        <div className="sp-arc-commands-lane-detail">
          DOCUMENTS · ROUNDS — unchanged by this spike
        </div>
      ) : null}
      {c.menu}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The spike
// ---------------------------------------------------------------------------

const TREATMENTS: TugChoiceItem[] = [
  { value: "shipped", label: "As shipped" },
  { value: "verb-row", label: "Verb row" },
  { value: "act-menu", label: "Act + Arc ▾" },
  { value: "icons", label: "Icons" },
];

const STATES: TugChoiceItem[] = [
  { value: "briefed", label: "Briefed" },
  { value: "executing", label: "Executing" },
  { value: "stopped", label: "Stopped" },
  { value: "ready", label: "Ready to join" },
];

function SpikeArcCommands(): React.ReactElement {
  const [treatment, setTreatment] = useState<Treatment>("verb-row");
  const [state, setState] = useState<ArcState>("executing");
  const [last, setLast] = useState<string>("—");
  const treatmentId = useId();
  const stateId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    selectValue: {
      [treatmentId]: (v) => setTreatment(v as Treatment),
      [stateId]: (v) => setState(v as ArcState),
    },
  });
  const m = useMemo(() => moment(state), [state]);
  const press = useCallback<Press>(
    (surface, verb) => setLast(`${verb} · from the ${SURFACE_NAME[surface]}`),
    [],
  );
  const frame = { treatment, state, m, press };
  // Remount the frames on a treatment or state change so each starts folded.
  const key = `${treatment}:${state}`;

  return (
    <ResponderScope>
      <div
        className="sp-content sp-arc-commands"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        <section className="sp-section">
          <h2 className="sp-section-title">One verb set, three surfaces</h2>
          <div className="sp-arc-commands-controls">
            <TugChoiceGroup
              items={TREATMENTS}
              value={treatment}
              senderId={treatmentId}
              size="sm"
            />
            <TugChoiceGroup items={STATES} value={state} senderId={stateId} size="sm" />
          </div>
          <p className="sp-arc-commands-caption">{TREATMENT_BLURB[treatment]}</p>
          <p className="sp-arc-commands-readout">
            Last press: <span>{last}</span>
          </p>
        </section>

        <section className="sp-section" key={key}>
          <h2 className="sp-section-title">Arcs card · sidebar width</h2>
          <ArcsCardFrame surface="arcs" {...frame} />
          <h2 className="sp-section-title">ARC popup · Z2 status cell</h2>
          <PopupFrame surface="popup" {...frame} />
          <h2 className="sp-section-title">Changes shade · arc lane</h2>
          <ChangesFrame surface="changes" {...frame} />
        </section>

        <section className="sp-section">
          <h2 className="sp-section-title">The order, fixed once</h2>
          <ol className="sp-arc-commands-order">
            <li>
              <b>The act</b> — the arc's next move, whichever its state names:
              Start, Stop, Resume, or Join. Outlined; it leads. (Join from a row
              is new — today it is composer-only.)
            </li>
            <li>
              <b>The look</b> — <TugArcAtom name={ARC} /> seen elsewhere: Show in
              Changes, or the arc's diff when you are already in Changes.
            </li>
            <li>
              <b>The housekeeping</b> — Unbind (or Bind), Replay onto main,
              Discard. Discard absorbs today's "Delete documents" on a
              branchless arc.
            </li>
            <li>The fold cue stays the surface's own, at the trailing edge.</li>
          </ol>
        </section>
      </div>
    </ResponderScope>
  );
}

export const spike: SpikeDef = {
  name: "arc-commands",
  title: "Arc Commands",
  blurb:
    "Can one verb set, in one order and one form, ride the Arcs card, the ARC popup and the Changes shade?",
  icon: "GitBranch",
  size: {
    min: { width: 480, height: 420 },
    preferred: { width: 760, height: 820 },
  },
  component: () => <SpikeArcCommands />,
};
