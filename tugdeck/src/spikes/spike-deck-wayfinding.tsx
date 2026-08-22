/**
 * spike-deck-wayfinding.tsx — the column badges, round six: stacks count,
 * splits letter.
 *
 * A logic correction drives this round: the badge lives on a card you can
 * SEE, and a visible card in a stack is by definition the top one — its
 * position letter would always read A, a fact with no information in it. So
 * the stack badge shows the NUMBER OF CARDS in the stack, over the
 * three-slice glyph with the top slice lit (you are the face of the stack).
 * Split bands are all visible at once, so position there is real
 * information, and the split badge keeps its letter — A is the topmost band
 * — over the three-rung H with the lit rung at top, middle, or bottom.
 *
 * Both badges keep the settled form: the slot badge's exact footprint, the
 * character set exactly as the slot badge sets its number, the glyph behind
 * as quiet scenery with an outline-lit accent, and a canvas knockout
 * punching the character clear of the strokes.
 *
 * @module spikes/spike-deck-wayfinding
 */

import "./spike.css";
import "./spike-deck-wayfinding.css";

import React, { useState } from "react";

import { TugSlot } from "@/components/tugways/tug-slot";
import { TugSlotLayout } from "@/components/tugways/tug-slot-layout";
import type { TugSlotState } from "@/components/tugways/tug-slot";
import type { SpikeDef } from "./spike-registry";

/* ---------------------------------------------------------------------------
 * The mock facts
 * ---------------------------------------------------------------------------*/

type ColMode = "single" | "stack" | "split";

interface ColumnModel {
  mode: ColMode;
  members: number;
}

interface Scenario {
  label: string;
  blurb: string;
  slots: number;
  slot: number;
  col: ColumnModel;
  /** This card's band in a split column. 0 = topmost. Meaningless for a
   *  stack, where the visible card is always the top. */
  position: number;
}

const SCENARIOS: readonly Scenario[] = [
  {
    label: "Alone",
    blurb: "Four up; this card alone in slot 2. No column badge at all.",
    slots: 4,
    slot: 1,
    col: { mode: "single", members: 1 },
    position: 0,
  },
  {
    label: "Stack of two",
    blurb: "Slot 2 stacks two; one card behind this one — reads 2·2.",
    slots: 4,
    slot: 1,
    col: { mode: "stack", members: 2 },
    position: 0,
  },
  {
    label: "Stack of three",
    blurb: "Slot 2 stacks three; two cards behind this one — reads 2·3.",
    slots: 4,
    slot: 1,
    col: { mode: "stack", members: 3 },
    position: 0,
  },
  {
    label: "Split, lower",
    blurb: "Slot 3 splits in two; this card is the lower band — reads 3B.",
    slots: 4,
    slot: 2,
    col: { mode: "split", members: 2 },
    position: 1,
  },
  {
    label: "Split, middle",
    blurb: "Slot 1 splits in three; this card is the middle band — reads 1B.",
    slots: 4,
    slot: 0,
    col: { mode: "split", members: 3 },
    position: 1,
  },
];

/** Position 0, 1, 2 … as A, B, C …. */
function letterOf(position: number): string {
  return String.fromCharCode(65 + position);
}

/** Which rung is lit for a split band: top when this card is the topmost
 *  band, bottom when it is the last, middle for everything in between. */
function litOf(members: number, position: number): "top" | "middle" | "bottom" {
  if (position === 0) return "top";
  if (position === members - 1) return "bottom";
  return "middle";
}

/* ---------------------------------------------------------------------------
 * The glyphs — three slices, and the three-rung H
 * ---------------------------------------------------------------------------*/

/**
 * The stack glyph: three flattened diamond slices, deepest drawn first. The
 * top slice is always the lit one — the badge stands on the card that IS the
 * top of its stack. Outline accent, canvas fills for occlusion only.
 */
function StackGlyph(): React.ReactElement {
  const slices: ReadonlyArray<{ key: "bottom" | "middle" | "top"; dy: number }> = [
    { key: "bottom", dy: 11 },
    { key: "middle", dy: 5.5 },
    { key: "top", dy: 0 },
  ];
  return (
    <svg
      className="sdw-glyph"
      viewBox="0 0 18 20"
      aria-hidden="true"
      focusable="false"
    >
      {slices.map(({ key, dy }) => (
        <polygon
          key={key}
          className="sdw-slice"
          data-lit={key === "top" ? "true" : undefined}
          points={`9,${dy} 17.5,${dy + 4.5} 9,${dy + 9} 0.5,${dy + 4.5}`}
        />
      ))}
    </svg>
  );
}

/**
 * The split glyph: an `H` with three horizontal rungs, run the badge's full
 * height so the lit end rungs sit at the badge's own ends.
 */
function LadderGlyph({ lit }: { lit: "top" | "middle" | "bottom" }): React.ReactElement {
  const rungs: ReadonlyArray<{ key: "top" | "middle" | "bottom"; y: number }> = [
    { key: "top", y: 2 },
    { key: "middle", y: 11 },
    { key: "bottom", y: 20 },
  ];
  return (
    <svg
      className="sdw-glyph sdw-glyph-ladder"
      viewBox="0 0 18 22"
      aria-hidden="true"
      focusable="false"
    >
      <line className="sdw-rail" x1="1.5" y1="1" x2="1.5" y2="21" />
      <line className="sdw-rail" x1="16.5" y1="1" x2="16.5" y2="21" />
      {rungs.map(({ key, y }) => (
        <line
          key={key}
          className="sdw-rung"
          data-lit={key === lit ? "true" : undefined}
          x1="1.5"
          y1={y}
          x2="16.5"
          y2={y}
        />
      ))}
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * The column badges
 * ---------------------------------------------------------------------------*/

/** The stack badge: the COUNT of cards in the stack over the stack glyph. */
function StackBadge({ members }: { members: number }): React.ReactElement {
  return (
    <span className="sdw-badge" aria-label={`A stack of ${members}`}>
      <StackGlyph />
      <span className="sdw-badge-letter">{members}</span>
    </span>
  );
}

/** The split badge: this card's band LETTER over the three-rung H, the lit
 *  rung saying top, middle, or bottom. Live when given `onCycle`. */
function SplitBadge({
  members,
  position,
  onCycle,
}: {
  members: number;
  position: number;
  onCycle?: () => void;
}): React.ReactElement {
  const Tag = onCycle === undefined ? "span" : "button";
  return (
    <Tag
      type={onCycle === undefined ? undefined : "button"}
      className="sdw-badge"
      aria-label={
        onCycle === undefined
          ? `Split, band ${letterOf(position)} of ${members}`
          : `Split, band ${letterOf(position)} of ${members} — cycle`
      }
      onClick={onCycle}
    >
      <LadderGlyph lit={litOf(members, position)} />
      <span className="sdw-badge-letter">{letterOf(position)}</span>
    </Tag>
  );
}

function ColumnBadge({
  col,
  position,
  onCycle,
}: {
  col: ColumnModel;
  position: number;
  onCycle?: () => void;
}): React.ReactElement | null {
  if (col.mode === "single" || col.members <= 1) return null;
  if (col.mode === "stack") return <StackBadge members={col.members} />;
  return <SplitBadge members={col.members} position={position} onCycle={onCycle} />;
}

/* ---------------------------------------------------------------------------
 * Specimens
 * ---------------------------------------------------------------------------*/

/** A slot chip and a column badge, read together — the `1A` test. */
function ReadingPair({
  slot,
  col,
  position,
}: {
  slot: number;
  col: ColumnModel;
  position: number;
}): React.ReactElement {
  return (
    <span className="sdw-cluster-mock">
      <TugSlot number={slot + 1} state="rest" size="sm" />
      <ColumnBadge col={col} position={position} />
    </span>
  );
}

/** The assembled cluster for one scenario. A split badge is live — click it
 *  to cycle the mock card through the column's bands. */
function ClusterSpecimen({ scenario }: { scenario: Scenario }): React.ReactElement {
  const [position, setPosition] = useState(scenario.position);
  const cycle = (): void => setPosition((p) => (p + 1) % scenario.col.members);
  return (
    <div className="sdw-specimen">
      <div className="sdw-specimen-title">{scenario.label}</div>
      <div className="sdw-specimen-blurb">{scenario.blurb}</div>
      <span className="sdw-cluster-mock">
        <TugSlot number={scenario.slot + 1} state="rest" size="sm" />
        <ColumnBadge
          col={scenario.col}
          position={position}
          onCycle={scenario.col.mode === "split" ? cycle : undefined}
        />
      </span>
      <div className="sdw-readout">
        slot {scenario.slot + 1}
        {scenario.col.mode === "stack"
          ? ` · stack of ${scenario.col.members}`
          : scenario.col.mode === "split"
            ? ` · split ${letterOf(position)} of ${scenario.col.members}`
            : " · alone"}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * The card
 * ---------------------------------------------------------------------------*/

const STACK_CASES: ReadonlyArray<{ label: string; members: number }> = [
  { label: "Stack of 2", members: 2 },
  { label: "Stack of 3", members: 3 },
  { label: "Stack of 4", members: 4 },
];

const SPLIT_CASES: ReadonlyArray<{ label: string; members: number; position: number }> = [
  { label: "A of 3 — top lit", members: 3, position: 0 },
  { label: "B of 3 — middle lit", members: 3, position: 1 },
  { label: "C of 3 — bottom lit", members: 3, position: 2 },
  { label: "B of 4 — middle lit", members: 4, position: 1 },
];

function SpikeDeckWayfinding(): React.ReactElement {
  return (
    <div className="sp-content">
      <section className="sp-section">
        <h2 className="sp-section-title">The badges — stacks count, splits letter</h2>
        <p className="sdw-prose">
          The badge stands on a card you can see, and a visible card in a
          stack is by definition the top one — its letter would always read
          A. So the stack badge shows how many cards the stack holds, top
          slice lit: you are the face of that many. Split bands are all
          visible at once, so position there is real information: the split
          badge keeps its letter, with the lit rung at top, middle, or
          bottom. Same footprint, same character setting, same outline-lit
          scenery as before.
        </p>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">Stack badge — the count, top slice lit</h2>
        <div className="sdw-grid">
          {STACK_CASES.map(({ label, members }) => (
            <div className="sdw-specimen" key={label}>
              <div className="sdw-specimen-title">{label}</div>
              <span className="sdw-case-row">
                <StackBadge members={members} />
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">Split badge — the band letter, three rungs</h2>
        <div className="sdw-grid">
          {SPLIT_CASES.map(({ label, members, position }) => (
            <div className="sdw-specimen" key={label}>
              <div className="sdw-specimen-title">{label}</div>
              <span className="sdw-case-row">
                <SplitBadge members={members} position={position} />
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">The reading test — 2·3, 3B</h2>
        <p className="sdw-prose">
          Slot chip and column badge side by side at true size. A stack pair
          is two numerals — 2 then 3 — with the slice glyph between them
          carrying the "of a stack" sense; whether that reads cleanly or the
          two numbers blur into one fact is exactly what this row is for.
        </p>
        <span className="sdw-case-row">
          <ReadingPair slot={0} col={{ mode: "stack", members: 3 }} position={0} />
          <ReadingPair slot={1} col={{ mode: "stack", members: 2 }} position={0} />
          <ReadingPair slot={2} col={{ mode: "split", members: 2 }} position={1} />
          <ReadingPair slot={3} col={{ mode: "split", members: 3 }} position={1} />
        </span>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">The cluster, assembled</h2>
        <p className="sdw-prose">
          The five scenarios on the mock cluster ground. Split badges are
          live — click one to cycle the mock card through the column's bands.
        </p>
        <div className="sdw-grid">
          {SCENARIOS.map((scenario) => (
            <ClusterSpecimen scenario={scenario} key={scenario.label} />
          ))}
        </div>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">On a Lens row</h2>
        <p className="sdw-prose">
          The run of slot numbers stays as it is; the column badge follows it
          when the card's column has structure.
        </p>
        <div className="sdw-grid">
          {[SCENARIOS[2], SCENARIOS[4]].map((scenario) =>
            scenario === undefined ? null : (
              <div className="sdw-specimen" key={scenario.label}>
                <div className="sdw-specimen-title">{scenario.label}</div>
                <div className="sdw-specimen-blurb">{scenario.blurb}</div>
                <span className="sdw-mock-row">
                  <span className="sdw-mock-row-title">dash+join-xp</span>
                  <TugSlotLayout
                    className="sdw-lens-run"
                    count={scenario.slots}
                    states={Array.from(
                      { length: scenario.slots },
                      (_, slot): TugSlotState =>
                        slot === scenario.slot
                          ? scenario.position === 0
                            ? "filled"
                            : "outlined"
                          : "rest",
                    )}
                  />
                  <ColumnBadge col={scenario.col} position={scenario.position} />
                </span>
              </div>
            ),
          )}
        </div>
      </section>
    </div>
  );
}

export const spike: SpikeDef = {
  name: "deck-wayfinding",
  title: "Deck Wayfinding",
  blurb:
    "Column badges at slot-badge size: a stack shows its count over lit slices, a split shows its band letter over rungs.",
  icon: "Map",
  component: () => <SpikeDeckWayfinding />,
};
