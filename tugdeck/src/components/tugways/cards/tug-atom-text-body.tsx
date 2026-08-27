/**
 * tug-atom-text-body.tsx — pure React walker that renders the
 * `(text, atoms)` substrate into interleaved text + atom-chip `<img>`
 * elements at each `U+FFFC` position.
 *
 * Consumed by the transcript user-message row (`UserMessageCell` in
 * `session-card-transcript.tsx`). Each atom chip is built via the shared
 * `bakeAtomChipDataUri` helper, so the transcript's chips and the
 * editor's atom widgets are pixel-identical: same bake, same theme
 * tokens, same baseline offset.
 *
 * **Replaced-element behaviour rides on `<img>`.** The transcript
 * chips aren't editable, but the editor's atoms also render via
 * `<img>` (`createAtomImgElement` → `bakeAtomChipDataUri` internally),
 * which is what keeps the editor's caret / selection / clipboard
 * semantics free per HTML spec. The shared helper is the consistency
 * boundary; React vs. imperative DOM is a per-surface choice.
 *
 * The walking substrate ({@link walkAtomText}) lives in `lib/atom-text`
 * beside the two other readings of the same pair — the copy text and the
 * clipboard sidecar — so a row, its copy, and a paste of that copy can
 * never disagree about what the substrate holds.
 *
 * Laws:
 *  - [L06] all chip appearance flows from the baked data URI + per-image
 *    inline style (verticalAlign / margin). No React state for
 *    appearance, no className-conditional logic.
 *  - [L19] file pair, module docstring, exported props interface,
 *    `data-slot="tug-atom-text-body"` on the root span; forwardRef so
 *    consumers can attach a ref (the transcript cell uses it as a
 *    menu-anchor target).
 *
 * @module components/tugways/cards/tug-atom-text-body
 */

import "./tug-atom-text-body.css";

import * as React from "react";

import {
  TUG_ATOM_CHAR,
  type AtomSegment,
} from "@/lib/tug-atom-img";
import { atomRegisterVars } from "@/lib/atom-register";
import { walkAtomText } from "@/lib/atom-text";
import { TugAtomChip } from "@/lib/tug-atom-chip";
import { TugSessionCitation } from "@/components/tugways/tug-session-identity";
import {
  isSessionAtomType,
  sessionAtomCallsign,
  sessionAtomProject,
} from "@/lib/session-atom";
import {
  annotationOpensSurface,
  dataAttributesForPayload,
  payloadForAtom,
} from "@/lib/annotator/payloads";
import { ANNOTATION_CLASS } from "@/lib/annotator/types";
import type { AtomPathRoots } from "@/lib/atom-file-path";
import type { TurnAddress } from "../tug-transcript-entry";

// ---------------------------------------------------------------------------
// Chip-label decoration — pure, exported for tests
// ---------------------------------------------------------------------------

/**
 * Compute the chip's displayed label.
 *
 * The label is the atom's stored `label` verbatim — `image-N` for image
 * atoms (minted at attach time in the editor, re-minted in document order
 * by the transcript synthesizer), a path / URL for file / doc / link
 * atoms, the command leaf for command atoms. One unified name, identical
 * across the compose editor and the transcript.
 *
 * The `address` parameter is retained for call-site compatibility but no
 * longer decorates the label: the former `#u{turn}-image-N` turn-address
 * prefix is retired in favour of a single attach-time-minted name that
 * carries through unchanged. (The turn address still renders on the user
 * row's attribution badge via {@link formatTurnAddress} — that is a
 * separate surface from the chip label.)
 *
 * Pure on inputs.
 */
export function decorateChipLabel(
  atom: AtomSegment,
  _address: TurnAddress | undefined,
): string {
  return atom.label;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface TugAtomTextBodyProps {
  /** Raw substrate text with `U+FFFC` placeholders at atom positions. */
  text: string;
  /**
   * Parallel atoms array. The Nth `U+FFFC` in `text` pairs with
   * `atoms[N]`. Defensive: extra `U+FFFC` characters past `atoms.length`
   * render as visible text (no crash).
   */
  atoms: ReadonlyArray<AtomSegment>;
  /**
   * Optional transcript entry address. Retained for call-site
   * compatibility (the user row threads its address through), but it no
   * longer affects the chip label: atoms render their stored `label`
   * verbatim — the unified attach-time-minted `image-N` name — on every
   * surface. See {@link decorateChipLabel}.
   */
  address?: TurnAddress;
  /**
   * The roots a project-relative atom value resolves against. An `@`
   * mention's value counts from the project root, so without these the
   * chip names no openable target and wears no annotation.
   */
  pathRoots?: AtomPathRoots;
  /** Forwarded to the root span. */
  className?: string;
  /** Forwarded to the root span (for test anchoring). */
  "data-testid"?: string;
}

/**
 * Render an atom-bearing substrate as a span containing interleaved
 * text and atom-chip `<img>` elements. See module docstring for the
 * shared-chip-builder rationale and the laws this component honours.
 */
export const TugAtomTextBody = React.forwardRef<
  HTMLSpanElement,
  TugAtomTextBodyProps
>(function TugAtomTextBody(
  { text, atoms, address, pathRoots, className, "data-testid": dataTestid },
  ref,
) {
  const segments = walkAtomText(text, atoms);
  // Publish the prose register — the box every atom in this body is drawn to,
  // baked or live, and the line-box floor that keeps a line the same height
  // whether or not it carries one. The Swift host's `WKWebView.pageZoom`
  // scales all of them together.
  const hostStyle = atomRegisterVars("prose") as React.CSSProperties;
  return (
    <span
      ref={ref}
      data-slot="tug-atom-text-body"
      className={className}
      data-testid={dataTestid}
      style={hostStyle}
    >
      {segments.map((seg, i) => {
        if (seg.kind === "text") {
          return <React.Fragment key={`t-${i}`}>{seg.text}</React.Fragment>;
        }
        if (seg.kind === "stray-ffc") {
          return (
            <React.Fragment key={`s-${i}`}>{TUG_ATOM_CHAR}</React.Fragment>
          );
        }
        // A session atom is not a look-alike of the identity chip — it IS one.
        // The transcript is a React surface, so the atom mounts the live
        // component rather than a bake of it: its dot reads the session's phase
        // this second and its title tracks a rename ([P14]). The chip resolves
        // through the callsign; the value's `<project>/` head rides along as
        // the recorded project, so even an unresolvable atom shows the
        // project its value named.
        if (isSessionAtomType(seg.atom.type)) {
          const callsign = sessionAtomCallsign(seg.atom.value);
          return (
            <TugSessionCitation
              key={`a-${i}`}
              citedId={callsign}
              recordedTag={callsign}
              context={{
                recordedProject: sessionAtomProject(seg.atom.value),
              }}
              atom={seg.atom}
            />
          );
        }
        const displayLabel = decorateChipLabel(seg.atom, address);
        // The shared `.tug-atom-chip { vertical-align: middle }`
        // class centres the chip in the line-box; the line-height
        // floor above guarantees the box is at least atom-tall.
        const chip = (
          <TugAtomChip
            key={`a-${i}`}
            className="tug-atom-chip"
            type={seg.atom.type}
            label={displayLabel}
            value={seg.atom.value}
          />
        );
        // A chip whose atom names something actionable — a file, a link —
        // wears the annotation, so the transcript's delegated layer gives
        // it the same gestures the markdown renderer's chips get. The
        // wrapper exists only to carry that dataset; chips with nothing to
        // act on render bare, exactly as before.
        const payload = payloadForAtom(seg.atom, pathRoots);
        if (payload === null) return chip;
        return (
          <span
            key={`a-${i}`}
            className={ANNOTATION_CLASS}
            data-tug-annotation={payload.kind}
            {...dataAttributesForPayload(payload)}
            data-tug-focus={
              annotationOpensSurface(payload.kind) ? "refuse" : undefined
            }
            data-no-activate={
              annotationOpensSurface(payload.kind) ? "" : undefined
            }
          >
            {chip}
          </span>
        );
      })}
    </span>
  );
});
