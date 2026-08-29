/**
 * wave-caret — a CM6 decoration that paints the AI-thinking wave glyph as a
 * caret at the tail of the document, following streamed text ([P06]).
 *
 * The commit composer goes read-only (`editable(false)`) while the Auto-Message
 * scribe streams, so neither the native caret nor the substrate's own
 * `caret-layer` paints — this widget has the field to itself. Rather than track
 * a mapped position (a full-document `restoreState` per delta would strand it),
 * the field rebuilds a single point widget at `doc.length` on every
 * transaction while active, so the wave rides the growing draft to its end.
 *
 * The glyph mirrors {@link TugProgressWave}'s three-bar DOM + `data-state`
 * running loop (see `../internal/tug-progress-wave.css`); `eq()` is always true
 * so CM6 reuses the element across rebuilds and the pulse never restarts.
 *
 * Toggle with {@link setWaveCaretActive}; install {@link waveCaretExtension} in
 * the editor's host extensions (inert until the effect turns it on).
 *
 * @module components/tugways/tug-text-editor/wave-caret
 */

import "../internal/tug-progress-wave.css";
import "./wave-caret.css";

import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";

/** Bar geometry, matching `TugProgressWave`'s ratios at a caret-sized glyph. */
const WAVE_SIZE_PX = 15;
const BAR_WIDTH_RATIO = 0.15;
const GAP_TO_WIDTH_RATIO = 0.8;

/** Turn the wave caret on (streaming) or off (settled / cancelled). */
export const setWaveCaretActive = StateEffect.define<boolean>();

/** The wave glyph, rebuilt into the same DOM shape `TugProgressWave` renders. */
class WaveCaretWidget extends WidgetType {
  override eq(): boolean {
    // Every wave caret is identical — CM6 keeps the existing element (and its
    // running animation) across the per-delta rebuilds.
    return true;
  }

  override toDOM(): HTMLSpanElement {
    const barWidth = WAVE_SIZE_PX * BAR_WIDTH_RATIO;
    const barGap = barWidth * GAP_TO_WIDTH_RATIO;
    const root = document.createElement("span");
    root.className = "tug-progress-wave tug-commit-wave-caret";
    root.dataset.state = "running";
    root.setAttribute("aria-hidden", "true");
    root.style.setProperty("--tugx-progress-wave-size", `${WAVE_SIZE_PX}px`);
    root.style.setProperty("--tugx-progress-wave-bar-width", `${barWidth}px`);
    root.style.setProperty("--tugx-progress-wave-bar-gap", `${barGap}px`);
    for (let i = 0; i < 3; i += 1) {
      const bar = document.createElement("span");
      bar.className = "tug-progress-wave-bar";
      // Seed the rest pose (short-long-short) so the first paint matches the
      // running loop's 0% keyframe — no jump when the animation takes over.
      const rest = i === 1 ? 1 : 0.5;
      bar.style.transform = `scaleY(${rest})`;
      root.appendChild(bar);
    }
    return root;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** `side: 1` seats the wave after any content at the tail position. */
const waveCaretDecoration = Decoration.widget({
  widget: new WaveCaretWidget(),
  side: 1,
});

const waveCaretField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    // Active carries across transactions via the current decoration presence;
    // an explicit effect flips it. While active, always re-seat at the tail.
    let active = deco.size > 0;
    for (const effect of tr.effects) {
      if (effect.is(setWaveCaretActive)) active = effect.value;
    }
    if (!active) return Decoration.none;
    return Decoration.set([waveCaretDecoration.range(tr.state.doc.length)]);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * While the wave is lit, the field is held at the end of the document.
 *
 * This is the wave's own invariant rather than a caller's: the wave IS the
 * caret, and a caret is never off screen, so the state that lights the glyph is
 * the state that pins the view. Nothing outside has to remember to scroll.
 *
 * It is held on EVERY FRAME, not on every delta, because the things that break
 * it are not all deltas. CodeMirror estimates the height of a line it has not
 * laid out and corrects the estimate a pass later; the field itself is still
 * auto-growing toward its cap, which changes how much of the document fits;
 * a font finishes loading and every wrapped line re-wraps. Each of those moves
 * the end of the document out from under a scroll already written, and a pin
 * that answers only document changes sees none of them. Answering the causes
 * one at a time is how the wave ends up under the fold for a beat, which is
 * what reads as the text jumping.
 *
 * So the pin states the invariant instead of chasing its violations: on each
 * frame the wave is lit, the scroller is at its end. One property write per
 * frame, for the seconds a message takes to write, and the glyph cannot be
 * anywhere but on screen when the frame is painted.
 *
 * Not an [L05] frame-wait: nothing here is waiting for a React commit, or for
 * anything else. The invariant is stated on whatever frames the window is
 * given, and a window that is given none (a covered one suspends animation
 * entirely) still gets the pin on every delta through `update`.
 */
const waveCaretPin = ViewPlugin.fromClass(
  class {
    private frame: number | null = null;

    constructor(view: EditorView) {
      this.sync(view);
    }

    update(update: ViewUpdate): void {
      this.sync(update.view);
    }

    destroy(): void {
      this.stop();
    }

    /** Run exactly while the glyph is lit. */
    private sync(view: EditorView): void {
      const lit = view.state.field(waveCaretField).size > 0;
      if (!lit) {
        this.stop();
        return;
      }
      if (this.frame !== null) return;
      const tick = (): void => {
        pinToEnd(view);
        this.frame = requestAnimationFrame(tick);
      };
      this.frame = requestAnimationFrame(tick);
    }

    private stop(): void {
      if (this.frame === null) return;
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  },
);

/** The whole of the pin: the scroller, at its end. */
function pinToEnd(view: EditorView): void {
  view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
}

/**
 * The same pin, on the delta itself.
 *
 * An `updateListener` and not the plugin's own `update`, which is the mistake
 * worth naming: a view plugin is updated BEFORE the view writes the DOM, so a
 * scroller read there reports the height of the document as it was, and pinning
 * to it leaves the field exactly one delta's worth of text short of the end —
 * which is where the wave was found, every time, hanging just under the bottom
 * edge. An update listener runs after the write, against the document that is
 * now on screen.
 *
 * This is what carries a window that never animates; the per-frame pin above
 * carries everything that moves the end after the delta has been written.
 */
const waveCaretDeltaPin = EditorView.updateListener.of((update) => {
  if (update.state.field(waveCaretField).size === 0) return;
  pinToEnd(update.view);
});

/** Install in the editor's host extensions; inert until `setWaveCaretActive`. */
export const waveCaretExtension: Extension = [
  waveCaretField,
  waveCaretPin,
  waveCaretDeltaPin,
];
