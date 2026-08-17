/**
 * gallery-attachment-strip.tsx — design-review gallery card for the
 * per-message thumbnail strip ([Step 6](roadmap/dev-atoms.md#step-6)).
 *
 * Fixtures: two static image atoms paired with a small in-memory
 * bytes-store carrying canned thumbnail data URLs. The body above
 * the strip mimics the transcript's `TugAtomTextBody` rendering —
 * inline chips at original positions, label `image-N` matching the
 * strip's tile captions.
 *
 * The bytes are pre-baked tiny SVG thumbnails encoded as base64
 * data URLs so the gallery doesn't need to spin the
 * `bakeThumbnail` Web Worker (which is gated to runtime DOM and
 * won't run inside a static fixture). The visual fidelity is
 * sufficient for layout / numbering review; full image-shape
 * verification happens in the live transcript.
 *
 * Laws:
 *  - [L06] appearance via CSS; the gallery doesn't introduce any
 *    new appearance state.
 *  - [L19] same authoring discipline as the primitive.
 */

import * as React from "react";

import { TugAtomTextBody } from "@/components/tugways/cards/tug-atom-text-body";
import { TugAttachmentPreview } from "@/components/tugways/cards/tug-attachment-preview";
import {
  createAtomBytesStore,
  type AtomBytesStore,
} from "@/lib/atom-bytes-store";
import {
  TUG_ATOM_CHAR,
  type AtomSegment,
} from "@/lib/tug-atom-img";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

// ---------------------------------------------------------------------------
// Fixture: two image atoms + canned thumbnails
// ---------------------------------------------------------------------------

const FIXTURE_ATOMS: ReadonlyArray<AtomSegment> = [
  { kind: "atom", type: "image", label: "image-1", value: "image-1", id: "fixture-image-A" },
  { kind: "atom", type: "image", label: "image-2", value: "image-2", id: "fixture-image-B" },
];

// Tiny inline SVG → data URL. Two distinct flat colors so the
// thumbnails read as separate tiles in the strip preview.
const SVG_A = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1f6feb"/><text x="50%" y="56%" text-anchor="middle" font-family="system-ui" font-size="10" fill="white">A</text></svg>`;
const SVG_B = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#a371f7"/><text x="50%" y="56%" text-anchor="middle" font-family="system-ui" font-size="10" fill="white">B</text></svg>`;

function svgToDataUrl(svg: string): string {
  // Pass the raw SVG through `btoa` for the base64 wrapping so the
  // browser parses it as `image/svg+xml`. The gallery is a static
  // fixture so the `btoa` boundary is fine for this small input.
  if (typeof btoa === "function") {
    return `data:image/svg+xml;base64,${btoa(svg)}`;
  }
  // Defensive fallback for non-browser test environments (where the
  // gallery component is exercised only through render-shape pins).
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function buildFixtureBytesStore(): AtomBytesStore {
  const store = createAtomBytesStore();
  const thumbA = svgToDataUrl(SVG_A);
  const thumbB = svgToDataUrl(SVG_B);
  store.put("fixture-image-A", {
    content: "PLACEHOLDER",
    mediaType: "image/svg+xml",
    thumbnailDataUrl: thumbA,
  });
  store.put("fixture-image-B", {
    content: "PLACEHOLDER",
    mediaType: "image/svg+xml",
    thumbnailDataUrl: thumbB,
  });
  return store;
}

// Substrate text with two `U+FFFC` markers at the chip positions —
// matches the post-Step-5c synthesizer output for two interleaved
// image content blocks within a body of prose.
const FIXTURE_TEXT = `describe ${TUG_ATOM_CHAR} and ${TUG_ATOM_CHAR} please`;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const descStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--tug7-element-field-text-normal-label-rest)",
  marginBottom: "4px",
};

// ---------------------------------------------------------------------------
// Gallery component
// ---------------------------------------------------------------------------

export function GalleryAttachmentStrip(): React.ReactElement {
  // The bytes-store is per-gallery-mount; built once on mount and
  // disposed implicitly when the gallery unmounts. The gallery
  // doesn't fire any thumbnail bakes — the fixtures pre-populate.
  const bytesStore = React.useMemo(() => buildFixtureBytesStore(), []);

  return (
    <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "16px" }}>
      <div>
        <TugLabel>Transcript user row — body + per-message strip</TugLabel>
        <p style={descStyle}>
          The inline chips in the body and the strip thumbnails share an
          identical <code>image-N</code> label — one attach-time-minted
          name, carried through unchanged.
        </p>
        <div style={{
          padding: "12px",
          background: "var(--tug7-element-field-fill-rest)",
          borderRadius: "6px",
        }}>
          <TugAtomTextBody text={FIXTURE_TEXT} atoms={FIXTURE_ATOMS} />
          <TugAttachmentPreview
            atoms={FIXTURE_ATOMS}
            bytesStore={bytesStore}
          />
        </div>
      </div>

      <TugSeparator />

      <div>
        <TugLabel>Compose phase — deletable tiles</TugLabel>
        <p style={descStyle}>
          In the prompt-entry Z4C zone the same strip carries a ✕ on each
          tile (and a Delete in the preview). The controls dispatch{" "}
          <code>REMOVE_ATTACHMENT</code> through the chain; with no responder
          in the gallery the dispatch no-ops, so the fixtures stay put.
        </p>
        <div style={{
          padding: "12px",
          background: "var(--tug7-element-field-fill-rest)",
          borderRadius: "6px",
        }}>
          <TugAtomTextBody text={FIXTURE_TEXT} atoms={FIXTURE_ATOMS} />
          <TugAttachmentPreview
            atoms={FIXTURE_ATOMS}
            bytesStore={bytesStore}
            deletable
          />
        </div>
      </div>

      <TugSeparator />

      <div>
        <TugLabel>Compact density — the rail's tier</TugLabel>
        <p style={descStyle}>
          One declaration, <code>density=&quot;compact&quot;</code>, for a
          surface a few hundred pixels wide (the Overview). The tiles step down
          a size and the preview sheet opens at the narrow width tier well
          short of the card&apos;s edges — everything else is identical, both
          phases included.
        </p>
        <div style={{
          padding: "12px",
          background: "var(--tug7-element-field-fill-rest)",
          borderRadius: "6px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}>
          <TugAttachmentPreview
            atoms={FIXTURE_ATOMS}
            bytesStore={bytesStore}
            density="compact"
          />
          <TugAttachmentPreview
            atoms={FIXTURE_ATOMS}
            bytesStore={bytesStore}
            deletable
            density="compact"
          />
        </div>
      </div>

      <TugSeparator />

      <div>
        <TugLabel>No image atoms — strip renders nothing</TugLabel>
        <p style={descStyle}>
          A user message with no image atoms produces no strip; the
          row collapses to body-only height (no empty container).
        </p>
        <div style={{
          padding: "12px",
          background: "var(--tug7-element-field-fill-rest)",
          borderRadius: "6px",
        }}>
          <TugAtomTextBody text="plain prose, no atoms here" atoms={[]} />
          <TugAttachmentPreview atoms={[]} bytesStore={bytesStore} />
        </div>
      </div>
    </div>
  );
}
