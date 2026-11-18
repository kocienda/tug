/**
 * spike-mid-themes.tsx — what would DUSK, a third theme family of mid-tone
 * grounds under near-black ink, look like?
 *
 * The deck ships dark ships and light boats. Dusk is the family between
 * them: the card ground sits in the mid-tones (authored `l` around 740) —
 * dark enough to carry real colour as a FIELD, which the light themes are
 * forbidden, and light enough that the ink is still near-black.
 *
 * Settled so far: the family is **Dusk** (`ThemeMode` gains `dusk` beside
 * `dark` and `light`), and its themes are named for working craft — bigger
 * than a boat, smaller than a ship: `lugger`, `packet`, `tender`, `cutter`,
 * `trawler`. `lugger` is Gravel, the one neutral gray; the other four each
 * wear a tint.
 *
 * Still open, and what the card is for: the ground itself. Two sliders move
 * the card ground's lightness and chroma under all five at once (Gravel
 * ignores the chroma), and each deck reports the WCAG contrast its
 * near-black ink, its muted ink, and white ink would get.
 *
 * Each miniature deck is a scoped theme root — see `spike-mid-themes.css` —
 * so the `TugButton`s and `TugBadge`s inside are the shipping components
 * painted by mid-tone tokens, not drawings of them. The lid, rows and well
 * are fixtures: the real pane chrome reads body-level aliases a scoped root
 * cannot reach.
 *
 * Nothing here is a theme file. A theme that lands is a full
 * `styles/themes/<name>.css`, a third `ThemeMode`, and a seat in the
 * contrast audit.
 *
 * @module spikes/spike-mid-themes
 */

import "./spike.css";
import "./spike-mid-themes.css";

import React, { useId, useLayoutEffect, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";

import { TugButton } from "@/components/tugways/internal/tug-button";
import { TugBadge } from "@/components/tugways/tug-badge";
import { TugSlider } from "@/components/tugways/tug-slider";
import {
  HUE_FAMILIES,
  MAX_CHROMA,
  oklchToLinearSRGB,
} from "@/components/tugways/tugcolor";
import { useResponderForm } from "@/components/tugways/use-responder-form";

import type { SpikeDef } from "./spike-registry";

// ---------------------------------------------------------------------------
// The fleet
// ---------------------------------------------------------------------------

/**
 * One Dusk theme: its vessel name, the ground it wears as the stylesheet's
 * `data-tint` knows it, and the `--tug-color()` hue names behind it.
 */
interface Tint {
  id: string;
  /** The theme's name: a working craft. */
  name: string;
  /** What the ground is, in a word. */
  label: string;
  tintHue: string;
  keyHue: string;
  /** True for a ground with no chroma at all, whatever the slider says. */
  neutral?: boolean;
}

const TINTS: readonly Tint[] = [
  { id: "gravel", name: "Lugger", label: "Gravel", tintHue: "gray", keyHue: "sapphire", neutral: true },
  { id: "sand", name: "Packet", label: "Sand", tintHue: "honey", keyHue: "plum" },
  { id: "sage", name: "Tender", label: "Sage", tintHue: "jade", keyHue: "azure" },
  { id: "slate", name: "Cutter", label: "Slate", tintHue: "cerulean", keyHue: "cobalt" },
  { id: "mauve", name: "Trawler", label: "Mauve", tintHue: "orchid", keyHue: "cerise" },
];

// ---------------------------------------------------------------------------
// Contrast — the question the family has to answer
// ---------------------------------------------------------------------------

/** Authored `c` (0–1000) per unit of oklch chroma; the inverse of the scale. */
const CHROMA_UNITS_PER_OKLCH = 1000 / MAX_CHROMA;

/** Where the sliders open: the ground the stylesheet's fallbacks also name. */
const SEED_L = 740;
const SEED_C = 50;

/** The stylesheet's two inks, as oklch (L, C). Hue is the tint's. */
const INK = { L: 0.13, C: 0 };
const INK_MUTED = { L: 0.34, C: 0.03 };

/** WCAG relative luminance of an oklch color, channels clamped to sRGB. */
function luminance(L: number, C: number, h: number): number {
  const { r, g, b } = oklchToLinearSRGB(L, C, h);
  const clamp = (n: number): number => Math.min(1, Math.max(0, n));
  return 0.2126 * clamp(r) + 0.7152 * clamp(g) + 0.0722 * clamp(b);
}

/** WCAG contrast ratio between two luminances, to one decimal. */
function contrast(a: number, b: number): string {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return ((hi + 0.05) / (lo + 0.05)).toFixed(1);
}

// ---------------------------------------------------------------------------
// One miniature deck
// ---------------------------------------------------------------------------

function Deck({
  tint,
  groundL,
  groundC,
}: {
  tint: Tint;
  groundL: number;
  groundC: number;
}): React.ReactElement {
  const hue = HUE_FAMILIES[tint.tintHue] ?? 0;
  const neutral = tint.neutral === true;
  const ground = luminance(
    groundL / 1000,
    neutral ? 0 : groundC / CHROMA_UNITS_PER_OKLCH,
    hue,
  );
  const ink = contrast(ground, luminance(INK.L, INK.C, hue));
  const muted = contrast(
    ground,
    luminance(INK_MUTED.L, neutral ? 0 : INK_MUTED.C, hue),
  );
  const white = contrast(ground, 1);

  return (
    <div className="sp-mt-deck" data-tint={tint.id}>
      <div className="sp-mt-plate">
        <span className="sp-mt-plate-tint">{tint.name}</span>
        <span className="sp-mt-plate-contrast">
          ink {ink} · muted {muted} · white {white}
        </span>
      </div>
      <div className="sp-mt-names">
        {tint.label} — {tint.tintHue} ground, {tint.keyHue} Key
      </div>

      <div className="sp-mt-card" data-focused="true">
        <div className="sp-mt-lid">
          <MessageSquare />
          <span>tug/mighty-cabin</span>
        </div>
        <div className="sp-mt-body">
          <p>
            The ground is a mid-tone and the ink is still near-black. A Dusk
            ground can be a field of colour, where a light theme keeps colour
            to <span className="sp-mt-link">marks</span>.
          </p>
          <p className="sp-mt-muted">
            Muted ink: a path, a timestamp, 3 files changed.
          </p>
          <pre className="sp-mt-well">
            {"$ just ci\n[test] 412 passed in 38.2s"}
          </pre>
          <div className="sp-mt-rows">
            <div className="sp-mt-row">
              <span>styles/themes/sloop.css</span>
              <span>+12 −4</span>
            </div>
            <div className="sp-mt-row" data-selected="true">
              <span>src/theme-catalog.ts</span>
              <span>+3 −1</span>
            </div>
            <div className="sp-mt-row">
              <span>tuglaws/theme-engine.md</span>
              <span>+20 −0</span>
            </div>
          </div>
          <div className="sp-mt-marks">
            <TugBadge emphasis="filled" role="success" size="sm">
              passed
            </TugBadge>
            <TugBadge emphasis="filled" role="danger" size="sm">
              failed
            </TugBadge>
            <TugBadge emphasis="filled" role="caution" size="sm">
              retried
            </TugBadge>
            <span className="sp-mt-ring">shipped ring</span>
            <span className="sp-mt-ring" data-cut="deep">
              deeper ring
            </span>
          </div>
          <div className="sp-mt-actions">
            <TugButton emphasis="filled" role="action" size="sm" onClick={() => {}}>
              Commit
            </TugButton>
            <TugButton emphasis="outlined" role="action" size="sm" onClick={() => {}}>
              Discard
            </TugButton>
          </div>
        </div>
      </div>

      <div className="sp-mt-card" data-focused="false">
        <div className="sp-mt-lid">
          <MessageSquare />
          <span>an unfocused card</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

function SpikeMidThemes(): React.ReactElement {
  const [groundL, setGroundL] = useState(SEED_L);
  const [groundC, setGroundC] = useState(SEED_C);

  const groundLId = useId();
  const groundCId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    setValueNumber: {
      [groundLId]: setGroundL,
      [groundCId]: setGroundC,
    },
  });

  // The two numbers reach the decks as custom properties on the fleet root
  // ([L06]); every rung of every deck's ladder is CSS arithmetic from there.
  const fleetRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = fleetRef.current;
    if (el === null) return;
    el.style.setProperty("--sp-mt-l", String(groundL / 1000));
    el.style.setProperty("--sp-mt-c", String(groundC / CHROMA_UNITS_PER_OKLCH));
  }, [groundL, groundC]);

  return (
    <ResponderScope>
      <div
        className="sp-content"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        <section className="sp-section">
          <h2 className="sp-section-title">The ground</h2>
          <div className="sp-mt-tuner">
            <TugSlider
              label="Ground L"
              senderId={groundLId}
              value={groundL}
              min={600}
              max={860}
              step={5}
              size="sm"
            />
            <TugSlider
              label="Ground c"
              senderId={groundCId}
              value={groundC}
              min={0}
              max={140}
              step={2}
              size="sm"
            />
          </div>
          <div className="sp-mt-note">
            Each deck reports WCAG contrast on its card ground for the
            near-black ink, the muted ink, and white. Body text wants 4.5.
            Gravel is a neutral gray and ignores the chroma. The ground is{" "}
            <code>
              --tug-color(&lt;tint&gt;, l: {groundL}, c: {groundC})
            </code>
            ; the light themes sit at l: 985 and the dark ones near l: 310.
          </div>
        </section>

        <section className="sp-section">
          <h2 className="sp-section-title">Dusk — five working craft</h2>
          <div className="sp-mt-fleet" ref={fleetRef}>
            {TINTS.map((tint) => (
              <Deck
                key={tint.id}
                tint={tint}
                groundL={groundL}
                groundC={groundC}
              />
            ))}
          </div>
        </section>
      </div>
    </ResponderScope>
  );
}

export const spike: SpikeDef = {
  name: "mid-themes",
  title: "Dusk Themes",
  blurb:
    "Dusk, a third theme family between the light boats and the dark ships: mid-tone grounds under near-black ink. What should the ground be?",
  icon: "Contrast",
  size: {
    min: { width: 520, height: 400 },
    preferred: { width: 1100, height: 780 },
  },
  component: () => <SpikeMidThemes />,
};
