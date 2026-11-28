/**
 * spike-cycle-surfaces.tsx — one cycle, drawn on both of the surfaces that
 * show one: the Session card's cycle shade and the Cycles & Arcs sidebar
 * card.
 *
 * The two shipped surfaces drifted apart. Each reads the cycle through its
 * own projection (`session-cycle-shade-model` and `arcs-projection`) and
 * draws its rows with its own components, so a feature added to one is
 * missing from, or different on, the other. The worst of it: the shade looks
 * an entry's arc up among arcs with a branch only, so a running arc that is
 * still a brief or a plan draws no track on its tile and says "Running" in
 * place of its phase, while the card, which also looks among plans, draws
 * both.
 *
 * This section draws the one design: a single component, `CycleSurface`,
 * renders both hosts from the same rows. The host changes only the density
 * (the map's size, the row's padding and type) and the fold control's verb
 * (the shade lowers, the card folds). The feature list above the two frames
 * says, for every feature, what each surface does today and what both do in
 * the one design.
 *
 * Every piece is a shipped component: `CycleMap` (with `TugArcTrack fit` on
 * the running tile), `CycleSeal`, `CycleWaits`, `CycleOnlyBar`,
 * `CycleEntryMark`, `TugListRow`, `TugArcAtom`, `TugAtomRef`,
 * `ArcStepItems`, `ArcLifecycleMark` and the session chip. The verb row is a
 * stand-in for `ArcVerbRow`. Nothing here sends a frame.
 */

import "./spike-cycle-surfaces.css";

import React, { useId, useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { ArcLifecycleMark } from "@/components/tugways/arc-lifecycle-mark";
import { ArcStepItems } from "@/components/tugways/arc-step-list";
import { recordBody } from "@/components/tugways/cards/session-arc-record";
import { cycleListView, pressCycleAsset, pressCycleRow } from "@/components/tugways/cards/session-cycle-shade-model";
import { SessionIdentityView } from "@/components/tugways/cards/session-identity";
import { CycleEntryMark } from "@/components/tugways/cycle-entry-mark";
import { CycleMap, type CycleMapSketch, type CycleMapTile } from "@/components/tugways/cycle-map";
import { entryKey, headsOf, NO_PICKS, sketchKey } from "@/components/tugways/cycle-map-layout";
import { CycleOnlyBar } from "@/components/tugways/cycle-only-bar";
import { CycleSeal } from "@/components/tugways/cycle-seal";
import { CycleWaits } from "@/components/tugways/cycle-waits";
import { TugArcAtom } from "@/components/tugways/tug-arc-atom";
import { arcTrackModel, type ArcTrackModel } from "@/components/tugways/tug-arc-track";
import { TugAtomRef } from "@/components/tugways/tug-atom-ref";
import { TugChoiceGroup, type TugChoiceItem } from "@/components/tugways/tug-choice-group";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import type { ArcStep } from "@/lib/changeset-types";
import { sessionNameStore } from "@/lib/session-name-store";
import { useSessionIdentity } from "@/lib/session-identity";
import { sessionTagStore } from "@/lib/session-tag-store";

// ---------------------------------------------------------------------------
// The feature list
// ---------------------------------------------------------------------------

interface Feature {
  name: string;
  shade: string;
  card: string;
  one: string;
  /** A choice the user has not yet made, drawn as such. */
  decide?: boolean;
}

const FEATURES: readonly Feature[] = [
  {
    name: "Header",
    shade: "Ghost chevron that lowers · CYCLE · name · n of m landed",
    card: "Fold cue · name · n of m landed. No CYCLE label",
    one: "Ghost chevron · CYCLE · name · n of m landed. The chevron lowers the shade and folds the card",
  },
  {
    name: "Map",
    shade: "CycleMap, full size",
    card: "CycleMap, compact",
    one: "The same, at the host's size",
  },
  {
    name: "Running tile",
    shade: "Blank while the arc is still a brief or a plan. The shade finds arcs with a branch only",
    card: "The arc's track, shrunk to fit, step in hand breathing",
    one: "The track on both, from one projection of the cycle that finds plans as well as arcs",
  },
  {
    name: "Sketch row",
    shade: "Seal · SKETCH A · its want · HEADS 1",
    card: "Seal · SKETCH A · its want · HEADS 1 2 3",
    one: "The same row. HEADS lists the entries the sketch starts (1), as the word says; the map's wires show the rest",
  },
  {
    name: "Arc row, closed",
    shade: "Number · ARC title · arc atom and “this session” (or the session) on a second line",
    card: "Number · ARC title · “in” and the session on a second line, while running. No arc atom",
    one: "Number · ARC title · second line: the arc atom and the session chip, once an arc carries the entry. The small-cap label is never cut; only the title gives way",
  },
  {
    name: "State mark",
    shade: "Its own copy of the mark. A running arc it cannot find reads “Running”",
    card: "CycleEntryMark: a badge, or the arc's lifecycle mark with its phase word",
    one: "CycleEntryMark on both, and a running arc always shows its phase",
  },
  {
    name: "Waits on",
    shade: "Only when the row is open",
    card: "On the closed row of a waiting entry",
    one: "On the closed row of a waiting entry, on both",
  },
  {
    name: "Arc row, open",
    shade: "Steps · brief file · waits · note · this session's own verbs",
    card: "Steps or a sentence · session · arc atom · brief file · verbs for any live arc · join register",
    one: "Steps, or the sentence where it stands · brief file · note · the arc's verbs, in this order on both",
  },
  {
    name: "Several open",
    shade: "A Back bar with a hint line",
    card: "CycleOnlyBar",
    one: "CycleOnlyBar on both",
  },
  {
    name: "Now and Next",
    shade: "Two footer lines: what this session runs, what is ready next",
    card: "None",
    one: "On both. The card's Now reads the session it follows",
  },
  {
    name: "Folding",
    shade: "The whole shade lowers",
    card: "The map folds to a strip of states",
    one: "Kept as each host's own: a shade lowers, a sidebar section folds",
  },
];

function FeatureList(): React.ReactElement {
  return (
    <table className="sp-cyc-features">
      <thead>
        <tr>
          <th>Feature</th>
          <th>Shade today</th>
          <th>Card today</th>
          <th>One design, both</th>
        </tr>
      </thead>
      <tbody>
        {FEATURES.map((f) => (
          <tr key={f.name} data-decide={f.decide || undefined}>
            <th scope="row">{f.name}</th>
            <td>{f.shade}</td>
            <td>{f.card}</td>
            <td>
              {f.decide ? <span className="sp-cyc-decide">Your call · </span> : null}
              {f.one}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// The fixture — the cycle in the screenshots, with a ready and a waiting
// entry added so every state is on the page
// ---------------------------------------------------------------------------

const KEEPER = "6a1c0e52-0000-4000-8000-00000c5c0e01";
const OTHER = "b38d41f7-0000-4000-8000-00000c5c0e02";
sessionNameStore.setName(KEEPER, "cycle keeper");
sessionNameStore.setName(OTHER, "work records");
sessionTagStore.setTag(KEEPER, "rosy-petal");
sessionTagStore.setTag(OTHER, "mighty-cabin");

type EntryState = "joined" | "running" | "ready" | "waiting" | "dropped";

interface Entry {
  n: number;
  title: string;
  arc?: string;
  brief: string;
  waits: number[];
  from: string[];
  state: EntryState;
  session?: string;
  note?: string;
}

interface Sketch {
  letter: string;
  want: string;
  text: string;
}

const SKETCHES: readonly Sketch[] = [
  {
    letter: "A",
    want: "Keep a firm grip on every sketch, brief and arc, so a long run of work shows up as one cycle",
    text:
      "Keep a firm grip on every sketch, brief and arc, so a long run of work shows up as one cycle.\n\n" +
      "- One record per kind, each with an id that never changes\n" +
      "- A session's stated run of arcs is read into its cycle\n" +
      "- A model pass tends the cycle from what it can see",
  },
  {
    letter: "B",
    want: "The shade and the sidebar card draw a cycle the same way",
    text: "The shade and the sidebar card draw a cycle the same way, from one projection, with one set of rows.",
  },
];

const STEP_TITLES = [
  "The keeper's evidence reader",
  "The pass and its prompt",
  "Acts written to the cycle",
  "The act log on the record",
  "Wake on a landing",
  "Quiet when nothing moved",
  "Docs and laws",
];

type Moment = "devising" | "implementing";
type Where = "here" | "elsewhere";

function entriesAt(where: Where): Entry[] {
  return [
    {
      n: 1,
      title: "Work records: one model for sketches, briefs, arcs and cycles",
      arc: "work-records",
      brief: "briefs/work-records-brief.md",
      waits: [],
      from: ["A"],
      state: "joined",
    },
    {
      n: 2,
      title: "The work statement: a fence that declares queued arcs",
      arc: "work-statement",
      brief: "briefs/work-statement-brief.md",
      waits: [1],
      from: ["A"],
      state: "joined",
    },
    {
      n: 3,
      title: "The cycle keeper: a model pass that tends a cycle from evidence",
      arc: "cycle-keeper",
      brief: "briefs/cycle-keeper-brief.md",
      waits: [2],
      from: ["A"],
      state: "running",
      session: where === "here" ? KEEPER : OTHER,
    },
    {
      n: 4,
      title: "Cycle surfaces: one projection, one set of rows",
      brief: "briefs/cycle-surfaces-brief.md",
      waits: [2],
      from: ["B"],
      state: "ready",
    },
    {
      n: 5,
      title: "The arc door offers the cycle's next arc",
      brief: "briefs/cycle-surfaces-brief.md",
      waits: [3, 4],
      from: ["A", "B"],
      state: "waiting",
      note: "Needs the keeper's act log",
    },
  ];
}

function stepsAt(moment: Moment): ArcStep[] {
  if (moment === "devising") return [];
  return STEP_TITLES.map((title, i) => ({
    title,
    status: i < 3 ? "done" : i === 3 ? "in progress" : "pending",
  }));
}

function trackAt(moment: Moment): ArcTrackModel {
  const dir = "/u/src/tug/.tug/arcs/cycle-keeper";
  return moment === "devising"
    ? arcTrackModel({
        documents: { brief: `${dir}/brief.md` },
        arcKind: "planned",
        arc: { stage: "devise" },
        stage: null,
        holdersBusy: true,
      })
    : arcTrackModel({
        documents: { brief: `${dir}/brief.md`, plan: `${dir}/plan.md` },
        arcKind: "planned",
        arc: { stage: "implement" },
        stage: "implementing",
        steps: stepsAt(moment),
        holdersBusy: true,
      });
}

/** The one projection both hosts read: the rows, the tiles and the seals. */
interface CycleRead {
  name: string;
  landedText: string;
  entries: readonly Entry[];
  sketches: readonly Sketch[];
  tiles: readonly CycleMapTile[];
  seals: readonly CycleMapSketch[];
  keys: readonly string[];
  track: ArcTrackModel;
  steps: readonly ArcStep[];
  heads: ReadonlyMap<string, readonly number[]>;
}

function readCycle(moment: Moment, where: Where): CycleRead {
  const entries = entriesAt(where);
  const track = trackAt(moment);
  const joined = new Set(entries.filter((e) => e.state === "joined").map((e) => e.n));
  const sources = entries.map((e) => ({ n: e.n, waits: e.waits, from: e.from }));
  const keys: string[] = [];
  for (const e of entries) {
    for (const letter of e.from) {
      const key = sketchKey(letter);
      if (!keys.includes(key)) keys.push(key);
    }
    keys.push(entryKey(e.n));
  }
  return {
    name: "Sketch, brief and arc records",
    landedText: `${joined.size} of ${entries.length} landed`,
    entries,
    sketches: SKETCHES,
    tiles: entries.map((e) => ({
      n: e.n,
      waits: e.waits,
      from: e.from,
      state: e.state,
      elsewhere: e.state === "running" && where === "elsewhere" ? true : undefined,
      track: e.state === "running" ? track : undefined,
      label: `${e.title} · ${e.state}`,
    })),
    seals: SKETCHES.map((s) => ({ letter: s.letter, want: s.want })),
    keys,
    track,
    steps: stepsAt(moment),
    heads: new Map(SKETCHES.map((s) => [s.letter, headsOf(s.letter, sources)])),
  };
}

// ---------------------------------------------------------------------------
// The one surface
// ---------------------------------------------------------------------------

type Host = "shade" | "rail";

function SessionChip({ session }: { session: string }): React.ReactElement {
  const identity = useSessionIdentity(session);
  return <SessionIdentityView identity={identity} tier="chip" arc={false} tooltip={false} onOpen={() => {}} />;
}

/** Stand-in for `ArcVerbRow`: the arc's next step, its view, its housekeeping. */
function Verbs({ entry }: { entry: Entry }): React.ReactElement | null {
  const words =
    entry.state === "running"
      ? ["Changes", "Unbind", "Discard"]
      : entry.state === "ready"
        ? ["Start"]
        : [];
  if (words.length === 0) return null;
  return (
    <span className="sp-cyc-verbs">
      {words.map((w, i) => (
        <TugPushButton
          key={w}
          size="2xs"
          subtype="text"
          emphasis={i === 0 ? "outlined" : "ghost"}
          onClick={(e) => e?.stopPropagation()}
        >
          {w}
        </TugPushButton>
      ))}
    </span>
  );
}

function SketchRow({
  sketch,
  heads,
  open,
  host,
  onChoose,
}: {
  sketch: Sketch;
  heads: readonly number[];
  open: boolean;
  host: Host;
  onChoose: (key: string) => void;
}): React.ReactElement {
  const key = sketchKey(sketch.letter);
  return (
    <div className="sp-cyc-asset" data-kind="sketch" data-open={open || undefined}>
      <TugListRow
        variant="flush"
        density={host === "rail" ? "compact" : undefined}
        selected={open}
        leading={<CycleSeal letter={sketch.letter} />}
        trailing={
          heads.length > 0 ? (
            <CycleWaits label="Heads" items={heads.map((n) => ({ n, met: true }))} checks={false} />
          ) : undefined
        }
        trailingReveal="always"
        onClick={() => onChoose(key)}
      >
        <span className="sp-cyc-content">
          <span className="sp-cyc-title">
            <span className="sp-cyc-eyebrow">Sketch</span>
            <span className="sp-cyc-headline">{sketch.letter}</span>
          </span>
          {open ? null : <span className="sp-cyc-want">{sketch.want}</span>}
        </span>
      </TugListRow>
      {open ? <div className="sp-cyc-sketch-body">{recordBody(sketch.text)}</div> : null}
    </div>
  );
}

function EntryRow({
  entry,
  read,
  open,
  host,
  onChoose,
}: {
  entry: Entry;
  read: CycleRead;
  open: boolean;
  host: Host;
  onChoose: (key: string) => void;
}): React.ReactElement {
  const key = entryKey(entry.n);
  const joined = new Set(read.entries.filter((e) => e.state === "joined").map((e) => e.n));
  const carried = entry.arc !== undefined && (entry.state === "running" || entry.state === "joined");
  const model = entry.state === "running" ? read.track : null;
  const facts =
    carried || entry.session !== undefined ? (
      <span className="sp-cyc-line">
        {carried ? <TugArcAtom name={entry.arc!} /> : null}
        {entry.state === "running" && entry.session !== undefined ? <SessionChip session={entry.session} /> : null}
      </span>
    ) : null;
  const waits =
    entry.state === "waiting" && entry.waits.length > 0 ? (
      <span className="sp-cyc-line">
        <CycleWaits label="Waits on" items={entry.waits.map((n) => ({ n, met: joined.has(n) }))} />
      </span>
    ) : null;
  const sentence =
    entry.state === "joined"
      ? "Landed. Its rounds and commit stay on record."
      : entry.state === "dropped"
        ? "Dropped. Starting its brief again brings it back."
        : entry.state === "ready"
          ? "Ready to start: everything it waits on has landed."
          : entry.state === "waiting"
            ? "Waiting on the entries above."
            : read.steps.length === 0
              ? "Devising its plan. Its steps appear once the plan is written."
              : null;
  return (
    <div className="sp-cyc-asset" data-kind="entry" data-state={entry.state} data-open={open || undefined}>
      <TugListRow
        variant="flush"
        density={host === "rail" ? "compact" : undefined}
        selected={open}
        leading={<span className="sp-cyc-number">{entry.n}</span>}
        trailing={<CycleEntryMark state={entry.state} model={model} name={entry.arc ?? entry.title} />}
        trailingReveal="always"
        onClick={() => onChoose(key)}
      >
        <span className="sp-cyc-content">
          <span className="sp-cyc-title">
            <span className="sp-cyc-eyebrow">Arc</span>
            <span className="sp-cyc-headline">{entry.title}</span>
          </span>
          {facts !== null || waits !== null || open ? (
            <span className="sp-cyc-facts">
              {facts}
              {waits}
              {open ? (
                <>
                  {entry.state === "running" && read.steps.length > 0 ? (
                    <span className="sp-cyc-steps">
                      <ArcStepItems steps={read.steps} live />
                    </span>
                  ) : sentence !== null ? (
                    <span className="sp-cyc-line sp-cyc-quiet">{sentence}</span>
                  ) : null}
                  <span className="sp-cyc-line">
                    <TugAtomRef entity={{ kind: "file", path: entry.brief }} />
                  </span>
                  {entry.note !== undefined ? <span className="sp-cyc-line sp-cyc-note">{entry.note}</span> : null}
                  <Verbs entry={entry} />
                </>
              ) : null}
            </span>
          ) : null}
        </span>
      </TugListRow>
    </div>
  );
}

function Footer({ read, host }: { read: CycleRead; host: Host }): React.ReactElement {
  const running = read.entries.find((e) => e.state === "running");
  const ready = read.entries.find((e) => e.state === "ready");
  const here = running !== undefined && running.session === KEEPER;
  return (
    <div className="sp-cyc-footer" data-host={host}>
      <div className="sp-cyc-footer-line">
        <span className="sp-cyc-eyebrow sp-cyc-footer-word">Now</span>
        {here && running !== undefined ? (
          <span className="sp-cyc-footer-what">
            <span className="sp-cyc-headline">{running.title}</span>
            <ArcLifecycleMark model={read.track} name={running.arc ?? ""} size="rail" showWord />
          </span>
        ) : (
          <span className="sp-cyc-quiet">
            {host === "rail" ? "The followed session runs nothing here" : "This session runs nothing here"}
          </span>
        )}
      </div>
      <div className="sp-cyc-footer-line">
        <span className="sp-cyc-eyebrow sp-cyc-footer-word">Next</span>
        {ready !== undefined ? (
          <span className="sp-cyc-footer-what">
            <span className="sp-cyc-headline">{ready.title}</span>
          </span>
        ) : (
          <span className="sp-cyc-quiet">Nothing is ready until an arc lands</span>
        )}
      </div>
    </div>
  );
}

/** One cycle, on either host. Only density and the fold control's verb differ. */
function CycleSurface({ read, host }: { read: CycleRead; host: Host }): React.ReactElement {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(NO_PICKS);
  const [folded, setFolded] = useState(false);
  const view = cycleListView(read.keys, chosen);
  const entryByKey = new Map(read.entries.map((e) => [entryKey(e.n), e]));
  const sketchByKey = new Map(read.sketches.map((s) => [sketchKey(s.letter), s]));
  const choose = (key: string) => setChosen((prev) => pressCycleRow(prev, key));
  const verb = host === "shade" ? "Lower the cycle" : folded ? "Show the map" : "Hide the map";
  return (
    <div className="sp-cyc-surface" data-host={host} data-folded={folded || undefined}>
      <div className="sp-cyc-header">
        <TugTooltip content={verb}>
          <TugPushButton
            size="xs"
            subtype="icon"
            emphasis="ghost"
            icon={host === "rail" && !folded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            aria-label={verb}
            onClick={() => (host === "rail" ? setFolded((f) => !f) : undefined)}
          />
        </TugTooltip>
        <span className="sp-cyc-eyebrow">Cycle</span>
        <span className="sp-cyc-name">{read.name}</span>
        <span className="sp-cyc-spacer" />
        <span className="sp-cyc-landed">{read.landedText}</span>
      </div>
      {folded ? (
        <div className="sp-cyc-strip" aria-hidden="true">
          {read.entries.map((e) => (
            <span key={e.n} data-state={e.state} />
          ))}
        </div>
      ) : (
        <>
          <div className="sp-cyc-well">
            <CycleMap
              tiles={read.tiles}
              sketches={read.seals}
              size={host === "shade" ? "full" : "compact"}
              chosen={chosen}
              onPress={(key, shift) => setChosen((prev) => pressCycleAsset(prev, key, shift))}
              onClear={() => setChosen(NO_PICKS)}
            />
          </div>
          {view.narrowed ? (
            <CycleOnlyBar className="sp-cyc-only" count={chosen.size} onBack={() => setChosen(NO_PICKS)} />
          ) : null}
          <div className="sp-cyc-list">
            {view.shown.map((key) => {
              const entry = entryByKey.get(key);
              if (entry !== undefined) {
                return (
                  <EntryRow
                    key={key}
                    entry={entry}
                    read={read}
                    open={chosen.has(key)}
                    host={host}
                    onChoose={choose}
                  />
                );
              }
              const sketch = sketchByKey.get(key);
              return sketch !== undefined ? (
                <SketchRow
                  key={key}
                  sketch={sketch}
                  heads={read.heads.get(sketch.letter) ?? []}
                  open={chosen.has(key)}
                  host={host}
                  onChoose={choose}
                />
              ) : null;
            })}
          </div>
          <Footer read={read} host={host} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

const MOMENT_ITEMS: TugChoiceItem[] = [
  { value: "devising", label: "Arc 3 devising" },
  { value: "implementing", label: "Arc 3 on step 4 of 7" },
];

const WHERE_ITEMS: TugChoiceItem[] = [
  { value: "here", label: "Running in this session" },
  { value: "elsewhere", label: "Running in another" },
];

export function CycleSurfaces(): React.ReactElement {
  const [moment, setMoment] = useState<Moment>("devising");
  const [where, setWhere] = useState<Where>("here");
  const momentId = useId();
  const whereId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    selectValue: {
      [momentId]: (v) => setMoment(v as Moment),
      [whereId]: (v) => setWhere(v as Where),
    },
  });
  const read = useMemo(() => readCycle(moment, where), [moment, where]);
  return (
    <ResponderScope>
      <div className="sp-cyc" ref={responderRef as (el: HTMLDivElement | null) => void}>
        <FeatureList />
        <div className="sp-cyc-controls">
          <TugChoiceGroup items={MOMENT_ITEMS} value={moment} senderId={momentId} size="sm" />
          <TugChoiceGroup items={WHERE_ITEMS} value={where} senderId={whereId} size="sm" />
        </div>
        <div className="sp-cyc-hosts">
          <figure className="sp-cyc-host sp-cyc-host-shade">
            <figcaption>Session card · the cycle shade</figcaption>
            <div className="sp-cyc-shade-frame">
              <CycleSurface key={`${moment}-${where}`} read={read} host="shade" />
            </div>
          </figure>
          <figure className="sp-cyc-host">
            <figcaption>Cycles &amp; Arcs sidebar card</figcaption>
            <div className="sp-cyc-rail-frame">
              <div className="sp-cyc-rail-title">Cycles &amp; Arcs</div>
              <CycleSurface key={`${moment}-${where}`} read={read} host="rail" />
            </div>
          </figure>
        </div>
      </div>
    </ResponderScope>
  );
}
