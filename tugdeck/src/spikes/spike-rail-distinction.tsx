/**
 * spike-rail-distinction.tsx — how far apart should a RAIL and a CARD look?
 *
 * ── The fault ────────────────────────────────────────────────────────────
 * A sidebar rail and a content card stand on the same paper, in the same
 * frame, with the same gap between them as between any two cards. The rail
 * tier gave the rail a flush bar with racing stripes, and that is the only
 * thing telling the eye "this one is a tool, not a document". At deck scale
 * it is not enough: a rail next to a Session card reads as two cards, and
 * the 5px between them reads as the same 5px that separates every card.
 *
 * ── What this card is ────────────────────────────────────────────────────
 * Six miniature decks, each a real rail frame beside a real content frame on
 * real graph paper, differing only in the treatment named on the row:
 *
 *   A. Baseline       — today, for reference
 *   B. Tinted rail    — the rail's ground travels toward the theme's hue
 *   C. Tinted margin  — the PAPER under the rail changes; the rail does not
 *   D. Ruled gutter   — the gap is drawn: the rail's stripes, turned vertical
 *   E. Panel          — the rail gives up the card shape altogether
 *   F. Both           — tinted rail on tinted, finer-ruled margin
 *
 * Two knobs above them — tint strength and gutter width — apply across every
 * row but the baseline, so the rows compare at the same setting. A third
 * picks the hue the tints travel toward: the theme's Key (the card lids'
 * hue) or its accent.
 *
 * The frames are the real `.tug-pane` / `.tug-pane-chrome` / `CardTitleBar`,
 * so the deck's recede (the two blend layers on an unfocused chrome) applies
 * to the rail in every row, exactly as it would with the content card focused.
 * `data-focused` is a descendant selector, and the spike's own pane is
 * focused whenever you are reading it — so the CONTENT card cannot be
 * unfocused here; the rail can, and is.
 *
 * @module spikes/spike-rail-distinction
 */

import "./spike.css";
import "./spike-rail-distinction.css";

import React, { useId, useLayoutEffect, useRef, useState } from "react";

import { CardTitleBar } from "@/components/chrome/tug-pane";
import { TugCheckbox } from "@/components/tugways/tug-checkbox";
import { TugSlider } from "@/components/tugways/tug-slider";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import { IMPOSITION_GAP_PX } from "@/lib/layout-imposer";

import type { SpikeDef } from "./spike-registry";

const noop = (): void => {};

type Variant = "baseline" | "tinted-rail" | "tinted-margin" | "gutter" | "panel" | "both";

interface Option {
  variant: Variant;
  letter: string;
  title: string;
  blurb: string;
}

const OPTIONS: readonly Option[] = [
  {
    variant: "baseline",
    letter: "A",
    title: "Baseline",
    blurb: `Today. Same paper, same frame, same ${IMPOSITION_GAP_PX}px gap as between any two cards. Only the bar says “rail”.`,
  },
  {
    variant: "tinted-rail",
    letter: "B",
    title: "Tinted rail",
    blurb:
      "The rail's ground and border travel toward the hue; the card stays neutral. One token override on the sidebar pane, nothing else moves.",
  },
  {
    variant: "tinted-margin",
    letter: "C",
    title: "Tinted margin",
    blurb:
      "The rail is untouched. The band of paper it stands in — edge to the far side of the gap — takes a tinted canvas and tinted grid. The gap becomes part of the margin, so the gap is the treatment.",
  },
  {
    variant: "gutter",
    letter: "D",
    title: "Ruled gutter",
    blurb:
      "The gap itself is drawn: the rail bar's three hairlines, turned vertical, running the gutter's height. The rail stands flush to the edge so the stripes are the only air between tool and document.",
  },
  {
    variant: "panel",
    letter: "E",
    title: "Panel, not card",
    blurb:
      "The rail gives up the card's shape — no radius, no shadow, no outer border, flush on three sides, sunken surface. One strong hairline on its inner edge. Shape contrast rather than color.",
  },
  {
    variant: "both",
    letter: "F",
    title: "Tinted rail on tinted margin",
    blurb:
      "B and C together, with the margin's grid at half pitch. The tools' paper is finer-ruled than the documents' paper, and rail and margin share a hue.",
  },
];

/** The rail's rows, in the voice a real sidebar list speaks. */
const RAIL_ROWS: readonly { label: string; meta: string }[] = [
  { label: "session-description-ladder", meta: "3" },
  { label: "arc-purpose", meta: "5" },
  { label: "one-door", meta: "1" },
  { label: "keymap-probe", meta: "2" },
  { label: "arc-step-list", meta: "4" },
];

/**
 * One miniature deck. The rail is unfocused and the card is focused — the
 * common state on a real deck, and the one where the rail's recede and the
 * card's lit title bar are both in play.
 */
function MiniDeck({ variant }: { variant: Variant }): React.ReactElement {
  return (
    <div className="sp-rd-deck" data-variant={variant}>
      <div className="sp-rd-margin" />
      <div className="sp-rd-gutter" />

      <div className="tug-pane sp-rd-pane sp-rd-pane-rail" data-role="sidebar">
        <div className="tug-pane-chrome">
          <CardTitleBar title="Arcs" icon="Waypoints" sidebar onClose={noop} />
          <div className="sp-rd-rows">
            {RAIL_ROWS.map((row) => (
              <div className="sp-rd-row" key={row.label}>
                <span className="sp-rd-row-dot" />
                <span>{row.label}</span>
                <span className="sp-rd-row-meta">{row.meta}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="tug-pane sp-rd-pane sp-rd-pane-card" data-focused="true">
        <div className="tug-pane-chrome">
          <CardTitleBar title="Session" icon="Terminal" onClose={noop} />
          <div className="sp-rd-card-body">
            <p>The rail on the left is a tool. This card is a document.</p>
            <p>Does the gap between them say so?</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function SpikeRailDistinction(): React.ReactElement {
  // Tint on 0–100 (a percentage), gutter in px, hue as a choice.
  const [tint, setTint] = useState(12);
  const [gutter, setGutter] = useState(12);
  const [accent, setAccent] = useState(false);

  const tintId = useId();
  const gutterId = useId();
  const accentId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    setValueNumber: {
      [tintId]: setTint,
      [gutterId]: setGutter,
    },
    toggle: {
      [accentId]: setAccent,
    },
  });

  // The knobs reach the decks as CUSTOM PROPERTIES on the root, not as
  // React-rendered style on each frame ([L06]). One write per change, and
  // the six decks below never learn a number moved.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (el === null) return;
    el.style.setProperty("--sp-rd-tint", String(tint / 100));
    el.style.setProperty("--sp-rd-gutter", `${gutter}px`);
    el.style.setProperty(
      "--sp-rd-hue",
      accent ? "var(--tugx-accent)" : "var(--sp-rd-key)",
    );
  }, [tint, gutter, accent]);

  return (
    <ResponderScope>
      <div className="sp-content" ref={responderRef as (el: HTMLDivElement | null) => void}>
        <div className="sp-rd-root" ref={rootRef}>
          <section className="sp-section">
            <h2 className="sp-section-title">Tune</h2>
            <div className="sp-rd-tuner">
              <TugSlider
                label="Tint"
                senderId={tintId}
                value={tint}
                min={0}
                max={40}
                step={1}
                size="sm"
              />
              <TugSlider
                label="Gutter"
                senderId={gutterId}
                value={gutter}
                min={IMPOSITION_GAP_PX}
                max={24}
                step={1}
                size="sm"
              />
              <div className="sp-rd-tuner-row">
                <TugCheckbox
                  senderId={accentId}
                  checked={accent}
                  label="Tint toward the accent instead of the Key"
                  size="sm"
                />
              </div>
            </div>
            <p className="sp-rd-note">
              Tint is how far a ground travels toward the hue. Gutter is the gap
              between the rail and the first card; the baseline row keeps the
              imposition gap so the others can be read against it. The Key is the
              card lids&rsquo; own hue, so a Key tint says &ldquo;same family as
              the chrome&rdquo;; the accent says &ldquo;something else.&rdquo;
              Switch themes to see each on a light ground.
            </p>
          </section>

          {OPTIONS.map((opt) => (
            <section className="sp-section sp-rd-option" key={opt.variant}>
              <h2 className="sp-section-title">
                {opt.letter}. {opt.title}
              </h2>
              <div className="sp-rd-caption">
                <span>{opt.blurb}</span>
              </div>
              <MiniDeck variant={opt.variant} />
            </section>
          ))}
        </div>
      </div>
    </ResponderScope>
  );
}

export const spike: SpikeDef = {
  name: "rail-distinction",
  title: "Rail Distinction",
  blurb: "Six ways to make a sidebar rail and the gap beside it read differently from a card.",
  icon: "PanelLeft",
  size: {
    min: { width: 480, height: 400 },
    preferred: { width: 720, height: 820 },
  },
  component: () => <SpikeRailDistinction />,
};
