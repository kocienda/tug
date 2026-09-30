/**
 * GalleryTranscriptEntry — visual showcase for TugTranscriptEntry.
 *
 * Mounts all three participant variants stacked with realistic mock content
 * so the design can be reviewed in isolation:
 *
 *   - user    — a "tell me a haiku" submission rendered as plain text.
 *   - code    — a haiku response as plain JSX (markdown-styled).
 *   - shell   — mock `git status` output in a `<pre>` block.
 *
 * The data is mock. Live transcript wiring (`CodeSessionStore`, streaming,
 * a per-row `TugMarkdownView` for `code` rows, atom rendering for user
 * submissions) is the consumer's concern; this card validates the visual
 * primitive in isolation. The body slot accepts any `React.ReactNode`,
 * so the eventual consumer is free to compose whatever rendering shape
 * each participant calls for.
 *
 * Laws: [L06] appearance via CSS / inline styles, [L19] gallery-card
 *       authoring (module docstring, exported component, registered).
 *
 * @module components/tugways/cards/gallery-transcript-entry
 */

import "./gallery.css";

import React from "react";
import { Copy } from "lucide-react";

import { TugTranscriptEntry } from "@/components/tugways/tug-transcript-entry";
import { TugBadge } from "@/components/tugways/tug-badge";
import { TugPushButton } from "@/components/tugways/tug-push-button";

// ---------------------------------------------------------------------------
// Mock content
// ---------------------------------------------------------------------------

const MOCK_MODEL_NAME = "claude-opus-4-7";

const MOCK_GIT_STATUS = `On branch main
Your branch is up to date with 'origin/main'.

Changes not staged for commit:
  modified:   src/components/tugways/tug-transcript-entry.tsx
  modified:   styles/themes/ironclad.css

no changes added to commit (use "git add")`;

// ---------------------------------------------------------------------------
// Mock body components
// ---------------------------------------------------------------------------

const HAIKU_BODY_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--tug-space-sm)",
};

const PARAGRAPH_STYLE: React.CSSProperties = { margin: 0 };

/**
 * Plain-JSX rendering of a markdown-shaped haiku response. Live consumers
 * (Step 11 wiring) will substitute a per-row `TugMarkdownView` here; the
 * gallery uses static JSX so the visual design is reviewable without a
 * markdown view's reserved viewport height.
 */
function CodeBody(): React.ReactElement {
  return (
    <div style={HAIKU_BODY_STYLE}>
      <p style={PARAGRAPH_STYLE}>
        Cherry blossoms fall—
        <br />
        silent in the morning frost,
        <br />
        spring's first whispered word.
      </p>
      <p style={PARAGRAPH_STYLE}>
        A <em>5-7-5 haiku</em>. The form is traditionally Japanese, with
        seventeen syllables when transliterated.
      </p>
    </div>
  );
}

const PRE_STYLE: React.CSSProperties = {
  fontFamily: "var(--tug-font-family-mono)",
  fontSize: "var(--tug-font-size-xs)",
  margin: 0,
  whiteSpace: "pre-wrap",
};

// ---------------------------------------------------------------------------
// GalleryTranscriptEntry
// ---------------------------------------------------------------------------

export function GalleryTranscriptEntry(): React.ReactElement {
  return (
    <div
      className="cg-content"
      data-testid="gallery-transcript-entry"
      style={{ gap: "var(--tugx-transcript-row-gap)" }}
    >
      <TugTranscriptEntry
        participant="user"
        identifier="You"
        timestamp="2:14 PM"
        body="tell me a haiku"
      />
      <TugTranscriptEntry
        participant="assistant"
        identifier={MOCK_MODEL_NAME}
        timestamp="2:14 PM"
        body={<CodeBody />}
        controls={
          <>
            <TugBadge size="sm" emphasis="tinted" role="agent">
              {MOCK_MODEL_NAME}
            </TugBadge>
            <TugPushButton
              subtype="icon"
              emphasis="ghost"
              role="action"
              size="sm"
              icon={<Copy size={12} />}
              aria-label="Copy"
            />
          </>
        }
      />
      <TugTranscriptEntry
        participant="shell"
        identifier="$ git"
        timestamp="2:13 PM"
        body={<pre style={PRE_STYLE}>{MOCK_GIT_STATUS}</pre>}
        controls={
          <TugBadge size="sm" emphasis="tinted" role="success">
            exit 0
          </TugBadge>
        }
      />
    </div>
  );
}
