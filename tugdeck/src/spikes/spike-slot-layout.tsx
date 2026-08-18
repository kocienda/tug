/**
 * spike-slot-layout.tsx — design proposals for the Lens **Layouts** picker.
 *
 * A spike, not a component demo. The question it exists to answer: how should
 * the Lens communicate the imposition choices — Off, Two Up, Three Up, Four Up
 * — so the arrangement is obvious before you commit to it?
 *
 * The strongest precedent is Windows 11's Snap Layouts: each option is a
 * **scale miniature of the surface you are about to arrange**, subdivided into
 * solid zones, and you pick the picture that looks like what you want. Adobe's
 * new-document presets and Figma's grid picker do the same thing — the option
 * is a picture of the result, never a description of it. The four proposals
 * below all take that turn to some degree; they differ in how much of the real
 * deck each miniature admits to.
 *
 * Every proposal renders at `LENS_WIDTH`, inside a mock Lens section band, so
 * the comparison is at true size rather than at gallery size.
 *
 * @module components/tugways/cards/gallery-slot-layout
 */

import "./spike.css";
import type { SpikeDef } from "./spike-registry";
import "./spike-slot-layout.css";

import React, { useState } from "react";

import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";
import { TugSlotLayout } from "@/components/tugways/tug-slot-layout";
import type { TugSlotState } from "@/components/tugways/tug-slot";

/** The Lens rail's real width, so every proposal is judged at true size. */
const LENS_WIDTH = 400;

/** Miniature proportions, in percent of its width: the rail, a card at its
 *  natural size, and the imposition gap. */
const RAIL_PCT = 18;
const CARD_PCT = 26;
const GAP_PCT = 2;

/** The choices, in the order the Lens offers them. `0` is Off. */
const CHOICES: ReadonlyArray<{ count: number; label: string }> = [
  { count: 0, label: "Off" },
  { count: 2, label: "Two Up" },
  { count: 3, label: "Three Up" },
  { count: 4, label: "Four Up" },
];

/* ---------------------------------------------------------------------------
 * CanvasMini — the shared miniature
 *
 * A scale picture of the deck canvas: `count` card blocks inside a frame, with
 * the Lens rail drawn as its own strip when `rail` is set. `packed` shows the
 * blocks chained tight from the far edge with the slack pooling beside the
 * rail; unpacked distributes them.
 * ---------------------------------------------------------------------------*/

function CanvasMini({
  count,
  rail = "none",
  packed = false,
  selected = false,
}: {
  count: number;
  rail?: "none" | "right";
  packed?: boolean;
  selected?: boolean;
}): React.ReactElement {
  const n = Math.max(count, 1);
  // The field, in percent of the miniature: what is left after the rail.
  const field = rail === "right" ? 100 - RAIL_PCT - GAP_PCT : 100;
  // A card is drawn at its natural width, the same for each. Off draws one
  // wide card, since a deck with no arrangement is just a card on a canvas.
  const cardWidth = count === 0 ? 60 : CARD_PCT;
  // The imposer's own rule, in miniature: one gap between cards when they fit,
  // and an even overlap when they do not — so the strip ends where the Lens
  // begins and never runs beneath it.
  const step =
    n < 2
      ? 0
      : Math.min(GAP_PCT, (field - GAP_PCT * 2 - cardWidth * n) / (n - 1));
  return (
    <span
      className="gsl-mini"
      data-selected={selected ? "true" : undefined}
      aria-hidden="true"
    >
      <span className="gsl-mini-field">
        {Array.from({ length: n }, (_, i) => (
          <span
            key={i}
            className="gsl-mini-block"
            style={
              packed
                ? {
                    position: "absolute",
                    insetBlock: 0,
                    left: `${GAP_PCT + i * (cardWidth + step)}%`,
                    width: `${cardWidth}%`,
                  }
                : undefined
            }
          />
        ))}
      </span>
      {rail === "right" ? <span className="gsl-mini-rail" /> : null}
    </span>
  );
}

/* ---------------------------------------------------------------------------
 * The mock Lens band every proposal is shown inside
 * ---------------------------------------------------------------------------*/

function LensBand({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="gsl-proposal">
      <TugLabel className="gsl-proposal-title" size="sm">
        {title}
      </TugLabel>
      <p className="gsl-proposal-note">{note}</p>
      <div className="gsl-lens" style={{ width: `${LENS_WIDTH}px` }}>
        <div className="gsl-lens-header">
          <span className="gsl-lens-glyph" aria-hidden="true" />
          <span className="gsl-lens-title">Layouts</span>
        </div>
        <div className="gsl-lens-body">{children}</div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * P1 — Snap miniatures
 * ---------------------------------------------------------------------------*/

function ProposalMiniatures({
  chosen,
  onChoose,
}: {
  chosen: number;
  onChoose: (count: number) => void;
}): React.ReactElement {
  return (
    <div className="gsl-grid">
      {CHOICES.map((choice) => (
        <button
          key={choice.count}
          type="button"
          className="gsl-tile"
          data-selected={choice.count === chosen ? "true" : undefined}
          onClick={() => onChoose(choice.count)}
        >
          <CanvasMini count={choice.count} selected={choice.count === chosen} />
          <span className="gsl-tile-label">{choice.label}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * P2 — Miniatures that admit the Lens and the slack
 * ---------------------------------------------------------------------------*/

function ProposalTrueMiniatures({
  chosen,
  onChoose,
}: {
  chosen: number;
  onChoose: (count: number) => void;
}): React.ReactElement {
  return (
    <div className="gsl-grid">
      {CHOICES.map((choice) => (
        <button
          key={choice.count}
          type="button"
          className="gsl-tile"
          data-selected={choice.count === chosen ? "true" : undefined}
          onClick={() => onChoose(choice.count)}
        >
          <CanvasMini
            count={choice.count}
            rail="right"
            packed
            selected={choice.count === chosen}
          />
          <span className="gsl-tile-label">{choice.label}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * P3 — Numbered tiles
 * ---------------------------------------------------------------------------*/

function ProposalNumbered({
  chosen,
  onChoose,
}: {
  chosen: number;
  onChoose: (count: number) => void;
}): React.ReactElement {
  return (
    <div className="gsl-grid">
      {CHOICES.map((choice) => {
        const selected = choice.count === chosen;
        const states: TugSlotState[] = Array.from(
          { length: choice.count },
          (): TugSlotState => (selected ? "filled" : "rest"),
        );
        return (
          <button
            key={choice.count}
            type="button"
            className="gsl-tile gsl-tile-numbered"
            data-selected={selected ? "true" : undefined}
            onClick={() => onChoose(choice.count)}
          >
            <span className="gsl-numbered-field">
              {choice.count === 0 ? (
                <span className="gsl-off-mark">—</span>
              ) : (
                <TugSlotLayout count={choice.count} states={states} size="md" />
              )}
            </span>
            <span className="gsl-tile-label">{choice.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * P4 — Two-column rows
 * ---------------------------------------------------------------------------*/

function ProposalRows({
  chosen,
  onChoose,
}: {
  chosen: number;
  onChoose: (count: number) => void;
}): React.ReactElement {
  return (
    <div className="gsl-grid gsl-grid-rows">
      {CHOICES.map((choice) => (
        <button
          key={choice.count}
          type="button"
          className="gsl-row"
          data-selected={choice.count === chosen ? "true" : undefined}
          onClick={() => onChoose(choice.count)}
        >
          <CanvasMini
            count={choice.count}
            rail="right"
            packed
            selected={choice.count === chosen}
          />
          <span className="gsl-row-label">{choice.label}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * SpikeSlotLayout
 * ---------------------------------------------------------------------------*/

export function SpikeSlotLayout(): React.ReactElement {
  const [p1, setP1] = useState(3);
  const [p2, setP2] = useState(3);
  const [p3, setP3] = useState(3);
  const [p4, setP4] = useState(3);

  return (
    <div className="sp-content" data-testid="gallery-slot-layout">
      <div className="sp-section">
        <TugLabel className="sp-section-title">Layouts picker — proposals</TugLabel>
        <p className="gsl-intro">
          Four ways to offer the imposition choices in the Lens. Each is shown at
          the rail&rsquo;s real width, inside a mock section band, so they can be
          compared at the size they will actually be read at.
        </p>
      </div>

      <TugSeparator />

      <div className="sp-section gsl-proposals">
        <LensBand
          title="P1 · Snap miniatures"
          note="Each option is a scale picture of the canvas, divided into equal zones — the Windows 11 Snap Layouts idiom. Reads instantly and needs no numbers, but it draws an idealised deck: equal widths, no Lens, no slack."
        >
          <ProposalMiniatures chosen={p1} onChoose={setP1} />
        </LensBand>

        <LensBand
          title="P2 · Miniatures that admit the Lens"
          note="The same picture, told the truth: the rail is in it, the cards pack away from it one gap apart, and the slack pools beside it. What you see is what the deck does."
        >
          <ProposalTrueMiniatures chosen={p2} onChoose={setP2} />
        </LensBand>

        <LensBand
          title="P3 · Numbered tiles"
          note="The real slot widgets inside a framed tile. The numbers here are the same numbers the Sessions and Text Files rows offer, so the picker teaches the row control — at the cost of reading as chrome rather than as a layout."
        >
          <ProposalNumbered chosen={p3} onChoose={setP3} />
        </LensBand>

        <LensBand
          title="P4 · Two-column rows"
          note="Miniature and name on one line, two to a row. The name is always legible and the target is bigger, but a wide short tile is a worse picture of a wide short canvas than a tall tile is."
        >
          <ProposalRows chosen={p4} onChoose={setP4} />
        </LensBand>
      </div>
    </div>
  );
}

export const spike: SpikeDef = {
  name: "slot-layout",
  title: "Layouts Picker",
  blurb: "How should the Lens show the imposition choices so the arrangement is obvious before you commit?",
  icon: "Columns3",
  component: () => <SpikeSlotLayout />,
};
