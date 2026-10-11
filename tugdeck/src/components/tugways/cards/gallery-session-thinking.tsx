/**
 * gallery-session-thinking.tsx — visual fixture for `SessionThinkingBlock`.
 *
 * `SessionThinkingBlock` ([chrome/session-thinking-block.tsx]) has two
 * modes; this card mounts both with module-scope mock content so the
 * design surface is reviewable without a live `CodeSessionStore`:
 *
 *  1. **Streaming** — bound to a `PropertyStore` seeded with thinking
 *     text on `inflight.thinking`. Streaming mode default-expands
 *     ([D14]) so the reasoning is visible live; the store value is
 *     static here, which is exactly the steady-state streaming look.
 *  2. **Completed (long)** — `initialText` from a finished turn.
 *     Static mode default-**collapses** per [D14]; the header shows a
 *     one-line preview and the user opts in to expand by clicking.
 *  3. **Completed (short)** — a single-sentence `initialText` so the
 *     preview line and the no-truncation case are both represented.
 *
 * The static blocks mount collapsed; clicking the header expands them
 * — that toggle is the "completed-expanded" surface, reached
 * interactively rather than via a prop (static mode owns no
 * expand-state input). An empty turn (`initialText === ""`) self-hides
 * and is therefore not a visible variant.
 *
 * Laws: [L06] appearance via CSS / component DOM, [L19] gallery-card
 *       authoring (module docstring, exported component, registered).
 *
 * @module components/tugways/cards/gallery-session-thinking
 */

import "./gallery-session-thinking.css";

import React from "react";

import { SessionThinkingBlock } from "@/components/tugways/chrome/session-thinking-block";
import { PropertyStore } from "@/lib/property-store";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

// ---------------------------------------------------------------------------
// Mock content
// ---------------------------------------------------------------------------

const STREAMING_THINKING = `The user wants the gallery card to mount SessionThinkingBlock in its
streaming mode. Let me work through what that needs.

Streaming mode subscribes to a PropertyStore path — the default is
"inflight.thinking" — and renders deltas live. For a static fixture I
seed the store once; the steady-state look is identical to a stream
that has paused between deltas.

The block default-expands in streaming mode so the reasoning is
visible as it arrives. That is the [D14] default.`;

const COMPLETED_THINKING = `Now I need to decide how the completed-turn variant should read.

Static mode default-collapses: once the answer is in, the reasoning
trail is supplementary. The header carries a one-line preview built
from the first non-empty line, with interior whitespace collapsed and
a trailing ellipsis past PREVIEW_MAX_LENGTH.

I'll give the long variant several paragraphs so expanding it shows
the TugMarkdownBlock body doing real typography work, and the short
variant a single sentence so the un-truncated preview is represented
too.`;

const COMPLETED_THINKING_SHORT =
  "A short, single-line reasoning note — the preview shows it in full, no ellipsis.";

// ---------------------------------------------------------------------------
// Streaming store — module-scope so it is not recreated per render.
// ---------------------------------------------------------------------------

const STREAMING_STORE = new PropertyStore({
  schema: [
    { path: "inflight.thinking", type: "string", label: "Inflight thinking" },
  ],
  initialValues: { "inflight.thinking": STREAMING_THINKING },
});

// ---------------------------------------------------------------------------
// GallerySessionThinking
// ---------------------------------------------------------------------------

export function GallerySessionThinking(): React.ReactElement {
  return (
    <div className="cg-content" data-testid="gallery-session-thinking">
      <div className="cg-section gallery-session-thinking-section">
        <TugLabel className="cg-section-title">
          Streaming — bound to a PropertyStore, default-expanded
        </TugLabel>
        <SessionThinkingBlock
          streamingStore={STREAMING_STORE}
          streamingPath="inflight.thinking"
        />
      </div>

      <TugSeparator />

      <div className="cg-section gallery-session-thinking-section">
        <TugLabel className="cg-section-title">
          Completed (long) — static, default-collapsed; click to expand
        </TugLabel>
        <SessionThinkingBlock initialText={COMPLETED_THINKING} />
      </div>

      <TugSeparator />

      <div className="cg-section gallery-session-thinking-section">
        <TugLabel className="cg-section-title">
          Completed (short) — preview shows the full line, no truncation
        </TugLabel>
        <SessionThinkingBlock initialText={COMPLETED_THINKING_SHORT} />
      </div>
    </div>
  );
}
