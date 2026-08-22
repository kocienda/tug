/**
 * spike-deck-wayfinding.tsx — the column badges, round five: the superimposed
 * form, down-selected and tuned for legibility.
 *
 * The pair must read as ONE two-character coordinate: slot badge then column
 * badge — `1A`, `2C`. So the column badge is the slot badge's exact footprint
 * with the letter set exactly as the slot badge sets its number — same size,
 * same weight, same centering, same ink — and the glyph sits BEHIND the
 * letter as quiet scenery: the three-slice stack or the three-rung H, with
 * the lit element said by an accent OUTLINE, never a fill, so it can't
 * compete with the letter for the foreground.
 *
 * The lit element follows the position rule: top when this card is on top,
 * bottom when it is at the bottom, middle for everything in between. A is
 * the top of a stack and the topmost band of a split. The cluster badges are
 * live — click one to cycle the mock card through its column.
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
  /** This card's place in its column. 0 = top of a stack, topmost band. */
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
    label: "Top of a stack",
    blurb: "Slot 2 stacks three; this card is on top — reads 2A.",
    slots: 4,
    slot: 1,
    col: { mode: "stack", members: 3 },
    position: 0,
  },
  {
    label: "Buried",
    blurb: "Slot 2 stacks three; this card is second — reads 2B.",
    slots: 4,
    slot: 1,
    col: { mode: "stack", members: 3 },
    position: 1,
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

/** Which of the glyph's three elements is lit: top when this card is on top,
 *  bottom when it is at the bottom, middle for everything in between. */
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
 * lit slice takes the accent as an OUTLINE; every fill is the canvas colour,
 * there only so the slices occlude one another the way real layers do.
 */
function StackGlyph({ lit }: { lit: "top" | "middle" | "bottom" }): React.ReactElement {
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
          data-lit={key === lit ? "true" : undefined}
          points={`9,${dy} 17.5,${dy + 4.5} 9,${dy + 9} 0.5,${dy + 4.5}`}
        />
      ))}
    </svg>
  );
}

/**
 * The split glyph: an `H` with three horizontal rungs. The lit rung takes the
 * accent stroke; everything is already an outline, so the rule and the look
 * agree by construction.
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
 * The column badge — the letter set as the slot badge sets its number,
 * the glyph behind it
 * ---------------------------------------------------------------------------*/

function ColumnBadgeChip({
  mode,
  members,
  position,
  onCycle,
}: {
  mode: "stack" | "split";
  members: number;
  position: number;
  onCycle?: () => void;
}): React.ReactElement {
  const lit = litOf(members, position);
  const Tag = onCycle === undefined ? "span" : "button";
  return (
    <Tag
      type={onCycle === undefined ? undefined : "button"}
      className="sdw-badge"
      aria-label={
        onCycle === undefined
          ? undefined
          : `${mode === "stack" ? "Stacked" : "Split"}, ${letterOf(position)} of ${members} — cycle`
      }
      onClick={onCycle}
    >
      {mode === "stack" ? <StackGlyph lit={lit} /> : <LadderGlyph lit={lit} />}
      <span className="sdw-badge-letter">{letterOf(position)}</span>
    </Tag>
  );
}

/* ---------------------------------------------------------------------------
 * Specimens
 * ---------------------------------------------------------------------------*/

/** A slot chip and a column badge, read together — the `1A` test. */
function ReadingPair({
  slot,
  mode,
  members,
  position,
}: {
  slot: number;
  mode: "stack" | "split";
  members: number;
  position: number;
}): React.ReactElement {
  return (
    <span className="sdw-cluster-mock">
      <TugSlot number={slot + 1} state="rest" size="sm" />
      <ColumnBadgeChip mode={mode} members={members} position={position} />
    </span>
  );
}

/** The assembled cluster for one scenario, with a live position. */
function ClusterSpecimen({ scenario }: { scenario: Scenario }): React.ReactElement {
  const [position, setPosition] = useState(scenario.position);
  const cycle = (): void => setPosition((p) => (p + 1) % scenario.col.members);
  return (
    <div className="sdw-specimen">
      <div className="sdw-specimen-title">{scenario.label}</div>
      <div className="sdw-specimen-blurb">{scenario.blurb}</div>
      <span className="sdw-cluster-mock">
        <TugSlot number={scenario.slot + 1} state="rest" size="sm" />
        {scenario.col.members > 1 && scenario.col.mode !== "single" ? (
          <ColumnBadgeChip
            mode={scenario.col.mode}
            members={scenario.col.members}
            position={position}
            onCycle={cycle}
          />
        ) : null}
      </span>
      <div className="sdw-readout">
        slot {scenario.slot + 1}
        {scenario.col.members > 1
          ? ` · ${scenario.col.mode} ${letterOf(position)} of ${
              scenario.col.members
            }`
          : " · alone"}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * The card
 * ---------------------------------------------------------------------------*/

const CASES: ReadonlyArray<{ label: string; members: number; position: number }> = [
  { label: "A of 3 — top lit", members: 3, position: 0 },
  { label: "B of 3 — middle lit", members: 3, position: 1 },
  { label: "C of 3 — bottom lit", members: 3, position: 2 },
  { label: "B of 4 — middle lit", members: 4, position: 1 },
];

function SpikeDeckWayfinding(): React.ReactElement {
  return (
    <div className="sp-content">
      <section className="sp-section">
        <h2 className="sp-section-title">The badge — letter first, glyph behind</h2>
        <p className="sdw-prose">
          Down-selected to the superimposed form. The letter is set exactly as
          the slot badge sets its number — same size, same weight, same
          centering, same ink — so the pair reads as one coordinate: 1A, 2C.
          The glyph recedes to scenery, and the lit element is an accent
          outline, never a fill, so nothing behind the letter competes with
          it.
        </p>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">Stack badge — three slices</h2>
        <div className="sdw-grid">
          {CASES.map(({ label, members, position }) => (
            <div className="sdw-specimen" key={label}>
              <div className="sdw-specimen-title">{label}</div>
              <span className="sdw-case-row">
                <ColumnBadgeChip
                  mode="stack"
                  members={members}
                  position={position}
                />
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">Split badge — three rungs</h2>
        <div className="sdw-grid">
          {CASES.map(({ label, members, position }) => (
            <div className="sdw-specimen" key={label}>
              <div className="sdw-specimen-title">{label}</div>
              <span className="sdw-case-row">
                <ColumnBadgeChip
                  mode="split"
                  members={members}
                  position={position}
                />
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">The reading test — 1A, 2C</h2>
        <p className="sdw-prose">
          Slot chip and column badge side by side at true size, the way the
          cluster will show them. The pair should read as a two-character
          coordinate at a glance.
        </p>
        <span className="sdw-case-row">
          <ReadingPair slot={0} mode="stack" members={3} position={0} />
          <ReadingPair slot={1} mode="stack" members={3} position={2} />
          <ReadingPair slot={2} mode="split" members={2} position={1} />
          <ReadingPair slot={3} mode="split" members={3} position={1} />
        </span>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">The cluster, assembled</h2>
        <p className="sdw-prose">
          The five scenarios on the mock cluster ground. The column badges are
          live: click one to cycle the mock card through its column.
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
                  {scenario.col.mode !== "single" ? (
                    <ColumnBadgeChip
                      mode={scenario.col.mode}
                      members={scenario.col.members}
                      position={scenario.position}
                    />
                  ) : null}
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
    "The superimposed column badge: the position letter set like the slot number, over an outline-lit glyph.",
  icon: "Map",
  component: () => <SpikeDeckWayfinding />,
};
