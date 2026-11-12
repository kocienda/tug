/**
 * gallery-tug-clamp.tsx -- Clamp demo tab for the Component Gallery.
 *
 * Shows the visual-clamp primitive across its states: a short block that
 * renders bare (no control), a long command that caps at the line limit
 * behind a "Show more / Show less" reveal, a tighter cap, and a long prose
 * blurb (the clamp is content-agnostic).
 *
 * @module components/tugways/cards/gallery-tug-clamp
 */

import React from "react";
import { Clamp } from "./session-changes/clamp";
import { TugLabel } from "@/components/tugways/tug-label";

const descStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--tug7-element-field-text-normal-label-rest)",
  marginBottom: "6px",
};

const codeStyle: React.CSSProperties = {
  fontFamily: "var(--tugx-block-code-font)",
  fontSize: "var(--tug-font-size-sm)",
  lineHeight: 1.45,
  color: "var(--tugx-block-text-color)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  display: "block",
};

const SHORT_COMMAND = `cd tugdeck && bun run build`;

const LONG_COMMAND = `cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck/src/components/tugways/cards && ls blocks/ && echo "---DISPATCH HEAD---" && sed -n '1,60p' cards/session-assistant-renderer-dispatch.ts 2>/dev/null || find . -name "session-assistant-renderer-dispatch.ts" && echo "---" && grep -rn "KIND_RENDERERS" . --include="*.ts" | head -40 && echo "done scanning the dispatch table for permission renderers"`;

const LONG_PROSE = `The shape is fixed upstream by Claude Code — one to four questions, two to four options per question, a hard minimum of two, not just "at most four", failing with an InputValidationError before Tug ever sees it. This is not a constraint Tug can relax by editing anything here. The Session card renders any number of options with no cap of its own; the limit lives only in Claude Code upstream. If a call somehow exceeds four, the tool block detects the validation error and mounts a salvage path so the user can still answer. Overflow is therefore graceful, but a well-formed call stays within the two-to-four band so the round-trip is never wasted.`;

// ---------------------------------------------------------------------------
// GalleryTugClamp
// ---------------------------------------------------------------------------

export function GalleryTugClamp() {
  return (
    <div className="cg-content" data-testid="gallery-tug-clamp">

      {/* ---- Fits: no control ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Short content — renders bare</TugLabel>
        <div style={{ maxWidth: "560px" }}>
          <div style={descStyle}>Under the cap, so no reveal control appears.</div>
          <Clamp lines={8}>
            <code style={codeStyle}>{SHORT_COMMAND}</code>
          </Clamp>
        </div>
      </div>

      {/* ---- Overflows: 8-line cap + reveal ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Long command — caps at 8 lines</TugLabel>
        <div style={{ maxWidth: "560px" }}>
          <div style={descStyle}>
            The permission-dialog case: a long command clamps with a soft fade
            and a "Show more" reveal.
          </div>
          <Clamp lines={8}>
            <code style={codeStyle}>{LONG_COMMAND}</code>
          </Clamp>
        </div>
      </div>

      {/* ---- Tighter cap ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Tighter cap — 3 lines</TugLabel>
        <div style={{ maxWidth: "560px" }}>
          <div style={descStyle}>The cap is a prop; the same content at lines=3.</div>
          <Clamp lines={3}>
            <code style={codeStyle}>{LONG_COMMAND}</code>
          </Clamp>
        </div>
      </div>

      {/* ---- Content-agnostic: prose ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Content-agnostic — prose at 4 lines</TugLabel>
        <div style={{ maxWidth: "560px" }}>
          <div style={descStyle}>
            Not just code — any tall, cheap-to-render content clamps the same way.
          </div>
          <Clamp lines={4}>
            <p style={{ margin: 0, fontSize: "0.875rem", lineHeight: 1.5 }}>
              {LONG_PROSE}
            </p>
          </Clamp>
        </div>
      </div>

    </div>
  );
}
