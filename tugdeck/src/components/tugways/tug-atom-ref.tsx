/**
 * `TugAtomRef` — the read-only atom skin.
 *
 * An **atom** is the rendering of a value somebody *placed*: an `@`-mention,
 * a tool call's `file_path` field, an entry in a Overview post's `refs`
 * array. An atom has exactly
 * two skins and never a third. The **editable skin** is the boxed chip
 * (`TugAtomChip`), and the box means one thing: *this object can be
 * selected, deleted, or dragged where it sits*. This is the other one —
 * glyph + label, transparent, no border — for every placed value in
 * read-only ink. See `tuglaws/entity-presentation.md`.
 *
 * The counterpart is a **mention**: characters somebody *wrote* in a
 * sentence, which render as those characters plus a resting underline once a
 * resolver confirms them (`styles/tug-annotation.css`). Placed-ness is
 * structural — recorded in the data before anything renders — so which form
 * applies is never a judgment call.
 *
 * **The label is a name, not the value.** A file atom shows its basename;
 * an arc atom shows the arc's own name. An atom stands with no sentence around
 * it, so the word a sentence would have supplied belongs in the label. A
 * mention needs no such word, because its sentence already said it.
 *
 * **There is no session arm, deliberately.** One existed, labelled
 * `session:<8 hex>`, for a single call site — the arc receipt's stage row —
 * and it was a duplicate identity rendering of a record the app already draws
 * as a pill everywhere a session is named. What survives here are `file` and
 * `arc`: read-only refs with no identity record behind them, which is what
 * this skin is for.
 *
 * **Two stamping modes, because two hosts already own the contract.** In
 * `annotate` mode (the default for a file) the skin stamps the annotator's
 * file-path annotation on itself and the transcript's delegated layer
 * supplies the gesture — the same click and the same context menu a path
 * written in prose gets, so there is one interaction path for every file
 * reference rather than a parallel implementation. In presentational mode
 * it stamps nothing, for hosts that already carry the full contract: the
 * Overview's `annotationProps` wrapper span, which also owns the pending and
 * unresolvable tooltip states. An arc skin never stamps its own —
 * where that click goes is the host's business rather than the skin's, so
 * `annotate` is offered on the file arm alone rather than as a prop that
 * would be silently ignored.
 *
 * **The hover follows the stamping.** A self-stamping file skin owns its
 * hover too, and it is the house {@link fileTip} in a {@link TugTooltip} —
 * not the `title` attribute this used to hand the OS. A path is an entity,
 * and an entity gets one answer wherever it is pointed at
 * (`entity-tips.tsx`); an OS-drawn box in the system font is not that
 * answer, and it cannot be themed, delayed, or dismissed with the chain.
 * In presentational mode the skin mounts nothing, because the host that
 * owns the contract owns the hover with it — the Overview has a pending and
 * an unresolvable state to say, and a tip here would shadow them.
 *
 * Born confirmed. A placed value arrived in a field: the tool this header
 * describes just read or wrote this file, which is stronger evidence than
 * any probe. The skin carries no existence check and never waits on one.
 *
 * The link affordance rides the annotation contract rather than a modifier
 * class — an annotated skin, or a skin inside an annotated wrapper, is
 * clickable, and an unresolvable ref carries no annotation and invites
 * nothing. That is what keeps a dead Overview ref honest with no prop
 * threading (see `tug-atom-ref.css`).
 *
 * Focus discipline (`data-tug-focus="refuse"`, `data-no-activate`) rides the
 * annotation, so clicking a ref never steals first-responder status from
 * wherever the user is typing.
 *
 * Laws:
 *  - [L06] appearance is pure CSS + inherited tokens; no React state.
 *  - [L11] the ref is a control — it declares itself a reference; the deck
 *    level owns the state acting on it mutates.
 *  - [L19] file pair (`.tsx` + `.css`), exported props, `data-slot`.
 *
 * @module components/tugways/tug-atom-ref
 */

import "./tug-atom-ref.css";

import React from "react";
import { FileText, GitBranch } from "lucide-react";

import { cn } from "@/lib/utils";
import { fileTip } from "@/components/tugways/entity-tips";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { ANNOTATION_CLASS } from "@/lib/annotator/types";
import { datasetForPayload } from "@/lib/annotator/payloads";
import { basename } from "@/lib/display-path";

/** What was placed. The kind decides the glyph and the default label. */
export type TugAtomRefEntity =
  | {
      kind: "file";
      /**
       * Full file path. The basename is shown; the full path surfaces on
       * the hover, as the house file tip.
       */
      path: string;
      /**
       * 1-based line the reference points at (e.g. a Read's `offset`).
       * Carried on the annotation so the editor lands on the relevant line,
       * not just the file. Ignored when {@link range} is set.
       */
      line?: number;
      /**
       * 1-based inclusive range of the changed line(s) the reference
       * touched (e.g. an Edit's first changed lines — not the surrounding
       * context). When set, a click jumps to and momentarily flashes
       * exactly these lines; takes precedence over `line`.
       */
      range?: { startLine: number; endLine: number };
      /**
       * Stamp the annotation dataset and focus-refuse marks on the skin
       * itself. Defaults to `true`, which is the tool-header and pulse
       * case. Pass `false` when a host wrapper already carries the contract
       * (the Overview's `annotationProps` span) — stamping inside it would
       * duplicate the contract and nest a mark in a mark.
       */
      annotate?: boolean;
    }
  /**
   * An arc, by the name that is its address everywhere else in the app.
   * Presentational: the host owns the gesture, because where an arc click
   * goes is the host's business rather than the skin's.
   */
  | { kind: "arc"; name: string };

export interface TugAtomRefProps {
  entity: TugAtomRefEntity;
  /**
   * Override the default label (the basename, or the arc's name). What is
   * rendered MUST read as the same characters — this is for decorating
   * them, as a filter match decorates a sha with `<mark>`s, never for
   * substituting different ones.
   */
  label?: React.ReactNode;
  /**
   * Leading glyph. Defaults to `FileText` / `GitBranch` by kind.
   */
  icon?: React.ReactNode;
  "data-slot"?: string;
  className?: string;
}

/**
 * The annotation attributes a self-stamping file skin carries — the full
 * contract, so the delegated layer services it exactly as it services a
 * path the annotator split out of prose.
 */
function fileAnnotationAttributes(
  entity: Extract<TugAtomRefEntity, { kind: "file" }>,
): Record<string, string | undefined> {
  // A cited range wins over a bare line, so a click flashes exactly the
  // lines the tool changed.
  const dataset = datasetForPayload(
    entity.range !== undefined
      ? {
          kind: "file-path",
          path: entity.path,
          line: entity.range.startLine,
          endLine: entity.range.endLine,
        }
      : entity.line !== undefined
        ? { kind: "file-path", path: entity.path, line: entity.line }
        : { kind: "file-path", path: entity.path },
  );
  return {
    // Opts the label into transcript Find — header text, searchable in both
    // collapse states. The icon span holds an SVG with no text nodes, so the
    // unit's text is exactly the label, which is what
    // `tool-header-projection` projects. The full path is the tooltip only,
    // and Find matches what is displayed.
    "data-tugx-findable": "",
    "data-tug-annotation": "file-path",
    "data-path": dataset.path,
    "data-line": dataset.line,
    "data-end-line": dataset.endLine,
    "data-tug-focus": "refuse",
    // Opening a file activates the TARGET card's pane; this ref must not
    // also activate its OWN host pane. `pane-focus-controller`'s
    // capture-phase pointerdown listener walks up for `data-no-activate`
    // and short-circuits — without it the host pane activates on
    // pointerdown and the target pane, activated by the click, flashes
    // active then loses it back to the host.
    "data-no-activate": "",
  };
}

export function TugAtomRef({
  entity,
  label,
  icon,
  "data-slot": dataSlot = "tug-atom-ref",
  className,
}: TugAtomRefProps): React.ReactElement {
  const stamps = entity.kind === "file" && entity.annotate !== false;
  const marks = stamps
    ? fileAnnotationAttributes(entity as Extract<TugAtomRefEntity, { kind: "file" }>)
    : {};
  const defaultLabel =
    entity.kind === "file" ? basename(entity.path) : entity.name;

  const skin = (
    <span
      className={cn("tug-atom-ref", stamps && ANNOTATION_CLASS, className)}
      data-slot={dataSlot}
      {...marks}
    >
      <span className="tug-atom-ref-icon" aria-hidden="true">
        {icon ??
          (entity.kind === "file" ? <FileText /> : <GitBranch />)}
      </span>
      {/* The name, in an element of its own so the annotation rule can land
          on it. A decoration set on the skin would paint across every inline
          box inside it, glyph included; an atom's mark is its name. */}
      <span className="tug-atom-ref-label">{label ?? defaultLabel}</span>
    </span>
  );

  // Only the self-stamping arm speaks: a presentational skin's host owns the
  // hover along with the rest of the contract.
  if (!stamps) return skin;
  return (
    <TugTooltip
      variant="entity"
      align="start"
      content={fileTip({ path: (entity as { path: string }).path })}
    >
      {skin}
    </TugTooltip>
  );
}
