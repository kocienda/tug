/**
 * spike-light-chrome.tsx — a tuner for the LIGHT themes' card title bar.
 *
 * ── The fault ────────────────────────────────────────────────────────────
 * The light themes were given the dark themes' chrome recipe: a saturated
 * band with light ink on it. `harmony` seats the focused title bar at
 * `--tugx-chrome-key-surface` = `oklch(0.5 0.066 230)` — a mid-tone — and
 * paints the title near-white. On a light theme the card lid is therefore the
 * darkest thing on screen wearing the lightest text, which inverts the polarity
 * of every other surface. The Session masthead shows it worst, because its ink
 * ladder steps 100 → 85 → 65 percent *toward transparent*, and the third rung
 * of a ladder into a saturated ground is a ghost.
 *
 * The deck hit this exact bug once already, one tier down: the sidebar rail
 * gave up the tinted band and kept the card-titlebar ink family, painting
 * near-white ink onto a near-white bar. `tug-pane.css` states the lesson —
 * **a surface change is a token FAMILY change.** So the ink here comes from
 * `--tug7-element-global-*`, and the band is the thing under tune.
 *
 * ── What this card is ────────────────────────────────────────────────────
 * Three numbers and a preview. The active band is the theme's OWN Key hue at
 * a lightness and chroma you set; the inactive band is neutral gray at a
 * lightness you set. Drag, look at the masthead, read the two declarations off
 * the readout, paste them into the theme files.
 *
 * The sliders are in the repo's own authoring units — `l` and `c` on 0–1000,
 * exactly what `--tug-color()` takes — so the readout IS the declaration and
 * there is no conversion step between deciding and landing it.
 *
 * The band is built with `oklch(from var(--tugx-chrome-key-surface) L C h)`:
 * the theme's Key hue with this card's lightness and chroma substituted. Only
 * `h` passes through, so a setting judged in `harmony` (blue) is the same
 * setting in `aria` (iris) and `vivace` (seafoam). `color-mix` cannot express
 * this — a mix can only travel toward the color you mix with, and no color
 * lies in the direction "same lightness, different chroma".
 *
 * ── Two things the preview does not do ───────────────────────────────────
 * An unfocused pane on the real deck is dimmed deck-wide by two blend layers
 * on `.tug-pane-chrome` — a saturation kill and a lightness wash — and those
 * cover the title bar too. This card does NOT apply that wash, so whatever
 * separation the inactive band shows here, the deck will show slightly less.
 *
 * And a fixture cannot genuinely be unfocused: `tug-pane.css` selects the
 * focused state as `.tug-pane[data-focused="true"] .tug-pane-title-bar`, a
 * DESCENDANT selector, and these fixtures stand inside the spike card's own
 * pane — which is focused whenever you are reading it. So the unfocused
 * fixture aliases the active token family onto the inactive one and lets the
 * ancestor's rule paint the right thing. Stated in the stylesheet.
 *
 * @module spikes/spike-light-chrome
 */

import "./spike.css";
import "./spike-light-chrome.css";

import React, { useId, useLayoutEffect, useRef, useState } from "react";
import { CircleDot, MoveHorizontal, X } from "lucide-react";

import { TugButton } from "@/components/tugways/internal/tug-button";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugSlider } from "@/components/tugways/tug-slider";
import {
  TugSessionRow,
  TUG_SESSION_ROW_STACK_DOT_SIZE,
} from "@/components/tugways/tug-session-row";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import { sessionSessionPhaseVisual } from "@/lib/code-session-store/session-phase-visual";
import { useOptionalThemeContext } from "@/contexts/theme-provider";

import type { SpikeDef } from "./spike-registry";

/**
 * Each light theme's Key HUE, as `--tug-color()` names it — the readout needs
 * the name, and only the theme file has it. Source: the
 * `--tugx-chrome-key-surface` declaration in `styles/themes/<theme>.css`.
 * A theme absent from this map still previews correctly (the band is built
 * from the computed Key surface, not from this map); only the readout falls
 * back to naming the token instead of the hue.
 */
const KEY_HUE_BY_THEME: Record<string, string> = {
  harmony: "blue",
  aria: "iris",
  vivace: "seafoam",
};

/** The masthead's dense dot — the same cut the shipping masthead asks for. */
const DOT_SIZE = TUG_SESSION_ROW_STACK_DOT_SIZE;

/**
 * `--tug-color()`'s chroma ceiling: authored `c` runs 0–1000 onto oklch C
 * 0–0.5, so an authored unit is `C * 2000`. The theme files' Key sits at
 * `c: 132` = `C 0.066`. Mirrors `MAX_CHROMA` in `tugcolor.ts`, which is where
 * the number is decided.
 */
const CHROMA_UNITS_PER_OKLCH = 2000;

/**
 * The sliders start on what the CURRENT THEME actually ships, read off the
 * computed cascade rather than typed here — so the card opens on the landed
 * value and cannot drift into showing a number nothing uses. A theme switch
 * re-seeds them.
 *
 * Returns authored `--tug-color()` units: `l` is `L * 1000` and `c` is
 * `C * CHROMA_UNITS_PER_OKLCH`, which is what the sliders and the readout
 * speak. Null when the property is absent or not an `oklch()` triple — a dark
 * theme has no `--tugx-chrome-key-surface` at all, and the caller falls back.
 */
function readAuthoredColor(property: string): { l: number; c: number } | null {
  const raw = getComputedStyle(document.body).getPropertyValue(property).trim();
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)/.exec(raw);
  if (match === null) return null;
  const L = Number(match[1]);
  const C = Number(match[2]);
  if (!Number.isFinite(L) || !Number.isFinite(C)) return null;
  return {
    l: Math.round(L * 1000),
    c: Math.round(C * CHROMA_UNITS_PER_OKLCH),
  };
}

/** The active band's authored pair, or a mid-range stand-in off a dark theme. */
function seedActive(): { l: number; c: number } {
  return readAuthoredColor("--tugx-chrome-key-surface") ?? { l: 930, c: 50 };
}

/** The inactive band's authored lightness, or the same stand-in's. */
function seedInactiveL(): number {
  return (
    readAuthoredColor("--tug7-surface-card-primary-normal-titlebar-inactive")
      ?.l ?? 935
  );
}

// ---------------------------------------------------------------------------
// The preview — real pane classes, so the tune is token-only
// ---------------------------------------------------------------------------

/**
 * The pane's control cluster, as the title bar wears it, composed from
 * `TugButton`'s ghost icon form ([L20]). Here because it is the ink most at
 * risk: a ghost glyph has the least contrast to give away, so a band that
 * keeps the title legible can still lose the cluster.
 */
function Cluster(): React.ReactElement {
  return (
    <div className="tug-pane-title-bar-controls">
      <TugButton
        subtype="icon"
        emphasis="ghost"
        role="action"
        size="sm"
        icon={<MoveHorizontal />}
        aria-label="Card width"
        onClick={() => {}}
      />
      <TugButton
        subtype="icon"
        emphasis="ghost"
        role="action"
        size="sm"
        icon={<CircleDot />}
        aria-label="Bullseye"
        onClick={() => {}}
      />
      <TugButton
        subtype="icon"
        emphasis="ghost"
        role="action"
        size="sm"
        icon={<X />}
        aria-label="Close"
        onClick={() => {}}
      />
    </div>
  );
}

/**
 * A one-line title bar. The markup is the pane's own — `.tug-pane`,
 * `.tug-pane-title-bar`, `.tug-pane-title`, `.tug-pane-title-bar-controls` —
 * so every rule deciding the bar's height, divider, ink, and ghost controls is
 * the shipping rule.
 */
function Bar({ focused }: { focused: boolean }): React.ReactElement {
  return (
    <div
      className="tug-pane sp-lc-pane"
      {...(focused ? { "data-focused": "true" } : {})}
    >
      <div className="tug-pane-title-bar sp-lc-bar">
        <span className="tug-pane-title">tugtool/juicy-roach</span>
        <Cluster />
      </div>
      <div className="sp-lc-body">the card&rsquo;s content ground</div>
    </div>
  );
}

/**
 * A Session masthead — the REAL {@link TugSessionRow} in the real
 * `.tug-masthead-frame` tier, so the ink ladder under judgment (title full,
 * description 85%, activity 65%) is the shipped ladder rather than a drawing
 * of one. Only the strings are fixtures. This is the surface the fault shows
 * worst on, so it is the surface a setting has to survive.
 */
function Masthead({ focused }: { focused: boolean }): React.ReactElement {
  return (
    <div
      className="tug-pane sp-lc-pane"
      {...(focused ? { "data-focused": "true" } : {})}
    >
      <div className="tug-pane-title-bar sp-lc-bar sp-lc-bar-masthead">
        <div className="tug-masthead-frame">
          <TugSessionRow
            className="tug-masthead-frame-row"
            subAlign="title"
            indicator={
              <TugProgressIndicator
                variant="pulsing-dot"
                size={DOT_SIZE}
                phase={focused ? "streaming" : "idle"}
                phaseVisual={sessionSessionPhaseVisual}
                aria-hidden
              />
            }
            indicatorSize={DOT_SIZE}
            name={
              <>
                dash+join-xp
                <span className="sp-lc-callsign">^join-base-resolve</span>
              </>
            }
            description="Resolve conflicts at the end of a join; no block and temp-commit fold"
            activity="Adding that."
          />
        </div>
        <Cluster />
      </div>
      <div className="sp-lc-body">the transcript&rsquo;s content ground</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

function SpikeLightChrome(): React.ReactElement {
  const theme = useOptionalThemeContext()?.theme ?? "";
  const keyHue = KEY_HUE_BY_THEME[theme];

  const [activeL, setActiveL] = useState(() => seedActive().l);
  const [activeC, setActiveC] = useState(() => seedActive().c);
  const [inactiveL, setInactiveL] = useState(seedInactiveL);

  // Re-seed when the theme changes, so switching themes shows that theme's
  // landed values rather than carrying the previous one's numbers across.
  const seededTheme = useRef(theme);
  useLayoutEffect(() => {
    if (seededTheme.current === theme) return;
    seededTheme.current = theme;
    const active = seedActive();
    setActiveL(active.l);
    setActiveC(active.c);
    setInactiveL(seedInactiveL());
  }, [theme]);

  const activeLId = useId();
  const activeCId = useId();
  const inactiveLId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    setValueNumber: {
      [activeLId]: setActiveL,
      [activeCId]: setActiveC,
      [inactiveLId]: setInactiveL,
    },
  });

  // The three numbers reach the preview as CUSTOM PROPERTIES on its root, not
  // as React-rendered style props on each pane ([L06]). One write per drag
  // frame, and the panes below never learn a number changed — which is also
  // why the preview subtree can stay ordinary markup.
  const previewRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = previewRef.current;
    if (el === null) return;
    el.style.setProperty("--sp-lc-l", String(activeL / 1000));
    el.style.setProperty("--sp-lc-c", String(activeC / CHROMA_UNITS_PER_OKLCH));
    el.style.setProperty("--sp-lc-off-l", String(inactiveL / 1000));
  }, [activeL, activeC, inactiveL]);

  const activeDecl =
    keyHue === undefined
      ? `oklch(from var(--tugx-chrome-key-surface) ${activeL / 1000} ${
          activeC / CHROMA_UNITS_PER_OKLCH
        } h)`
      : `--tug-color(${keyHue}, l: ${activeL}, c: ${activeC})`;

  return (
    <ResponderScope>
      <div
        className="sp-content"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        {keyHue === undefined && (
          <div className="sp-lc-notice">
            This tunes the LIGHT themes&rsquo; chrome. You are on{" "}
            <strong>{theme || "an unknown theme"}</strong> — switch to Harmony,
            Aria, or Vivace. The band is a light wash of the theme&rsquo;s Key
            hue, so on a dark ground it reads as a near-white bar and proves
            nothing.
          </div>
        )}

        <section className="sp-section">
          <h2 className="sp-section-title">Tune</h2>
          <div className="sp-lc-tuner">
            <TugSlider
              label="Active L"
              senderId={activeLId}
              value={activeL}
              min={800}
              max={1000}
              step={5}
              size="sm"
            />
            <TugSlider
              label="Active c"
              senderId={activeCId}
              value={activeC}
              min={0}
              max={300}
              step={5}
              size="sm"
            />
            <TugSlider
              label="Inactive L"
              senderId={inactiveLId}
              value={inactiveL}
              min={800}
              max={1000}
              step={5}
              size="sm"
            />
          </div>
          <pre className="sp-lc-readout">
            {`--tug7-surface-card-primary-normal-titlebar-active: ${activeDecl};\n`}
            {`--tug7-surface-card-primary-normal-titlebar-inactive: --tug-color(gray, l: ${inactiveL});`}
          </pre>
        </section>

        <section className="sp-section">
          <h2 className="sp-section-title">Preview</h2>
          <div className="sp-lc-preview" ref={previewRef}>
            <div className="sp-lc-pair">
              <Bar focused />
              <Bar focused={false} />
            </div>
            <div className="sp-lc-pair">
              <Masthead focused />
              <Masthead focused={false} />
            </div>
          </div>
        </section>
      </div>
    </ResponderScope>
  );
}

export const spike: SpikeDef = {
  name: "light-chrome",
  title: "Light Chrome",
  blurb:
    "The light themes wear the dark themes' title bar — a mid-tone band under light ink. Tune the band that should replace it.",
  icon: "SunMedium",
  size: {
    min: { width: 520, height: 400 },
    preferred: { width: 760, height: 620 },
  },
  component: () => <SpikeLightChrome />,
};
