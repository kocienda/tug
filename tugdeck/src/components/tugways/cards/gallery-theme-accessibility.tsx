import React, { useMemo } from "react";
import { useOptionalThemeContext } from "@/contexts/theme-provider";
import { TUG_TOKEN_NAMES } from "@/generated/tug-token-names";
import { snapshotLiveThemeTokens, type LiveResolvedColor } from "@/components/tugways/theme-live-snapshot";
import {
  validateThemeContrast,
  checkCVDDistinguishability,
  CVD_SEMANTIC_PAIRS,
  simulateCVDFromOKLCH,
  WCAG_CONTRAST_THRESHOLDS,
  CONTRAST_THRESHOLDS,
  CONTRAST_MARGINAL_DELTA,
  oklchToHex,
  type CVDType,
  type ContrastResult,
  type CVDWarning,
} from "@/components/tugways/theme-accessibility";
import { ELEMENT_SURFACE_PAIRING_MAP } from "@/components/tugways/theme-pairings";
import { TugButton } from "@/components/tugways/internal/tug-button";
import type { TugButtonEmphasis, TugButtonRole } from "@/components/tugways/internal/tug-button";
import { TugBadge } from "@/components/tugways/tug-badge";
import type { TugBadgeEmphasis, TugBadgeRole } from "@/components/tugways/tug-badge";
import { TugCheckbox } from "@/components/tugways/tug-checkbox";
import type { TugCheckboxRole } from "@/components/tugways/tug-checkbox";
import { TugSwitch } from "@/components/tugways/tug-switch";
import type { TugSwitchRole } from "@/components/tugways/tug-switch";
import "./gallery-theme-accessibility.css";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const CVD_TYPES: CVDType[] = ["protanopia", "deuteranopia", "tritanopia", "achromatopsia"];

const CVD_TYPE_LABELS: Record<CVDType, string> = {
  protanopia: "Protanopia",
  deuteranopia: "Deuteranopia",
  tritanopia: "Tritanopia",
  achromatopsia: "Achromatopsia",
};

const CVD_SEMANTIC_TOKENS: Array<{ token: string; label: string }> = [
  { token: "--tug7-element-tone-fill-normal-accent-rest", label: "Accent" },
  { token: "--tug7-element-tone-fill-normal-active-rest", label: "Active" },
  { token: "--tug7-element-tone-fill-normal-agent-rest", label: "Agent" },
  { token: "--tug7-element-tone-fill-normal-data-rest", label: "Data" },
  { token: "--tug7-element-tone-fill-normal-success-rest", label: "Success" },
  { token: "--tug7-element-tone-fill-normal-caution-rest", label: "Caution" },
  { token: "--tug7-element-tone-fill-normal-danger-rest", label: "Danger" },
];

function linearSrgbToHex(linear: { r: number; g: number; b: number }): string {
  const encode = (c: number) => {
    const clamped = Math.max(0, Math.min(1, c));
    const gamma = clamped >= 0.0031308
      ? 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055
      : 12.92 * clamped;
    return Math.round(Math.max(0, Math.min(1, gamma)) * 255);
  };
  const r = encode(linear.r).toString(16).padStart(2, "0");
  const g = encode(linear.g).toString(16).padStart(2, "0");
  const b = encode(linear.b).toString(16).padStart(2, "0");
  return `#${r}${g}${b}`;
}

function swatchHex(resolved: LiveResolvedColor | null): string {
  if (!resolved) return "transparent";
  return oklchToHex(resolved.L, resolved.C, resolved.h);
}

function badgeVariant(result: ContrastResult): "pass" | "marginal" | "fail" | "decorative" {
  if (result.role === "decorative") return "decorative";
  if (result.contrastPass) return "pass";
  const threshold = CONTRAST_THRESHOLDS[result.role] ?? 15;
  if (Math.abs(result.contrast) >= threshold - CONTRAST_MARGINAL_DELTA) return "marginal";
  return "fail";
}

const BUTTON_EMPHASES: TugButtonEmphasis[] = ["filled", "outlined", "ghost"];
const BADGE_EMPHASES: TugBadgeEmphasis[] = ["filled", "outlined", "ghost"];
const BUTTON_ROLES: TugButtonRole[] = ["accent", "action", "data", "danger"];
const BADGE_ROLES: TugBadgeRole[] = ["accent", "action", "agent", "data", "success", "caution", "danger"];
const SELECTION_ROLES: TugCheckboxRole[] = ["action", "agent", "data", "success", "caution", "danger"];

function EmphasisRolePreview() {
  return (
    <div className="gta-emphasis-role-preview" data-testid="gta-emphasis-role-preview">
      <div className="gta-erp-subsection">
        <div className="gta-erp-subtitle">Buttons (3 emphasis x 4 roles)</div>
        <div className="gta-erp-button-grid" data-testid="gta-erp-button-grid">
          {BUTTON_EMPHASES.map((emphasis) => (
            <React.Fragment key={emphasis}>
              <div className="gta-erp-row-label">{emphasis}</div>
              {BUTTON_ROLES.map((role) => (
                <div key={role} className="gta-erp-cell">
                  <TugButton emphasis={emphasis} role={role} size="sm">{role}</TugButton>
                </div>
              ))}
            </React.Fragment>
          ))}
        </div>
      </div>
      <div className="gta-erp-subsection">
        <div className="gta-erp-subtitle">Badges (3 emphasis x 7 roles)</div>
        <div className="gta-erp-badge-grid" data-testid="gta-erp-badge-grid">
          {BADGE_EMPHASES.map((emphasis) => (
            <React.Fragment key={emphasis}>
              <div className="gta-erp-row-label">{emphasis}</div>
              {BADGE_ROLES.map((role) => (
                <div key={role} className="gta-erp-cell">
                  <TugBadge emphasis={emphasis} role={role}>{role}</TugBadge>
                </div>
              ))}
            </React.Fragment>
          ))}
        </div>
      </div>
      <div className="gta-erp-subsection">
        <div className="gta-erp-subtitle">Selection Controls (7 roles, checked)</div>
        <div className="gta-erp-selection-row" data-testid="gta-erp-selection-row">
          {SELECTION_ROLES.map((role) => (
            <div key={role} className="gta-erp-selection-cell">
              <div className="gta-erp-col-label">{role}</div>
              <TugCheckbox role={role} checked aria-label={`checkbox-${role}`} />
              <TugSwitch role={role as TugSwitchRole} checked aria-label={`switch-${role}`} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function GalleryThemeAccessibility() {
  const themeCtx = useOptionalThemeContext();
  const themeName = themeCtx?.theme ?? "brio";

  const requiredColorTokens = useMemo(() => {
    const set = new Set<string>();
    for (const pairing of ELEMENT_SURFACE_PAIRING_MAP) {
      set.add(pairing.element);
      set.add(pairing.surface);
      if (pairing.parentSurface) set.add(pairing.parentSurface);
    }
    for (const [a, b] of CVD_SEMANTIC_PAIRS) {
      set.add(a);
      set.add(b);
    }
    return set;
  }, []);

  // Recompute snapshot when the active theme changes.
  const snapshot = useMemo(
    () => snapshotLiveThemeTokens(TUG_TOKEN_NAMES, requiredColorTokens),
    [themeName, requiredColorTokens],
  );

  const contrastResults = useMemo(
    () => validateThemeContrast(snapshot.resolvedMap as Record<string, never>, ELEMENT_SURFACE_PAIRING_MAP),
    [snapshot.resolvedMap],
  );

  const cvdWarnings = useMemo<CVDWarning[]>(
    () => checkCVDDistinguishability(snapshot.resolvedMap as Record<string, never>, CVD_SEMANTIC_PAIRS),
    [snapshot.resolvedMap],
  );

  const unresolvedReferences = useMemo(() => {
    return [...requiredColorTokens].filter((token) => snapshot.resolvedMap[token] === undefined).sort();
  }, [requiredColorTokens, snapshot.resolvedMap]);

  const failingPairs = useMemo(
    () => contrastResults.filter((r) => !r.contrastPass && badgeVariant(r) === "fail"),
    [contrastResults],
  );
  const marginalPairs = useMemo(
    () => contrastResults.filter((r) => !r.contrastPass && badgeVariant(r) === "marginal"),
    [contrastResults],
  );

  const passCount = contrastResults.filter((r) => r.role !== "decorative" && r.contrastPass).length;
  const checkedCount = contrastResults.filter((r) => r.role !== "decorative").length;

  return (
    <div className="cg-content gta-content" data-testid="gallery-theme-accessibility">
      <div className="gta-header-row" data-testid="gta-doc-header">
        <div className="gta-doc-info" data-testid="gta-doc-info">
          <span className="gta-doc-name" data-testid="gta-doc-name">{themeName}</span>
          <span className="gta-doc-source-label" data-testid="gta-doc-source-label">live css</span>
          <span className="gta-doc-readonly-badge" data-testid="gta-doc-readonly-badge">Theme Accessibility</span>
        </div>
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">Controls</TugLabel>
        <EmphasisRolePreview />
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">{`Token Preview (${snapshot.entries.length} tokens)`}</TugLabel>
        <div className="gta-token-grid" data-testid="gta-token-grid">
          <div className="gta-token-header">
            <span>Token</span>
            <span>Color</span>
            <span>Value</span>
          </div>
          {snapshot.entries.map((entry) => (
            <React.Fragment key={entry.name}>
              <span className="gta-token-name" title={entry.name}>{entry.name}</span>
              <div
                className="gta-token-swatch"
                style={{ backgroundColor: swatchHex(entry.resolvedColor) }}
                title={entry.resolvedColor ? swatchHex(entry.resolvedColor) : "N/A"}
              />
              <span className="gta-token-value" title={entry.rawValue || "N/A"}>
                {entry.rawValue || "N/A"}
              </span>
            </React.Fragment>
          ))}
        </div>
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">Contrast Dashboard</TugLabel>
        <div className="gta-contrast-summary" data-testid="gta-contrast-summary">
          <span className="gta-contrast-summary-count" data-testid="gta-contrast-summary-count">{passCount}/{checkedCount}</span>
          <span>pairs pass contrast</span>
          <span style={{ color: "var(--tug7-element-global-text-normal-muted-rest)", marginLeft: "4px" }}>
            ({contrastResults.length} total pairs)
          </span>
        </div>
        <div className="gta-contrast-grid" data-testid="gta-contrast-grid">
          <div className="gta-contrast-col-header">
            <span>FG</span>
            <span>BG</span>
            <span>Foreground token</span>
            <span>Background token</span>
            <span>WCAG 2.x</span>
            <span>Contrast</span>
            <span>Badge</span>
          </div>
          {contrastResults.map((result, idx) => {
            const variant = badgeVariant(result);
            const fg = snapshot.resolvedMap[result.fg];
            const bg = snapshot.resolvedMap[result.bg];
            const threshold = WCAG_CONTRAST_THRESHOLDS[result.role] ?? 1;
            const contrastThreshold = CONTRAST_THRESHOLDS[result.role] ?? 15;
            return (
              <React.Fragment key={`${result.fg}-${result.bg}-${idx}`}>
                <div className="gta-contrast-swatch" style={{ backgroundColor: swatchHex(fg ?? null) }} />
                <div className="gta-contrast-swatch" style={{ backgroundColor: swatchHex(bg ?? null) }} />
                <span className="gta-contrast-token-name" title={result.fg}>{result.fg}</span>
                <span className="gta-contrast-token-name" title={result.bg}>{result.bg}</span>
                <span className="gta-contrast-ratio" title={`Threshold: ${threshold}:1`}>{result.wcagRatio.toFixed(2)}:1</span>
                <span className="gta-contrast-ratio" title={`Contrast threshold: ${contrastThreshold}`}>{result.contrast.toFixed(1)}</span>
                <span className={`gta-contrast-badge gta-contrast-badge--${variant}`}>{variant}</span>
              </React.Fragment>
            );
          })}
        </div>
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">Color Vision Deficiency Preview</TugLabel>
        <div className="gta-cvd-strip" data-testid="gta-cvd-strip">
          <div className="gta-cvd-col-headers">
            <div className="gta-cvd-type-label-cell" />
            {CVD_SEMANTIC_TOKENS.map(({ label }) => (
              <div key={label} className="gta-cvd-token-header">{label}</div>
            ))}
          </div>
          {CVD_TYPES.map((cvdType) => (
            <div key={cvdType} className="gta-cvd-row" data-cvd-type={cvdType}>
              <div className="gta-cvd-type-label-cell">
                <span className="gta-cvd-type-label">{CVD_TYPE_LABELS[cvdType]}</span>
                {cvdWarnings.some((w) => w.type === cvdType) && (
                  <span className="gta-cvd-warn-badge" title="Potential indistinguishable semantic colors">!</span>
                )}
              </div>
              {CVD_SEMANTIC_TOKENS.map(({ token, label }) => {
                const resolved = snapshot.resolvedMap[token];
                if (!resolved) {
                  return (
                    <div key={token} className="gta-cvd-swatch-pair">
                      <div className="gta-cvd-swatch gta-cvd-swatch--missing" title="N/A" />
                      <div className="gta-cvd-swatch gta-cvd-swatch--missing" title="N/A" />
                    </div>
                  );
                }
                const origHex = swatchHex(resolved);
                const simHex = linearSrgbToHex(simulateCVDFromOKLCH(resolved.L, resolved.C, resolved.h, cvdType));
                return (
                  <div key={token} className="gta-cvd-swatch-pair" title={`${label}: ${origHex} -> ${simHex}`}>
                    <div className="gta-cvd-swatch" style={{ backgroundColor: origHex }} />
                    <div className="gta-cvd-swatch" style={{ backgroundColor: simHex }} />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">Accessibility Diagnostics</TugLabel>
        <div className="gta-autofix-panel" data-testid="gta-autofix-panel">
          <div className="gta-diag-section" data-testid="gta-diag-floor-section">
            <div className="gta-diag-section-title">Failing contrast pairs ({failingPairs.length})</div>
            <ul className="gta-diag-list">
              {failingPairs.slice(0, 20).map((r, idx) => (
                <li key={`f-${idx}`} className="gta-diag-item">
                  <span className="gta-diag-token">{r.fg}</span>
                  <span className="gta-diag-detail">on {r.bg} (contrast {r.contrast.toFixed(1)})</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="gta-diag-section">
            <div className="gta-diag-section-title">Marginal pairs ({marginalPairs.length})</div>
            <ul className="gta-diag-list">
              {marginalPairs.slice(0, 20).map((r, idx) => (
                <li key={`m-${idx}`} className="gta-diag-item">
                  <span className="gta-diag-token">{r.fg}</span>
                  <span className="gta-diag-detail">on {r.bg} (contrast {r.contrast.toFixed(1)})</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="gta-diag-section">
            <div className="gta-diag-section-title">Unresolved token references ({unresolvedReferences.length})</div>
            <ul className="gta-diag-list">
              {unresolvedReferences.slice(0, 20).map((token) => (
                <li key={token} className="gta-diag-item">
                  <span className="gta-diag-token">{token}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="gta-diag-section">
            <div className="gta-diag-section-title">CVD warnings ({cvdWarnings.length})</div>
            <ul className="gta-diag-list">
              {cvdWarnings.slice(0, 20).map((warning, idx) => (
                <li key={`c-${idx}`} className="gta-diag-item">
                  <span className="gta-diag-token">{warning.type}</span>
                  <span className="gta-diag-detail">{warning.tokenPair.join(" vs ")}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
