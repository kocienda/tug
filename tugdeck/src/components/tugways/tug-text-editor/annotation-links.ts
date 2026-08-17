/**
 * annotation-links — the content annotator's file references, followable
 * from inside a source buffer.
 *
 * The annotator proper is a DOM pass: it walks rendered markdown, asks a
 * resolver whether each path candidate names a real file, and marks the
 * ones that do. That reaches every surface built out of rendered ink and no
 * surface built out of an editor — so a path copied out of the transcript
 * and into a jot arrives with its text intact and its link gone, because
 * the jot is a CodeMirror document and there is no rendered `<code>` span
 * for a pass to mark.
 *
 * This extension closes that gap without rendering anything. It runs the
 * same grammar (`scanPathReferences`) over the visible lines of the buffer,
 * asks the same resolver, and builds the same payload
 * (`payloadForReference`) — so a reference is followable here if and only
 * if it would have been clickable in the transcript, and the gesture it
 * fires is the registry's own `primaryClick`, the one the transcript's
 * delegated listener fires. One grammar, one gate, one action; only the
 * carrier differs.
 *
 * **Why the accelerator.** The buffer is being edited, so a plain click has
 * to keep placing the caret. ⌘-click (Ctrl off macOS) follows, and a
 * confirmed reference underlines while the modifier is held — the text
 * card's `anchor-links` gesture exactly, because a user who learns it in
 * one editor should not have to learn it again in another.
 *
 * **Resolution is asynchronous, decoration is not.** `resolvePath` answers
 * from cache and records what it could not answer; the verdict arrives
 * later. So the plugin subscribes to verdict batches and rebuilds on each
 * one, which is the editor's version of the DOM pass's re-mark. Until an
 * answer lands the run is plain text — the annotator's rule that every
 * refusal, and every not-yet, is silent.
 *
 * Appearance-only via a CM6 mark decoration + CSS ([L06]).
 *
 * @module components/tugways/tug-text-editor/annotation-links
 */

import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";

import { scanPathReferences } from "@/lib/annotator/detect-path-reference";
import type { PathReferenceMatch } from "@/lib/annotator/detect-path-reference";
import type { PathVerdict } from "@/lib/annotator/path-resolution";
import { payloadForReference } from "@/lib/annotator/payloads";
import type {
  DirectoryPayload,
  FilePathPayload,
} from "@/lib/annotator/payloads";
import { annotationEntryFor } from "@/lib/annotator/registry";
import {
  accelHeld,
  FollowAcceleratorObserver,
} from "./follow-accelerator";

/** The mark a confirmed reference carries; CSS lights it under the modifier. */
const ANNOTATION_LINK_CLASS = "cm-annotation-link";

/** Toggled on the editor while the follow accelerator is held. */
const ANNOTATION_MOD_CLASS = "cm-annotation-mod";

/** Sent when a verdict batch lands, so the viewport re-resolves. */
const verdictArrived = StateEffect.define<null>();

/** What the host lends the extension. */
export interface AnnotationLinkOptions {
  /**
   * Does this candidate name a real file? The same synchronous, cached
   * contract the {@link AnnotationContext} carries — an answer not yet
   * known comes back `unknown` / `pending` and arrives through
   * {@link AnnotationLinkOptions.subscribe}.
   *
   * Read at call time rather than captured, because the substrate reads its
   * host extensions once at mount: a host whose project binding lands after
   * the editor opens passes a stable closure over its own live inputs.
   */
  resolvePath: (reference: PathReferenceMatch) => PathVerdict;
  /**
   * Verdict arrivals, batched. Omit and the buffer marks only what the
   * resolver already knew at mount, which is correct for a static host.
   */
  subscribe?: (listener: () => void) => () => void;
  /**
   * Bring the host's own card forward before the gesture opens another.
   * Defaults to doing nothing — the card a reference opens claims
   * activation itself, which is what the Overview's listener relies on too.
   */
  activateCard?: () => void;
}

/** The reference at `col`, or `null` when the column sits in prose. */
function referenceAt(
  lineText: string,
  col: number,
): PathReferenceMatch | null {
  for (const match of scanPathReferences(lineText)) {
    if (col >= match.start && col <= match.end) return match;
    if (match.start > col) break;
  }
  return null;
}

/** The payload a reference resolves to, or `null` when it resolves to none. */
function payloadFor(
  match: PathReferenceMatch,
  resolvePath: AnnotationLinkOptions["resolvePath"],
): FilePathPayload | DirectoryPayload | null {
  return payloadForReference(match, resolvePath(match));
}

const annotationLinkMark = Decoration.mark({ class: ANNOTATION_LINK_CLASS });

class AnnotationLinkPlugin {
  decorations: DecorationSet;
  private readonly accelerator: FollowAcceleratorObserver;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly view: EditorView,
    private readonly options: AnnotationLinkOptions,
  ) {
    this.decorations = this.buildDecorations(view);
    this.accelerator = new FollowAcceleratorObserver(
      view.dom,
      ANNOTATION_MOD_CLASS,
    );
    // A verdict lands from a network response, never from inside a CM6
    // update, so dispatching straight from the listener is safe. The
    // transaction changes nothing — it exists to give `update` a reason to
    // re-resolve the viewport, which is where the new answer is read.
    this.unsubscribe =
      options.subscribe?.(() => {
        if (!this.view.dom.isConnected) return;
        this.view.dispatch({ effects: verdictArrived.of(null) });
      }) ?? ((): void => {});
  }

  update(u: ViewUpdate): void {
    const answered = u.transactions.some((t) =>
      t.effects.some((e) => e.is(verdictArrived)),
    );
    if (u.docChanged || u.viewportChanged || answered) {
      this.decorations = this.buildDecorations(u.view);
    }
  }

  destroy(): void {
    this.unsubscribe();
    this.accelerator.destroy();
  }

  private buildDecorations(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    for (const { from, to } of view.visibleRanges) {
      let pos = from;
      while (pos <= to) {
        const line = view.state.doc.lineAt(pos);
        for (const match of scanPathReferences(line.text)) {
          if (payloadFor(match, this.options.resolvePath) === null) continue;
          builder.add(
            line.from + match.start,
            line.from + match.end,
            annotationLinkMark,
          );
        }
        if (line.to + 1 <= pos) break;
        pos = line.to + 1;
      }
    }
    return builder.finish();
  }
}

/**
 * ⌘-click (Ctrl-click off macOS) navigation for the file references the
 * content annotator confirms, in a buffer that is still being edited.
 *
 * The plugin is minted per call rather than shared at module scope, so two
 * editors bound to different projects each resolve against their own inputs.
 */
export function annotationLinkExtension(
  options: AnnotationLinkOptions,
): Extension {
  return [
    ViewPlugin.define(
      (view) => new AnnotationLinkPlugin(view, options),
      { decorations: (plugin) => plugin.decorations },
    ),
    EditorView.domEventHandlers({
      mousedown(e, view) {
        if (e.button !== 0 || !accelHeld(e)) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos === null) return false;
        const line = view.state.doc.lineAt(pos);
        const match = referenceAt(line.text, pos - line.from);
        if (match === null) return false;
        const payload = payloadFor(match, options.resolvePath);
        if (payload === null) return false;
        e.preventDefault();
        e.stopPropagation();
        annotationEntryFor(payload.kind)?.primaryClick?.(payload, {
          activateCard: options.activateCard ?? ((): void => {}),
        });
        return true;
      },
    }),
  ];
}
