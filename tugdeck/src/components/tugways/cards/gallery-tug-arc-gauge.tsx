/**
 * gallery-tug-arc-gauge.tsx — `TugArcGauge` demo tab for the
 * Component Gallery.
 *
 * Four sections — see [#step-20-2](dash/session-assistant-rendering.md#step-20-2):
 *
 *   1. Interactive sandbox — slider for `value`, numeric inputs for
 *      `min` / `max`, toggles for `density`, `fillRole`, label,
 *      caution / danger thresholds, AND start / sweep angles for the
 *      custom geometry. The gauge re-renders live; sweep the slider
 *      to confirm color transitions match expectation and that the
 *      arc redraws smoothly across the 180° boundary where the SVG
 *      `large-arc-flag` flips from 0 to 1.
 *   2. Scale × threshold matrix — three scales (chrome strip ~32 px
 *      diameter → readable ~80 px → showcase ~180 px) across three
 *      threshold configs (no thresholds → below caution → above
 *      danger). Mirrors the linear gauge's matrix structure so the
 *      two primitives can be visually compared at matching scales.
 *   3. Geometry variants — five different arc shapes at the readable
 *      scale: default "C" sweep, full circle, top half-circle,
 *      top-right quarter-arc, top-left quarter-arc. Gates that the
 *      `geometry` prop produces sensible output at non-default
 *      angles.
 *
 * @module components/tugways/cards/gallery-tug-arc-gauge
 */

import React from "react";

import { TugArcGauge } from "@/components/tugways/tug-arc-gauge";
import type {
  TugArcGaugeDensity,
  TugArcGaugeGeometry,
  TugArcGaugeSegment,
} from "@/components/tugways/tug-arc-gauge";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

// ---------------------------------------------------------------------------
// Inline styles — kept module-local to mirror sibling gallery cards.
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
  gap: "1rem 1.25rem",
  alignItems: "center",
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

const geometryRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(5, 1fr)",
  gap: "1rem",
  alignItems: "end",
};

const geometryCellStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "0.5rem",
};

const geometryCellLabelStyle: React.CSSProperties = {
  fontFamily: "var(--tug-font-family-mono)",
  fontSize: "0.6875rem",
  color: "var(--tug7-element-global-text-normal-muted-rest)",
  textAlign: "center",
};

// ---------------------------------------------------------------------------
// Cell wrappers that pin the gauge size at each scale.
// ---------------------------------------------------------------------------

const STRIP_SIZE: React.CSSProperties = { width: "32px" };
const READABLE_SIZE: React.CSSProperties = { width: "80px" };
const SHOWCASE_SIZE: React.CSSProperties = { width: "180px" };

// ---------------------------------------------------------------------------
// Predefined geometry variants for the third section.
// ---------------------------------------------------------------------------

interface GeometryVariant {
  label: string;
  geometry: TugArcGaugeGeometry;
}

const GEOMETRY_VARIANTS: ReadonlyArray<GeometryVariant> = [
  { label: "default C-sweep", geometry: { startAngleDeg: 135, sweepAngleDeg: 270 } },
  { label: "full circle", geometry: { startAngleDeg: 0, sweepAngleDeg: 360 } },
  { label: "top half-circle", geometry: { startAngleDeg: 180, sweepAngleDeg: 180 } },
  { label: "top-left quarter", geometry: { startAngleDeg: 180, sweepAngleDeg: 90 } },
  { label: "top-right quarter", geometry: { startAngleDeg: 270, sweepAngleDeg: 90 } },
];

// ---------------------------------------------------------------------------
// Segmented-mode demo scenarios — categorical breakdowns of context-window
// utilization across representative session shapes. Each segment's `value`
// is in the same domain as the gauge's `max` (`100` here — percent of
// context capacity); the gauge auto-synthesizes a "remainder" slice when
// the segments sum below `max`. See [#step-20-4-7-b].
// ---------------------------------------------------------------------------

interface SegmentScenario {
  label: string;
  segments: ReadonlyArray<TugArcGaugeSegment>;
}

const SEGMENT_SCENARIOS: ReadonlyArray<SegmentScenario> = [
  {
    label: "two slices (5%)",
    segments: [
      { id: "input", tone: "input", value: 3, label: "Input" },
      { id: "output", tone: "output", value: 2, label: "Output" },
    ],
  },
  {
    label: "three slices (30%)",
    segments: [
      { id: "input", tone: "input", value: 12, label: "Input" },
      { id: "cache-read", tone: "cache-read", value: 10, label: "Cache (read)" },
      { id: "output", tone: "output", value: 8, label: "Output" },
    ],
  },
  {
    label: "four slices (60%)",
    segments: [
      { id: "input", tone: "input", value: 20, label: "Input" },
      { id: "cache-read", tone: "cache-read", value: 15, label: "Cache (read)" },
      { id: "cache-creation", tone: "cache-creation", value: 10, label: "Cache (creation)" },
      { id: "output", tone: "output", value: 15, label: "Output" },
    ],
  },
  {
    label: "near-cap (95%)",
    segments: [
      { id: "input", tone: "input", value: 38, label: "Input" },
      { id: "cache-read", tone: "cache-read", value: 30, label: "Cache (read)" },
      { id: "cache-creation", tone: "cache-creation", value: 12, label: "Cache (creation)" },
      { id: "output", tone: "output", value: 15, label: "Output" },
    ],
  },
  {
    label: "saturated (no remainder)",
    segments: [
      { id: "input", tone: "input", value: 40, label: "Input" },
      { id: "cache-read", tone: "cache-read", value: 25, label: "Cache (read)" },
      { id: "cache-creation", tone: "cache-creation", value: 15, label: "Cache (creation)" },
      { id: "output", tone: "output", value: 20, label: "Output" },
    ],
  },
];

// Per-category breakdown scenarios — the rich Context popover's
// shape (`#step-20-4-7-d`). Two scenarios sit side-by-side so the
// gallery shows the autocompact-on vs autocompact-off conditional
// at a glance: identical static categories, identical messages,
// only the reserved-buffer slice toggles. Values are scaled to a
// max of 100 (% of context window) for easy visual reading.
const CONTEXT_BREAKDOWN_SCENARIOS: ReadonlyArray<SegmentScenario> = [
  {
    label: "/context breakdown — autocompact off",
    segments: [
      { id: "system_prompt", tone: "system_prompt", value: 2, label: "System prompt" },
      { id: "system_tools", tone: "system_tools", value: 5, label: "System tools" },
      { id: "custom_agents", tone: "custom_agents", value: 7, label: "Custom agents" },
      { id: "memory_files", tone: "memory_files", value: 1, label: "Memory files" },
      { id: "skills", tone: "skills", value: 5, label: "Skills" },
      { id: "messages", tone: "messages", value: 28, label: "Messages" },
    ],
  },
  {
    label: "/context breakdown — autocompact on",
    segments: [
      { id: "system_prompt", tone: "system_prompt", value: 2, label: "System prompt" },
      { id: "system_tools", tone: "system_tools", value: 5, label: "System tools" },
      { id: "custom_agents", tone: "custom_agents", value: 7, label: "Custom agents" },
      { id: "memory_files", tone: "memory_files", value: 1, label: "Memory files" },
      { id: "skills", tone: "skills", value: 5, label: "Skills" },
      { id: "messages", tone: "messages", value: 28, label: "Messages" },
      { id: "autocompact_buffer", tone: "autocompact_buffer", value: 17, label: "Autocompact buffer" },
    ],
  },
];

const SEGMENT_TONE_LABELS: Record<TugArcGaugeSegment["tone"], string> = {
  // Wire-level cost vocabulary (`#step-20-4-7-c`).
  input: "Input",
  "cache-read": "Cache (read)",
  "cache-creation": "Cache (creation)",
  output: "Output",
  remainder: "Unused",
  // `/context`-style category vocabulary (`#step-20-4-7-d`).
  system_prompt: "System prompt",
  system_tools: "System tools",
  custom_agents: "Custom agents",
  memory_files: "Memory files",
  skills: "Skills",
  messages: "Messages",
  autocompact_buffer: "Autocompact buffer",
};

const segmentScenariosRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(5, 1fr)",
  gap: "1rem",
  alignItems: "start",
};

const segmentSwatchStyle: React.CSSProperties = {
  display: "inline-block",
  width: "10px",
  height: "10px",
  borderRadius: "2px",
  marginRight: "6px",
  verticalAlign: "middle",
};

const legendStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "2px",
  marginTop: "var(--tug-space-xs)",
  fontFamily: "var(--tug-font-family-mono)",
  fontSize: "0.6875rem",
  color: "var(--tug7-element-global-text-normal-muted-rest)",
};

/**
 * Map a `TugArcGaugeSegment["tone"]` to its CSS custom property — the
 * gallery's legend swatches read the same `--tugx-arc-gauge-segment-*-
 * color` variables the SVG segments themselves read, so swatches and
 * arcs stay in lockstep across themes.
 */
function segmentToneCssVar(tone: TugArcGaugeSegment["tone"]): string {
  return `var(--tugx-arc-gauge-segment-${tone}-color)`;
}

// ---------------------------------------------------------------------------
// GalleryTugArcGauge
// ---------------------------------------------------------------------------

export function GalleryTugArcGauge(): React.ReactElement {
  // Interactive sandbox state.
  const [value, setValue] = React.useState<number>(60);
  const [min, setMin] = React.useState<number>(0);
  const [max, setMax] = React.useState<number>(100);
  const [density, setDensity] =
    React.useState<TugArcGaugeDensity>("detailed");
  const [fillRole, setFillRole] =
    React.useState<"default" | "info" | "success">("default");
  const [labelText, setLabelText] = React.useState<string>("LOAD");
  const [cautionPct, setCautionPct] = React.useState<number>(75);
  const [dangerPct, setDangerPct] = React.useState<number>(90);
  const [startAngle, setStartAngle] = React.useState<number>(135);
  const [sweepAngle, setSweepAngle] = React.useState<number>(270);

  const thresholds = React.useMemo(
    () => ({ caution: cautionPct / 100, danger: dangerPct / 100 }),
    [cautionPct, dangerPct],
  );

  const geometry = React.useMemo(
    () => ({ startAngleDeg: startAngle, sweepAngleDeg: sweepAngle }),
    [startAngle, sweepAngle],
  );

  return (
    <div className="cg-content" data-testid="gallery-tug-arc-gauge">
      {/* ============================================================
          1. Interactive sandbox
          ============================================================ */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Interactive sandbox</TugLabel>
        <div style={labelStyle}>
          Tune <code>value</code>, density, <code>fillRole</code>, the
          caution / danger thresholds, AND the arc's{" "}
          <code>startAngleDeg</code> / <code>sweepAngleDeg</code>.
          Sweep the value slider to verify the arc redraws smoothly
          across the 180° boundary where the SVG{" "}
          <code>large-arc-flag</code> flips.
        </div>

        <div style={controlsRowStyle}>
          <div style={{ ...controlGroupStyle, flex: "1 1 14rem" }}>
            <label style={fieldLabelStyle} htmlFor="cg-arcgauge-value">
              value ({value.toFixed(1)})
            </label>
            <input
              id="cg-arcgauge-value"
              type="range"
              min={min}
              max={max}
              step={(max - min) / 200}
              value={value}
              onChange={(e) => setValue(Number(e.currentTarget.value))}
            />
          </div>
          <div style={controlGroupStyle}>
            <label style={fieldLabelStyle} htmlFor="cg-arcgauge-min">min</label>
            <input
              id="cg-arcgauge-min"
              type="number"
              style={inputStyle}
              value={min}
              onChange={(e) => setMin(Number(e.currentTarget.value))}
            />
          </div>
          <div style={controlGroupStyle}>
            <label style={fieldLabelStyle} htmlFor="cg-arcgauge-max">max</label>
            <input
              id="cg-arcgauge-max"
              type="number"
              style={inputStyle}
              value={max}
              onChange={(e) => setMax(Number(e.currentTarget.value))}
            />
          </div>
          <div style={controlGroupStyle}>
            <label style={fieldLabelStyle} htmlFor="cg-arcgauge-density">
              density
            </label>
            <select
              id="cg-arcgauge-density"
              style={inputStyle}
              value={density}
              onChange={(e) =>
                setDensity(e.currentTarget.value as TugArcGaugeDensity)
              }
            >
              <option value="compact">compact</option>
              <option value="detailed">detailed</option>
            </select>
          </div>
          <div style={controlGroupStyle}>
            <label style={fieldLabelStyle} htmlFor="cg-arcgauge-fillrole">
              fillRole
            </label>
            <select
              id="cg-arcgauge-fillrole"
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
            <label style={fieldLabelStyle} htmlFor="cg-arcgauge-label">label</label>
            <input
              id="cg-arcgauge-label"
              type="text"
              style={inputStyle}
              value={labelText}
              onChange={(e) => setLabelText(e.currentTarget.value)}
            />
          </div>
          <div style={controlGroupStyle}>
            <label style={fieldLabelStyle} htmlFor="cg-arcgauge-caution">
              caution %
            </label>
            <input
              id="cg-arcgauge-caution"
              type="number"
              min={0}
              max={100}
              style={inputStyle}
              value={cautionPct}
              onChange={(e) => setCautionPct(Number(e.currentTarget.value))}
            />
          </div>
          <div style={controlGroupStyle}>
            <label style={fieldLabelStyle} htmlFor="cg-arcgauge-danger">
              danger %
            </label>
            <input
              id="cg-arcgauge-danger"
              type="number"
              min={0}
              max={100}
              style={inputStyle}
              value={dangerPct}
              onChange={(e) => setDangerPct(Number(e.currentTarget.value))}
            />
          </div>
          <div style={controlGroupStyle}>
            <label style={fieldLabelStyle} htmlFor="cg-arcgauge-start">
              start °
            </label>
            <input
              id="cg-arcgauge-start"
              type="number"
              min={0}
              max={359}
              style={inputStyle}
              value={startAngle}
              onChange={(e) => setStartAngle(Number(e.currentTarget.value))}
            />
          </div>
          <div style={controlGroupStyle}>
            <label style={fieldLabelStyle} htmlFor="cg-arcgauge-sweep">
              sweep °
            </label>
            <input
              id="cg-arcgauge-sweep"
              type="number"
              min={0}
              max={360}
              style={inputStyle}
              value={sweepAngle}
              onChange={(e) => setSweepAngle(Number(e.currentTarget.value))}
            />
          </div>
        </div>

        <div style={{ width: "200px" }}>
          <TugArcGauge
            value={value}
            min={min}
            max={max}
            thresholds={thresholds}
            label={labelText !== "" ? labelText : undefined}
            density={density}
            fillRole={fillRole}
            geometry={geometry}
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
          Three scales (chrome strip → readable → showcase) across
          three threshold configurations. Mirrors the linear-gauge
          matrix so the two primitives can be compared at matching
          scales.
        </div>

        <div style={matrixStyle}>
          {/* Header row */}
          <span />
          <span style={matrixHeaderStyle}>no thresholds</span>
          <span style={matrixHeaderStyle}>below caution (60%)</span>
          <span style={matrixHeaderStyle}>above danger (95%)</span>

          {/* Row 1 — strip */}
          <span style={matrixRowLabelStyle}>
            STRIP
            <br />
            (~32 px, compact)
          </span>
          <div style={STRIP_SIZE}>
            <TugArcGauge value={60} min={0} max={100} density="compact" />
          </div>
          <div style={STRIP_SIZE}>
            <TugArcGauge
              value={60}
              min={0}
              max={100}
              density="compact"
              thresholds={{ caution: 0.75, danger: 0.9 }}
            />
          </div>
          <div style={STRIP_SIZE}>
            <TugArcGauge
              value={95}
              min={0}
              max={100}
              density="compact"
              thresholds={{ caution: 0.75, danger: 0.9 }}
            />
          </div>

          {/* Row 2 — readable (compact + label) */}
          <span style={matrixRowLabelStyle}>
            READABLE
            <br />
            (~80 px, compact + label)
          </span>
          <div style={READABLE_SIZE}>
            <TugArcGauge
              value={60}
              min={0}
              max={100}
              density="compact"
              label="LOAD"
            />
          </div>
          <div style={READABLE_SIZE}>
            <TugArcGauge
              value={60}
              min={0}
              max={100}
              density="compact"
              label="LOAD"
              thresholds={{ caution: 0.75, danger: 0.9 }}
            />
          </div>
          <div style={READABLE_SIZE}>
            <TugArcGauge
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
            (~180 px, detailed)
          </span>
          <div style={SHOWCASE_SIZE}>
            <TugArcGauge
              value={60}
              min={0}
              max={100}
              density="detailed"
              label="QUANTITY"
            />
          </div>
          <div style={SHOWCASE_SIZE}>
            <TugArcGauge
              value={60}
              min={0}
              max={100}
              density="detailed"
              label="QUANTITY"
              thresholds={{ caution: 0.75, danger: 0.9 }}
            />
          </div>
          <div style={SHOWCASE_SIZE}>
            <TugArcGauge
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
          3. Geometry variants
          ============================================================ */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">
          Geometry variants
        </TugLabel>
        <div style={labelStyle}>
          Five different arc shapes at the readable (compact) scale.
          Same <code>value=60</code>; only <code>geometry</code>{" "}
          differs. Gates that the prop produces sensible output at
          non-default angles and that the full-circle branch (two
          semicircle arcs) renders without seams.
        </div>

        <div style={geometryRowStyle}>
          {GEOMETRY_VARIANTS.map((variant) => (
            <div key={variant.label} style={geometryCellStyle}>
              <div style={READABLE_SIZE}>
                <TugArcGauge
                  value={60}
                  min={0}
                  max={100}
                  density="compact"
                  geometry={variant.geometry}
                />
              </div>
              <span style={geometryCellLabelStyle}>
                {variant.label}
                <br />
                <code>
                  {variant.geometry.startAngleDeg}° /{" "}
                  {variant.geometry.sweepAngleDeg}°
                </code>
              </span>
            </div>
          ))}
        </div>
      </div>

      <TugSeparator />

      {/* ============================================================
          4. Segmented mode — categorical breakdown
          ============================================================ */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">
          Segmented mode (categorical breakdown)
        </TugLabel>
        <div style={labelStyle}>
          Pass <code>segments</code> instead of (or alongside)
          <code>value</code> to paint the arc as a sequence of per-tone
          slices. Segments paint left-to-right in array order; when
          their values sum below <code>max</code> the gauge auto-
          synthesizes a muted <em>remainder</em> slice that fills the
          unused capacity. Five canonical tones are wired: input,
          cache-read, cache-creation, output, and the remainder slot.
          Foundational for the Context popover (20.4.7.C); useful for
          any categorical-vs-max breakdown.
        </div>

        <div style={segmentScenariosRowStyle}>
          {SEGMENT_SCENARIOS.map((scenario) => (
            <div key={scenario.label} style={geometryCellStyle}>
              <div style={READABLE_SIZE}>
                <TugArcGauge
                  min={0}
                  max={100}
                  value={0}
                  density="compact"
                  segments={scenario.segments}
                />
              </div>
              <span style={geometryCellLabelStyle}>{scenario.label}</span>
              <div style={legendStyle}>
                {scenario.segments.map((s) => (
                  <span key={s.id}>
                    <span
                      style={{
                        ...segmentSwatchStyle,
                        backgroundColor: segmentToneCssVar(s.tone),
                      }}
                    />
                    {s.label ?? SEGMENT_TONE_LABELS[s.tone]}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <TugSeparator />

      {/* ============================================================
          5. `/context`-style breakdown — autocompact-on / off
          ============================================================ */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">
          /context breakdown (autocompact-on / off)
        </TugLabel>
        <div style={labelStyle}>
          Seven category tones surface the rich Context popover shape
          (#step-20-4-7-d): system_prompt, system_tools, custom_agents,
          memory_files, skills, messages, and the conditional
          autocompact_buffer. The two cards below carry identical
          static categories and the same messages count — only the
          reserved-buffer slice toggles. <code>mcp_tools</code> is
          intentionally absent: Tug treats MCP as out of scope, so
          the wire frame never carries it and the renderer never
          paints a slice for it.
        </div>

        <div style={segmentScenariosRowStyle}>
          {CONTEXT_BREAKDOWN_SCENARIOS.map((scenario) => (
            <div key={scenario.label} style={geometryCellStyle}>
              <div style={READABLE_SIZE}>
                <TugArcGauge
                  min={0}
                  max={100}
                  value={0}
                  density="compact"
                  segments={scenario.segments}
                />
              </div>
              <span style={geometryCellLabelStyle}>{scenario.label}</span>
              <div style={legendStyle}>
                {scenario.segments.map((s) => (
                  <span key={s.id}>
                    <span
                      style={{
                        ...segmentSwatchStyle,
                        backgroundColor: segmentToneCssVar(s.tone),
                      }}
                    />
                    {s.label ?? SEGMENT_TONE_LABELS[s.tone]}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
