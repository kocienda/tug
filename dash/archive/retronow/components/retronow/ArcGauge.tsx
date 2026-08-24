"use client";

type ArcGaugeUnit = "none" | "k" | "m" | "g";
type ArcGaugeAccent = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | string;

export type ArcGaugeProps = {
  lo: number;
  value: number;
  hi: number;
  emptyWarning?: number;
  fullWarning?: number;
  scalePercent?: number;
  majorTicksTotal?: number;
  minorTicksBetweenMajor?: number;
  formatUnit?: ArcGaugeUnit;
  decimalDigits?: number;
  label?: string;
  showOuterTrack?: boolean;
  showValueTrack?: boolean;
  showMajorTicks?: boolean;
  showMinorTicks?: boolean;
  showValueNumeral?: boolean;
  showPercentage?: boolean;
  showHiLo?: boolean;
  showGaugeLabel?: boolean;
  valueOrder?: number;
  percentageOrder?: number;
  labelOrder?: number;
  valueScale?: number;
  percentageScale?: number;
  labelScale?: number;
  showReadout?: boolean;
  valueAccent?: ArcGaugeAccent;
  emptyWarningAccent?: ArcGaugeAccent;
  fullWarningAccent?: ArcGaugeAccent;
  className?: string;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const normalizeRange = (value: number, lo: number, hi: number) => {
  if (!Number.isFinite(value) || !Number.isFinite(lo) || !Number.isFinite(hi) || hi === lo) return 0;
  return clamp(((value - lo) / (hi - lo)) * 100, 0, 100);
};

const polarToCartesian = (cx: number, cy: number, radius: number, angleDeg: number) => {
  const angle = (angleDeg - 90) * (Math.PI / 180);
  return {
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle)
  };
};

const arcPath = (cx: number, cy: number, radius: number, startAngle: number, endAngle: number) => {
  const start = polarToCartesian(cx, cy, radius, endAngle);
  const end = polarToCartesian(cx, cy, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
};

const resolveAccentColor = (accent: ArcGaugeAccent | undefined, fallback: number) => {
  if (typeof accent === "number" && accent >= 1 && accent <= 8) return `var(--rn-accent-${accent})`;
  if (typeof accent === "string") {
    if (/^[1-8]$/.test(accent)) return `var(--rn-accent-${accent})`;
    return accent;
  }
  return `var(--rn-accent-${fallback})`;
};

const formatScaledValue = (value: number, unit: ArcGaugeUnit, digits: number) => {
  const unitScaleMap: Record<ArcGaugeUnit, number> = {
    none: 1,
    k: 1e3,
    m: 1e6,
    g: 1e9
  };
  const suffix = unit === "none" ? "" : unit;
  const scale = unitScaleMap[unit];
  const safeDigits = clamp(Math.round(digits), 0, 4);
  if (!Number.isFinite(value)) return `${(0).toFixed(safeDigits)}${suffix}`;
  return `${(value / scale).toFixed(safeDigits)}${suffix}`;
};

type TickProps = {
  cx: number;
  cy: number;
  start: number;
  sweep: number;
  rOuter: number;
  rMajor: number;
  rMinor: number;
  majorTickCount: number;
  minorTicksBetween: number;
  emptyWarningPct: number;
  fullWarningPct: number;
  emptyWarningColor: string;
  fullWarningColor: string;
};

function buildTicks({
  cx,
  cy,
  start,
  sweep,
  rOuter,
  rMajor,
  rMinor,
  majorTickCount,
  minorTicksBetween,
  emptyWarningPct,
  fullWarningPct,
  emptyWarningColor,
  fullWarningColor
}: TickProps) {
  const majorCount = Math.max(2, Math.round(majorTickCount));
  const minorBetween = Math.max(0, Math.round(minorTicksBetween));
  const majorStep = minorBetween + 1;
  const totalSteps = (majorCount - 1) * majorStep;
  const major: Array<{ x1: number; y1: number; x2: number; y2: number; stroke: string }> = [];
  const minor: Array<{ x1: number; y1: number; x2: number; y2: number; stroke: string }> = [];

  for (let i = 0; i <= totalSteps; i += 1) {
    const a = start + (sweep * i) / totalSteps;
    const outer = polarToCartesian(cx, cy, rOuter, a);
    const isMajor = i % majorStep === 0;
    const inner = polarToCartesian(cx, cy, isMajor ? rMajor : rMinor, a);
    const pct = (i / totalSteps) * 100;
    const inEmptyWarning = pct <= emptyWarningPct;
    const inFullWarning = pct >= fullWarningPct;
    const stroke = inEmptyWarning
      ? emptyWarningColor
      : inFullWarning
        ? fullWarningColor
        : isMajor
          ? "var(--rn-text-soft)"
          : "var(--rn-border-soft)";
    const line = {
      x1: Number(outer.x.toFixed(2)),
      y1: Number(outer.y.toFixed(2)),
      x2: Number(inner.x.toFixed(2)),
      y2: Number(inner.y.toFixed(2)),
      stroke
    };
    if (isMajor) major.push(line);
    else minor.push(line);
  }

  return { major, minor };
}

export function ArcGauge({
  lo,
  value,
  hi,
  emptyWarning = 10,
  fullWarning = 90,
  scalePercent = 100,
  majorTicksTotal = 9,
  minorTicksBetweenMajor = 4,
  formatUnit = "k",
  decimalDigits = 1,
  label = "ARC",
  showOuterTrack = true,
  showValueTrack = true,
  showMajorTicks = true,
  showMinorTicks = true,
  showValueNumeral = true,
  showPercentage = true,
  showHiLo = true,
  showGaugeLabel = true,
  valueOrder = 1,
  percentageOrder = 2,
  labelOrder = 3,
  valueScale = 1,
  percentageScale = 1,
  labelScale = 1,
  showReadout = true,
  valueAccent = 1,
  emptyWarningAccent = 6,
  fullWarningAccent = 4,
  className
}: ArcGaugeProps) {
  const cEmpty = clamp(emptyWarning, 0, 100);
  const cFull = clamp(fullWarning, cEmpty, 100);
  const scale = clamp(scalePercent, 60, 160) / 100;
  const pct = normalizeRange(value, lo, hi);

  const cx = 180;
  const cy = 104;
  const radius = 74;
  const start = -130;
  const fullEnd = 130;
  const sweep = fullEnd - start;
  const end = start + (sweep * pct) / 100;
  const needleAngle = start + (sweep * pct) / 100;

  const valueColor = resolveAccentColor(valueAccent, 1);
  const emptyWarningColor = resolveAccentColor(emptyWarningAccent, 6);
  const fullWarningColor = resolveAccentColor(fullWarningAccent, 4);
  const emptyWarningEnabled = cEmpty > 0;
  const fullWarningEnabled = cFull < 100;
  const valueTrackColor = fullWarningEnabled && pct >= cFull
    ? fullWarningColor
    : emptyWarningEnabled && pct <= cEmpty
      ? emptyWarningColor
      : valueColor;

  const ticks = buildTicks({
    cx,
    cy,
    start,
    sweep,
    rOuter: radius - 4,
    rMajor: radius - 17,
    rMinor: radius - 12,
    majorTickCount: majorTicksTotal,
    minorTicksBetween: minorTicksBetweenMajor,
    emptyWarningPct: cEmpty,
    fullWarningPct: cFull,
    emptyWarningColor,
    fullWarningColor
  });

  const formattedValue = formatScaledValue(value, formatUnit, decimalDigits);
  const formattedLo = formatScaledValue(lo, formatUnit, decimalDigits);
  const formattedHi = formatScaledValue(hi, formatUnit, decimalDigits);
  const textRows: Array<{ key: string; text: string; order: number; scale: number; baseSize: number; weight: string }> = [];
  if (showValueNumeral) {
    textRows.push({ key: "value", text: formattedValue, order: clamp(valueOrder, 1, 3), scale: clamp(valueScale, 0.5, 3), baseSize: 16, weight: "400" });
  }
  if (showPercentage) {
    textRows.push({
      key: "percentage",
      text: `${pct.toFixed(1)}%`,
      order: clamp(percentageOrder, 1, 3),
      scale: clamp(percentageScale, 0.5, 3),
      baseSize: 12,
      weight: "400"
    });
  }
  if (showGaugeLabel) {
    textRows.push({ key: "label", text: label, order: clamp(labelOrder, 1, 3), scale: clamp(labelScale, 0.5, 3), baseSize: 14, weight: "700" });
  }
  textRows.sort((a, b) => (a.order === b.order ? a.key.localeCompare(b.key) : a.order - b.order));
  let rowY = cy + 24;
  const positionedRows = textRows.map((row) => {
    const size = row.baseSize * row.scale;
    rowY += size;
    const y = rowY;
    rowY += 4;
    return { ...row, y, size };
  });

  return (
    <div
      className={[
        "grid justify-items-center gap-2 rounded-[4px] border border-[var(--rn-border)] bg-[linear-gradient(180deg,var(--rn-bg-soft)_0%,var(--rn-bg)_100%)] p-[7px]",
        className || ""
      ].join(" ")}
    >
      <div className="w-full rounded-[3px] border border-[var(--rn-border-soft)] bg-[var(--rn-surface-4)] p-[6px]">
        <svg
          viewBox="0 0 360 200"
          role="img"
          aria-label={`${label} arc gauge`}
          style={{
            width: `min(100%, ${(360 * scale).toFixed(0)}px)`,
            height: `${(200 * scale).toFixed(0)}px`,
            display: "block"
          }}
        >
          <circle cx={cx} cy={cy} r={radius} fill="var(--rn-surface-4)" stroke="none" />

          {showMinorTicks ? (
            <g>
              {ticks.minor.map((tick, idx) => (
                <line
                  key={`minor-${idx}`}
                  x1={tick.x1}
                  y1={tick.y1}
                  x2={tick.x2}
                  y2={tick.y2}
                  stroke={tick.stroke}
                  strokeWidth="1"
                  strokeOpacity="1"
                />
              ))}
            </g>
          ) : null}

          {showMajorTicks ? (
            <g>
              {ticks.major.map((tick, idx) => (
                <line
                  key={`major-${idx}`}
                  x1={tick.x1}
                  y1={tick.y1}
                  x2={tick.x2}
                  y2={tick.y2}
                  stroke={tick.stroke}
                  strokeWidth="2"
                  strokeOpacity="1"
                />
              ))}
            </g>
          ) : null}

          {showOuterTrack ? (
            <path d={arcPath(cx, cy, radius, start, fullEnd)} fill="none" stroke="var(--rn-border-soft)" strokeWidth="11" strokeLinecap="round" />
          ) : null}

          {showValueTrack ? (
            <path d={end > start ? arcPath(cx, cy, radius, start, end) : ""} fill="none" stroke={valueTrackColor} strokeWidth="5" strokeLinecap="round" />
          ) : null}

          <line
            x1={cx}
            y1={cy}
            x2={cx}
            y2={cy - (radius - 10)}
            stroke={valueColor}
            strokeWidth="3"
            strokeLinecap="round"
            transform={`rotate(${needleAngle.toFixed(2)} ${cx} ${cy})`}
          />
          <circle cx={cx} cy={cy} r="7" fill="var(--rn-bg-soft)" stroke="var(--rn-surface-4)" />

          {showHiLo ? (
            <>
              <text x={cx - radius - 42} y={cy + radius + 10} fill="var(--rn-text-soft)" fontFamily="var(--rn-font-mono)" fontSize="11">
                {`LO ${formattedLo}`}
              </text>
              <text x={cx + radius - 8} y={cy + radius + 10} fill="var(--rn-text-soft)" fontFamily="var(--rn-font-mono)" fontSize="11">
                {`HI ${formattedHi}`}
              </text>
            </>
          ) : null}

          {positionedRows.map((row) => (
            <text
              key={row.key}
              x={cx}
              y={row.y}
              textAnchor="middle"
              fill={row.key === "value" ? "var(--rn-text)" : "var(--rn-text-soft)"}
              fontFamily="var(--rn-font-mono)"
              fontSize={row.size.toFixed(1)}
              fontWeight={row.weight}
            >
              {row.text}
            </text>
          ))}
        </svg>
      </div>

      {showReadout ? (
        <div className="font-mono text-[0.72rem] text-[var(--rn-text-inverse)]">
          {`Normalized ${pct.toFixed(1)}% in range [${formattedLo}, ${formattedHi}] / emptyWarning ${cEmpty.toFixed(0)}% / fullWarning ${cFull.toFixed(0)}%`}
        </div>
      ) : null}
    </div>
  );
}

