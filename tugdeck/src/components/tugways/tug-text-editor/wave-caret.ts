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

import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
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
 * The end moves for more reasons than a delta. CodeMirror estimates the height
 * of a line it has not laid out and corrects the estimate a pass later; the
 * field itself is still auto-growing toward its cap, which changes how much of
 * the document fits; a font finishes loading and every wrapped line re-wraps.
 * Each of those moves the end of the document out from under a scroll already
 * written. None of them is invisible to CodeMirror, though: each lands in its
 * own measure cycle and reaches the view as an update flagged
 * `heightChanged`, `geometryChanged` or `viewportChanged`. So the pin answers
 * the editor's own updates — a delta, the edit that lights the glyph, and
 * every measured change — and nothing else. It runs exactly while the data
 * moves and stops with it, which a per-frame pump could not: that one wrote
 * the scroller on every frame for as long as the glyph was lit, whether or not
 * anything had moved ([L13], [D7]).
 *
 * An `updateListener` and not a view plugin's `update`, which is the mistake
 * worth naming: a view plugin is updated BEFORE the view writes the DOM, so a
 * scroller read there reports the height of the document as it was, and pinning
 * to it leaves the field exactly one delta's worth of text short of the end —
 * which is where the wave was found, every time, hanging just under the bottom
 * edge. A listener runs after the write, and after the measure that flagged a
 * height or geometry change, against the document that is now on screen. A
 * covered window that is given no frames still gets every delta, because a
 * delta's update is dispatched synchronously.
 */
const waveCaretPin = EditorView.updateListener.of((update) => {
  if (update.state.field(waveCaretField).size === 0) return;
  const lit = update.startState.field(waveCaretField).size === 0;
  if (
    !lit &&
    !update.docChanged &&
    !update.heightChanged &&
    !update.geometryChanged &&
    !update.viewportChanged
  ) {
    return;
  }
  const scroller = update.view.scrollDOM;
  scroller.scrollTop = scroller.scrollHeight;
});

/** Install in the editor's host extensions; inert until `setWaveCaretActive`. */
export const waveCaretExtension: Extension = [waveCaretField, waveCaretPin];
