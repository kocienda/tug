/**
 * gallery-icon-button.tsx — TugIconButton demo tab for the Component Gallery.
 *
 * Demonstrates the four invariants the primitive carries:
 *
 *  1. Focus refusal: clicking the icon does NOT promote the chain or move
 *     browser focus off whichever editor / responder owned focus before
 *     the click. The card can mount a "focus probe" (a TugInput) that
 *     keeps showing its caret across icon clicks to make the invariant
 *     visible.
 *  2. Chain-action mode: the demo shows a row of trash icons that each
 *     dispatch a `trash-mock-row` action with a `{rowId}` payload. A
 *     tiny in-card responder logs the most recent dispatch.
 *  3. Direct-action mode: a parallel row of icons calls a local
 *     `useState` setter via `onClick` for non-chain side effects.
 *  4. Tone variants: side-by-side default and danger swatches across
 *     `sm` and `md` sizes for visual reference.
 *
 * @module components/tugways/cards/gallery-icon-button
 */

import React from "react";
import { Trash2, Edit, Info, Star, X } from "lucide-react";

import { TugIconButton } from "@/components/tugways/tug-icon-button";
import { TugInput } from "@/components/tugways/tug-input";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";
import { useResponder } from "@/components/tugways/use-responder";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import type { TugAction } from "@/components/tugways/action-vocabulary";

// Synthetic action for the chain-mode demo. Cast keeps the gallery card
// independent of the production action-vocabulary table; this name only
// exists inside this card and inside the in-card responder below.
const TRASH_MOCK_ROW = "trash-mock-row" as unknown as TugAction;

const sectionStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "12px",
};

const swatchRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "16px",
  padding: "8px 12px",
  borderRadius: "8px",
  background: "var(--tug7-surface-global-primary-normal-sunken-rest)",
};

const labelStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--tug7-element-field-text-normal-label-rest)",
};

const echoStyle: React.CSSProperties = {
  fontSize: "0.875rem",
  color: "var(--tug7-element-field-text-normal-label-rest)",
  fontFamily: "var(--tug-font-family-mono)",
  padding: "4px 0",
};

// ---------------------------------------------------------------------------
// Mock rows for the chain-action demo
// ---------------------------------------------------------------------------

interface MockRow {
  readonly id: string;
  readonly title: string;
}

const MOCK_ROWS: ReadonlyArray<MockRow> = [
  { id: "row-1", title: "Project alpha" },
  { id: "row-2", title: "Project beta" },
  { id: "row-3", title: "Project gamma" },
];

// ---------------------------------------------------------------------------
// GalleryIconButton
// ---------------------------------------------------------------------------

export function GalleryIconButton() {
  // Echoes the most recent chain dispatch so the demo shows the action
  // arrived at the responder.
  const [chainEcho, setChainEcho] = React.useState<string>("(none yet)");

  // Direct-action mode demo: per-row "starred" toggle so onClick has a
  // visible local effect.
  const [starredId, setStarredId] = React.useState<string | null>(null);

  // Register an in-card responder that handles trash-mock-row. The
  // responder's id is local to this card; nothing outside the gallery
  // routes to it.
  const responderId = React.useId();
  const { ResponderScope, responderRef } = useResponder({
    id: responderId,
    actions: {
      [TRASH_MOCK_ROW]: (event: ActionEvent) => {
        const value = event.value;
        if (
          value !== null &&
          typeof value === "object" &&
          "rowId" in value &&
          typeof (value as { rowId: unknown }).rowId === "string"
        ) {
          setChainEcho(`trash-mock-row → ${(value as { rowId: string }).rowId}`);
        }
      },
    },
  });

  return (
    <ResponderScope>
      <div
        ref={responderRef as (el: HTMLDivElement | null) => void}
        className="cg-content"
        data-testid="gallery-icon-button"
      >

        {/* ---- 1. Focus probe ---- */}
        <div className="cg-section" style={sectionStyle}>
          <TugLabel className="cg-section-title">Focus refusal</TugLabel>
          <div style={labelStyle}>
            Type into the input below, then click any icon button on this page.
            The caret stays in the input — focus does not jump to the button
            because <code>data-tug-focus="refuse"</code> is set on every
            TugIconButton.
          </div>
          <TugInput placeholder="Type something then click an icon →" />
        </div>

        <TugSeparator />

        {/* ---- 2. Chain-action mode ---- */}
        <div className="cg-section" style={sectionStyle}>
          <TugLabel className="cg-section-title">Chain-action mode</TugLabel>
          <div style={labelStyle}>
            Each trash icon dispatches <code>trash-mock-row</code> with a
            <code>{"{rowId}"}</code> payload via <code>useControlDispatch()</code>.
            The card's responder logs the most recent dispatch below.
          </div>
          <div style={sectionStyle}>
            {MOCK_ROWS.map((row) => (
              <div key={row.id} style={rowStyle}>
                <span style={{ flex: 1 }}>{row.title}</span>
                <TugIconButton size="sm"
                  icon={<Trash2 size={14} aria-hidden="true" />}
                  aria-label={`Trash ${row.title}`}
                  title={`Trash ${row.title}`}
                  role="danger"
                  action={TRASH_MOCK_ROW}
                  value={{ rowId: row.id }}
                />
              </div>
            ))}
          </div>
          <div style={echoStyle} aria-live="polite">
            Last dispatch: {chainEcho}
          </div>
        </div>

        <TugSeparator />

        {/* ---- 3. Direct-action mode ---- */}
        <div className="cg-section" style={sectionStyle}>
          <TugLabel className="cg-section-title">Direct-action mode</TugLabel>
          <div style={labelStyle}>
            For one-off side effects that don't fit the chain vocabulary, the
            <code> onClick </code> prop fires directly. Click a star to mark
            a row.
          </div>
          <div style={sectionStyle}>
            {MOCK_ROWS.map((row) => (
              <div key={row.id} style={rowStyle}>
                <span style={{ flex: 1 }}>
                  {row.title}{" "}
                  {starredId === row.id ? <em>★ starred</em> : null}
                </span>
                <TugIconButton size="sm"
                  icon={<Star size={14} aria-hidden="true" />}
                  aria-label={`Star ${row.title}`}
                  title={`Star ${row.title}`}
                  onClick={() => setStarredId(row.id)}
                />
              </div>
            ))}
          </div>
        </div>

        <TugSeparator />

        {/* ---- 4. Tone + size matrix ---- */}
        <div className="cg-section" style={sectionStyle}>
          <TugLabel className="cg-section-title">Tone × size matrix</TugLabel>
          <div style={labelStyle}>
            Visual reference. <code>role="action"</code> uses the
            ghost-action token family; <code>role="danger"</code> uses
            ghost-danger.
          </div>

          <div style={swatchRowStyle}>
            <span style={labelStyle}>sm / default</span>
            <TugIconButton size="sm" icon={<Edit size={14} />} aria-label="Edit" />
            <TugIconButton size="sm" icon={<Info size={14} />} aria-label="Info" />
            <TugIconButton size="sm" icon={<X size={14} />} aria-label="Dismiss" />
            <span style={labelStyle}>sm / danger</span>
            <TugIconButton size="sm" icon={<Trash2 size={14} />} aria-label="Trash" role="danger" />
            <TugIconButton size="sm" icon={<X size={14} />} aria-label="Remove" role="danger" />
          </div>

          <div style={swatchRowStyle}>
            <span style={labelStyle}>md / default</span>
            <TugIconButton icon={<Edit size={16} />} aria-label="Edit" size="md" />
            <TugIconButton icon={<Info size={16} />} aria-label="Info" size="md" />
            <TugIconButton icon={<X size={16} />} aria-label="Dismiss" size="md" />
            <span style={labelStyle}>md / danger</span>
            <TugIconButton icon={<Trash2 size={16} />} aria-label="Trash" role="danger" size="md" />
            <TugIconButton icon={<X size={16} />} aria-label="Remove" role="danger" size="md" />
          </div>

          <div style={swatchRowStyle}>
            <span style={labelStyle}>disabled</span>
            <TugIconButton size="sm" icon={<Edit size={14} />} aria-label="Edit" disabled />
            <TugIconButton size="sm" icon={<Trash2 size={14} />} aria-label="Trash" role="danger" disabled />
          </div>
        </div>
      </div>
    </ResponderScope>
  );
}
