/**
 * gallery-tug-linear-gauge.tsx — `TugLinearGauge` demo tab for the
 * Component Gallery.
 *
 * Three sections — see [#step-20-1](arc/session-assistant-rendering.md#step-20-1):
 *
 *   1. Interactive sandbox — slider for `value`, numeric inputs for
 *      `min` / `max`, toggle for `density`, toggle for `fillRole`,
 *      configurable `caution` / `danger` thresholds. Re-renders the
 *      gauge live so design review can sweep through the domain and
 *      confirm color transitions at the thresholds.
 *   2. Three-scale × three-threshold matrix — nine cells laid out 3×3.
 *      Rows are scales (strip ~24 px → readable ~60 px → showcase
 *      ~140 px); columns are threshold configurations (no thresholds
 *      → value below caution → value above danger). Pins that the
 *      compact density reads at chrome scale AND scales up cleanly
 *      to the detailed face.
 *   3. Use-case preview — a dev-meter-style strip rendering the
 *      example fraction from the Step 20.3 layout sketch
 *      (`32.5k / 200k WINDOW`). Acts as the contract example for the
 *      eventual chrome consumer in [#step-20-3].
 *
 * @module components/tugways/cards/gallery-tug-linear-gauge
 */

import React from "react";

import { TugLinearGauge } from "@/components/tugways/tug-linear-gauge";
import type {
  TugLinearGaugeDensity,
} from "@/components/tugways/tug-linear-gauge";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

// ---------------------------------------------------------------------------
// Inline styles — kept module-local to mirror sibling gallery cards
// (gallery-tug-inline-dialog.tsx, gallery-tug-dialog-button.tsx). The
// gallery cards intentionally do not own component-tier CSS files;
// they style themselves with one-off inline rules so the demo's
// scaffolding never accidentally becomes a published surface.
// ---------------------------------------------------------------------------

const labelStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--tug7-element-field-text-normal-label-rest)",
  marginBottom: "4px",
};

const controlsRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "1rem",
  marginBottom: "0.75rem",
  fontFamily: "var(--tug-font-family-mono)",
  fontSize: "0.75rem",
};

const controlGroupStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "2px",
};

const fieldLabelStyle: React.CSSProperties = {
  fontSize: "0.6875rem",
  color: "var(--tug7-element-field-text-normal-label-rest)",
};

const inputStyle: React.CSSProperties = {
  width: "5rem",
  padding: "2px 4px",
  fontFamily: "var(--tug-font-family-mono)",
  fontSize: "0.75rem",
};

const matrixStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 1fr 1fr 1fr",
  gap: "0.75rem 1.25rem",
  alignItems: "center",
};

const matrixCellStyle: React.CSSProperties = {
  minWidth: 0,
};

const matrixRowLabelStyle: React.CSSProperties = {
  fontFamily: "var(--tug-font-family-mono)",
  fontSize: "0.6875rem",
  color: "var(--tug7-element-global-text-normal-muted-rest)",
  whiteSpace: "nowrap",
};

const matrixHeaderStyle: React.CSSProperties = {
  ...matrixRowLabelStyle,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

// ---------------------------------------------------------------------------
// Formatter for the strip-scale / use-case preview
// ---------------------------------------------------------------------------

/** Format a token count as `Nk` / `N.Nk` for the dev-meter-style preview. */
function formatTokens(value: number): string {
  if (value === 0) return "0";
  if (value < 1000) return String(Math.round(value));
  return `${(value / 1000).toFixed(1)}k`;
}

// ---------------------------------------------------------------------------
// GalleryTugLinearGauge
// ---------------------------------------------------------------------------

export function GalleryTugLinearGauge(): React.ReactElement {
  // Interactive sandbox state.
  const [value, setValue] = React.useState<number>(42);
  const [min, setMin] = React.useState<number>(0);
  const [max, setMax] = React.useState<number>(100);
  const [density, setDensity] =
    React.useState<TugLinearGaugeDensity>("detailed");
  const [fillRole, setFillRole] =
    React.useState<"default" | "info" | "success">("default");
  const [labelText, setLabelText] = React.useState<string>("LINEAR");
  const [cautionPct, setCautionPct] = React.useState<number>(75);
  const [dangerPct, setDangerPct] = React.useState<number>(90);

  const thresholds = React.useMemo(
    () => ({
      caution: cautionPct / 100,
      danger: dangerPct / 100,
    }),
    [cautionPct, dangerPct],
  );

  return (
    <div className="cg-content" data-testid="gallery-tug-linear-gauge">
      {/* ============================================================
          1. Interactive sandbox
          ============================================================ */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Interactive sandbox</TugLabel>
        <div style={labelStyle}>
          Tune <code>value</code>, <code>min</code>, <code>max</code>,{" "}
          density, <code>fillRole</code>, and the caution / danger
          thresholds. The gauge below re-renders live; sweep the value
          slider across the domain to verify color transitions match
          expectation.
        </div>

        <div style={controlsRowStyle}>
          <div style={{ ...controlGroupStyle, flex: "1 1 14rem" }}>
            <label style={fieldLabelStyle} htmlFor="cg-lgauge-value">
              value ({value.toFixed(1)})
            </label>
            <input
              id="cg-lgauge-value"
              type="range"
              min={min}
              max={max}
              step={(max - min) / 200}
              value={value}
              onChange={(e) => setValue(Number(e.currentTarget.value))}
            />
          </div>
          <div style={controlGroupStyle}>
            <label style={fieldLabelStyle} htmlFor="cg-lgauge-min">min</label>
            <input
              id="cg-lgauge-min"
              type="number"
              style={inputStyle}
              value={min}
              onChange={(e) => setMin(Number(e.currentTarget.value))}
            />
          </div>
          <div style={controlGroupStyle}>
            <label style={fieldLabelStyle} htmlFor="cg-lgauge-max">max</label>
            <input
              id="cg-lgauge-max"
              type="number"
              style={inputStyle}
              value={max}
              onChange={(e) => setMax(Number(e.currentTarget.value))}
            />
          </div>
          <div style={controlGroupStyle}>
            <label style={fieldLabelStyle} htmlFor="cg-lgauge-density">
              density
            </label>
            <select
              id="cg-lgauge-density"
              style={inputStyle}
              value={density}
              onChange={(e) =>
                setDensity(e.currentTarget.value as TugLinearGaugeDensity)
              }
            >
              <option value="compact">compact</option>
              <option value="detailed">detailed</option>
            </select>
          </div>
          <div style={controlGroupStyle}>
            <label style={fieldLabelStyle} htmlFor="cg-lgauge-fillrole">
              fillRole
            </label>
            <select
              id="cg-lgauge-fillrole"
              style={inputStyle}
              value={fillRole}
              onChange={(e) =>
                setFillRole(
                  e.currentTarget.value as "default" | "info" | "success",
                )
              }
            >
              <option value="default">default</option>
              <option value="info">info</option>
              <option value="success">success</option>
            </select>
          </div>
          <div style={controlGroupStyle}>
            <label style={fieldLabelStyle} htmlFor="cg-lgauge-label">
              label
            </label>
            <input
              id="cg-lgauge-label"
              type="text"
              style={inputStyle}
              value={labelText}
              onChange={(e) => setLabelText(e.currentTarget.value)}
            />
          </div>
          <div style={controlGroupStyle}>
            <label style={fieldLabelStyle} htmlFor="cg-lgauge-caution">
              caution %
            </label>
            <input
              id="cg-lgauge-caution"
              type="number"
              min={0}
              max={100}
              style={inputStyle}
              value={cautionPct}
              onChange={(e) => setCautionPct(Number(e.currentTarget.value))}
            />
          </div>
          <div style={controlGroupStyle}>
            <label style={fieldLabelStyle} htmlFor="cg-lgauge-danger">
              danger %
            </label>
            <input
              id="cg-lgauge-danger"
              type="number"
              min={0}
              max={100}
              style={inputStyle}
              value={dangerPct}
              onChange={(e) => setDangerPct(Number(e.currentTarget.value))}
            />
          </div>
        </div>

        <div style={{ maxWidth: "32rem" }}>
          <TugLinearGauge
            value={value}
            min={min}
            max={max}
            thresholds={thresholds}
            label={labelText !== "" ? labelText : undefined}
            density={density}
            fillRole={fillRole}
            // Fixed-precision formatter so a slider sweep producing
            // fractional intermediate values (step = (max-min)/200)
            // doesn't shift the readout's width per character count.
            // The primitive's width-stability contract handles bound-
            // anchored cases; the fractional intermediate case is the
            // consumer's responsibility (see prop docs).
            formatValue={(v) => v.toFixed(1)}
          />
        </div>
      </div>

      <TugSeparator />

      {/* ============================================================
          2. Scale × threshold matrix
          ============================================================ */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">
          Scale × threshold matrix
        </TugLabel>
        <div style={labelStyle}>
          Three scales (chrome strip → readable → showcase) across three
          threshold configurations (no thresholds → below caution →
          above danger). Pins that the compact density reads cleanly at
          the strip target AND scales up to the full mockup-style face.
        </div>

        <div style={matrixStyle}>
          {/* Header row */}
          <span />
          <span style={matrixHeaderStyle}>no thresholds</span>
          <span style={matrixHeaderStyle}>below caution (60%)</span>
          <span style={matrixHeaderStyle}>above danger (95%)</span>

          {/* Row 1 — strip-scale (compact) */}
          <span style={matrixRowLabelStyle}>
            STRIP
            <br />
            (compact, ~20 px)
          </span>
          <div style={matrixCellStyle}>
            <TugLinearGauge value={60} min={0} max={100} density="compact" />
          </div>
          <div style={matrixCellStyle}>
            <TugLinearGauge
              value={60}
              min={0}
              max={100}
              density="compact"
              thresholds={{ caution: 0.75, danger: 0.9 }}
            />
          </div>
          <div style={matrixCellStyle}>
            <TugLinearGauge
              value={95}
              min={0}
              max={100}
              density="compact"
              thresholds={{ caution: 0.75, danger: 0.9 }}
            />
          </div>

          {/* Row 2 — labeled (compact + label) */}
          <span style={matrixRowLabelStyle}>
            LABELED
            <br />
            (compact + label)
          </span>
          <div style={matrixCellStyle}>
            <TugLinearGauge
              value={60}
              min={0}
              max={100}
              density="compact"
              label="LOAD"
            />
          </div>
          <div style={matrixCellStyle}>
            <TugLinearGauge
              value={60}
              min={0}
              max={100}
              density="compact"
              label="LOAD"
              thresholds={{ caution: 0.75, danger: 0.9 }}
            />
          </div>
          <div style={matrixCellStyle}>
            <TugLinearGauge
              value={95}
              min={0}
              max={100}
              density="compact"
              label="LOAD"
              thresholds={{ caution: 0.75, danger: 0.9 }}
            />
          </div>

          {/* Row 3 — showcase (detailed) */}
          <span style={matrixRowLabelStyle}>
            SHOWCASE
            <br />
            (detailed)
          </span>
          <div style={matrixCellStyle}>
            <TugLinearGauge
              value={60}
              min={0}
              max={100}
              density="detailed"
              label="QUANTITY"
            />
          </div>
          <div style={matrixCellStyle}>
            <TugLinearGauge
              value={60}
              min={0}
              max={100}
              density="detailed"
              label="QUANTITY"
              thresholds={{ caution: 0.75, danger: 0.9 }}
            />
          </div>
          <div style={matrixCellStyle}>
            <TugLinearGauge
              value={95}
              min={0}
              max={100}
              density="detailed"
              label="QUANTITY"
              thresholds={{ caution: 0.75, danger: 0.9 }}
            />
          </div>
        </div>
      </div>

      <TugSeparator />

      {/* ============================================================
          3. Use-case preview — dev-meter strip
          ============================================================ */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">
          Use-case preview — dev-meter strip
        </TugLabel>
        <div style={labelStyle}>
          Renders the <code>32.5k / 200k TOKENS</code> example value
          from the <a href="#step-20-3">[#step-20-3]</a> layout sketch
          using <code>density="compact"</code>,{" "}
          <code>formatValue</code> + <code>label</code>, and{" "}
          <code>thresholds={"{ caution: 0.75, danger: 0.9 }"}</code>.
          Acts as the contract example for the eventual chrome consumer.
        </div>
        <div style={{ maxWidth: "28rem" }}>
          <TugLinearGauge
            value={32_500}
            min={0}
            max={200_000}
            thresholds={{ caution: 0.75, danger: 0.9 }}
            label="TOKENS"
            formatValue={(v) => `${formatTokens(v)} / ${formatTokens(200_000)}`}
            density="compact"
          />
        </div>
      </div>
    </div>
  );
}
