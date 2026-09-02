/**
 * block-reorder.ts — `useBlockReorder`, the FLIP drag lifecycle for reordering
 * a list of blocks ([P08], Spec S01).
 *
 * The whole row is the handle. There is no grip: a pointerdown anywhere on a
 * row that is not a control ARMS a drag, and travel past
 * {@link DRAG_THRESHOLD_PX} ENGAGES it. Below the threshold the gesture is
 * still a click, so a row keeps its click and its double-click; past it the
 * row is being carried. Distance is what tells the two apart, rather than
 * which pixels were pressed — which is what lets one surface answer to both.
 *
 * What carries is a **block**: every element matching {@link
 * UseBlockReorderOptions.selector} whose {@link UseBlockReorderOptions.kindAttr}
 * holds the same key. Usually that is one element — a row. Where a
 * key names a contiguous RUN (the Cards card's group header plus every row
 * filed under it) the whole run lifts, shifts, and settles as one thing, which
 * is what makes a group draggable without the list needing a wrapper element to
 * hang the group off.
 *
 * Where a row's surface is ALSO a native drag source (a jot's incipit,
 * dragged into a session prompt) the axis arbitrates as well: the list is a
 * column, so a vertical act is the carry and a horizontal one is the drag-out
 * (see `nativeDragSource`).
 *
 * The lifecycle, all DOM/CSS with a single store write on drop:
 *
 *  - **engage** ghosts the dragged block
 *    (`data-dragging` → opacity/scale/raised-z/`pointer-events:none`, the CSS
 *    lives with the host card) and snapshots the visible order + each
 *    block's rect.
 *  - **pointermove** translates the dragged band to follow the pointer
 *    (inline `transform`, no transition — instant), computes the target index
 *    from the snapshotted midpoints, shifts the non-dragged siblings by the
 *    dragged's slot to close the vacated gap / open the target slot
 *    (`transition: transform ease`), and positions the `BlockDropCaret` in
 *    the opened gap.
 *  - **pointerup** commits `setSectionOrder` only if the index changed, then
 *    FLIPs every section from its pre-commit visual into its committed slot
 *    (measure → `flushSync(commit)` → measure → play from the old offset), so
 *    the band settles into place with no jump even though sections have
 *    unequal heights. An unchanged index (or Escape) eases back and commits
 *    nothing.
 *  - **Escape** aborts locally: the handler's own capture-phase keydown
 *    listener swallows the key (so the rail `CANCEL_DIALOG` responder never
 *    sees it) and eases the drag back without committing.
 *
 * **The gesture ends before the settle plays.** Releasing the drag latch and
 * handing the keyboard back to what was set down (`landKeyboard` — a release
 * always, an Escape never) happen the moment the commit lands, and the settle
 * animates on top of an already-final state. The inverse — outcome waiting on
 * motion — is what let a drop in a window that was not in front leave the
 * surface latched forever: no frames, so no play, so no end of gesture.
 *
 * Motion is `TugAnimator`, not a frame loop and not a timer ([L13]): the
 * settle is multi-element coordination with a completion, which is exactly
 * what `group()` is for. `requestAnimationFrame` appears nowhere here —
 * the live drag writes its transform straight from the pointer event, which
 * IS the gesture-driven loop the law allows.
 *
 * No React state changes mid-drag — appearance is inline `transform` +
 * `data-*` + CSS transitions ([L06]/[L08]); the store commit and the
 * FocusManager group-order re-sync remain drop-time only ([L22], driven off
 * the store by the caller's order effect, which `flushSync` runs at drop).
 *
 * @module components/tugways/block-reorder
 */

import React from "react";
import { flushSync } from "react-dom";

import { group } from "@/components/tugways/tug-animator";

/**
 * Move the item at `from` to index `to` in a copy of `arr` (pure). It is the
 * arithmetic every drag-reorder does once the drop index is known, and it
 * lives here because this hook is the only thing that ever needed it — it sat
 * in the rail's section registry for as long as reordering the rail's bands
 * was the reorder the deck had. Out-of-range indices are clamped; the input is
 * never mutated.
 */
export function moveInArray<T>(arr: readonly T[], from: number, to: number): T[] {
  const out = [...arr];
  if (from < 0 || from >= out.length) return out;
  const clampedTo = Math.max(0, Math.min(to, out.length - 1));
  const [item] = out.splice(from, 1);
  out.splice(clampedTo, 0, item);
  return out;
}

/** Close-up / settle duration (Spec S01: 120–160ms ease). */
const SETTLE_MS = 140;

/**
 * Stamped on the container while a carry is in flight — the declared state a
 * surface inside it keys its own carry behavior off. It is deliberately
 * generic (`data-tug-*`, like `data-tug-placement`) rather than rail-private:
 * `TugListView` reads it to stand its focus ring down, and a shared primitive
 * must not have to know which host is dragging it.
 */
const CARRYING_ATTR = "data-tug-carrying";

/**
 * How far the pointer travels before a press on a row becomes a carry. Under
 * it the gesture is still a click — which is the whole reason the row can be
 * both the thing you pick and the thing you drag.
 */
const DRAG_THRESHOLD_PX = 4;

/**
 * Parts of a row that own the pointer themselves: the slot picker, a close
 * box, a copy button, the band's fold chevron and filter field. A press on one
 * of these is that control's gesture and never arms a reorder — which is what
 * "the whole row except its controls" means, stated once.
 */
const CONTROL_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  '[role="button"]',
  '[contenteditable="true"]',
  '[data-slot="tug-filter-field"]',
].join(", ");

export interface UseBlockReorderOptions {
  /** The list container (the blocks' offset parent, and the caret's). */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** The persistently-mounted `BlockDropCaret` element to drive imperatively. */
  caretRef: React.RefObject<HTMLDivElement | null>;
  /** The current visible block order (keys), read fresh at drag start. */
  getVisibleOrder: () => string[];
  /** Commit the new visible order — the ONLY store write, on drop ([L08]). */
  commit: (newVisibleOrder: readonly string[]) => void;
  /**
   * CSS selector matching each reorderable child within the container.
   * Each client (the Cards card's group runs, the Jots card's rows) names its
   * own, so the same FLIP reorder drives any list.
   */
  selector: string;
  /** Attribute on each child holding its stable key. */
  kindAttr: string;
  /**
   * The row's content is ALSO a native HTML5 drag source (a jot's incipit,
   * dragged into a session prompt). Canceling a pointerdown suppresses the
   * mousedown the browser starts that drag from, so an arm on such a row must
   * leave the browser's defaults alone and arbitrate at `dragstart` instead.
   *
   * The cost of not claiming the press is that the enclosing list commits its
   * selection immediately rather than on the click — which is what a jot
   * row wants anyway, since selecting one costs nothing. A row whose selection
   * is expensive (a Sessions row fronts its card) leaves this off, and its
   * selection waits to find out whether the press was a click.
   */
  nativeDragSource?: boolean;
  /**
   * Put the keyboard on the block that was just set down.
   *
   * A press on one of these surfaces normally lands the keyboard on it — a
   * band click focuses its section's list, a row click moves the list's key
   * view. A carry suppresses both halves of that: the arm cancels the
   * pointerdown, and the drop swallows the trailing click so a drop never
   * reads as an activation. So the keyboard, which was going somewhere, ends
   * up nowhere. This hands it back — the same destination the click would
   * have reached, for the block the user actually moved.
   *
   * Called on any completed release, whether or not the order changed, and
   * NEVER on an Escape abort: an abort says "never mind", and a gesture the
   * user took back must not leave the keyboard somewhere new. It runs as soon
   * as the commit lands — after the settle's keyframes are measured, so a
   * placement free to scroll cannot move the ground they were computed from,
   * but before the settle plays, because where the keyboard is must never
   * wait on an animation.
   *
   * It is the caller's to define, because only the caller knows what focusing
   * a block means for its surface: a rail section places on the section's own
   * focus key, a list row moves the list's movement cursor. Placement is
   * `place()`'s, never a raw focus write ([L22]).
   */
  landKeyboard?: (kind: string) => void;
}

export interface UseBlockReorder {
  /**
   * Arm a reorder from `kind`'s own row surface. Wire it to the row's
   * `onPointerDown`: presses on the row's controls are ignored, and the drag
   * engages only once the pointer has travelled vertically past the threshold,
   * so the row's click / double-click / native drag-out are all untouched.
   */
  onRowPointerDown: (kind: string, event: React.PointerEvent) => void;
}

export function useBlockReorder({
  containerRef,
  caretRef,
  getVisibleOrder,
  commit,
  selector,
  kindAttr,
  nativeDragSource = false,
  landKeyboard,
}: UseBlockReorderOptions): UseBlockReorder {
  // Latest-ref mirrors so the stable callback reads current inputs ([L07]).
  const getVisibleOrderRef = React.useRef(getVisibleOrder);
  const commitRef = React.useRef(commit);
  const landKeyboardRef = React.useRef(landKeyboard);
  React.useLayoutEffect(() => {
    getVisibleOrderRef.current = getVisibleOrder;
    commitRef.current = commit;
    landKeyboardRef.current = landKeyboard;
  });

  const draggingRef = React.useRef(false);

  // Engage: the pointer has committed to a carry. Everything below runs from
  // the ORIGINAL pointerdown position, so the row picks up where it was
  // pressed rather than jumping to where the threshold was crossed.
  const beginDrag = React.useCallback(
    (kind: string, startY: number, currentY: number) => {
      if (draggingRef.current) return;
      const container = containerRef.current;
      if (container === null) return;

      const visible = getVisibleOrderRef.current();
      const dragIndex = visible.indexOf(kind);
      if (dragIndex < 0) return;

      // kind → the RUN of elements carrying it, in DOM order. Usually one
      // element per kind — a section, a row. A kind may equally name a
      // contiguous run (the Cards section's group header plus every row filed
      // under it), and then the whole run is what carries: one block, moving
      // and settling as a unit. Everything below works on blocks, so the
      // one-element case is just the degenerate one.
      const elsByKind = new Map<string, HTMLElement[]>();
      for (const el of Array.from(
        container.querySelectorAll<HTMLElement>(selector),
      )) {
        const k = el.getAttribute(kindAttr);
        if (k === null) continue;
        const run = elsByKind.get(k);
        if (run === undefined) elsByKind.set(k, [el]);
        else run.push(el);
      }
      const runs = visible.map((k) => elsByKind.get(k));
      if (runs.some((e) => e === undefined)) return;
      const blocks = runs as HTMLElement[][];
      const allEls = Array.from(elsByKind.values()).flat();

      const n = visible.length;
      const containerRect = container.getBoundingClientRect();
      const containerTop = containerRect.top;
      // A block's box is the union of its elements' — its first element's top
      // to its last one's bottom.
      const rects = blocks.map((block) => {
        const first = block[0].getBoundingClientRect();
        const last = block[block.length - 1].getBoundingClientRect();
        return { top: first.top, bottom: last.bottom, height: last.bottom - first.top };
      });
      const tops = rects.map((r) => r.top);
      const bottoms = rects.map((r) => r.bottom);
      const midpoints = rects.map((r) => r.top + r.height / 2);
      // The dragged's occupied vertical advance (height + any inter-block gap).
      const slot =
        dragIndex + 1 < n
          ? tops[dragIndex + 1] - tops[dragIndex]
          : dragIndex > 0
            ? tops[dragIndex] - tops[dragIndex - 1]
            : rects[dragIndex].height;

      const dragged = blocks[dragIndex];
      const caret = caretRef.current;
      let targetIndex = dragIndex;

      draggingRef.current = true;
      for (const el of dragged) {
        el.setAttribute("data-dragging", "true");
        el.style.transition = "none";
      }
      // Declare the carry on the container: `data-tug-carrying` is what the
      // surfaces inside it read to stand their own marks down for the length
      // of the gesture ([L06] — an attribute plus CSS rules, no React state).
      // Two of them so far — selection is suppressed, because the press that
      // started this was a plain press on text and the browser would keep
      // extending the selection it took for the whole carry; and the focus
      // ring stands down, so the drop caret is the only edge-drawn mark in the
      // box (tuglaws/focus-language.md, "A carry suppresses the ring").
      container.setAttribute(CARRYING_ATTR, "true");
      window.getSelection()?.removeAllRanges();

      const shiftFor = (i: number, target: number): number => {
        if (i === dragIndex) return 0;
        if (target > dragIndex && i > dragIndex && i <= target) return -slot;
        if (target < dragIndex && i >= target && i < dragIndex) return slot;
        return 0;
      };

      const applyShift = (target: number): void => {
        for (let i = 0; i < n; i++) {
          if (i === dragIndex) continue;
          const ty = shiftFor(i, target);
          for (const el of blocks[i]) {
            el.style.transition = `transform ${SETTLE_MS}ms ease`;
            el.style.transform = ty === 0 ? "" : `translateY(${ty}px)`;
          }
        }
        if (caret !== null) {
          if (target === dragIndex) {
            caret.removeAttribute("data-visible");
          } else {
            // The opened gap sits at the target section's near edge: its top
            // when inserting above it (drag up), its bottom when below (drag
            // down). Both land inside the slot the siblings just opened.
            const edge = target <= dragIndex ? tops[target] : bottoms[target];
            caret.style.top = `${edge - containerTop - 1}px`;
            caret.setAttribute("data-visible", "true");
          }
        }
      };

      const computeTarget = (clientY: number): number => {
        for (let i = 0; i < n; i++) {
          if (clientY < midpoints[i]) return i;
        }
        return n - 1;
      };

      // Keep the dragged element within the container's bounds — its top may
      // not rise above the container top, nor its bottom fall below the
      // container bottom. Without this the row/section follows the pointer out
      // of the list entirely. The target index still comes from the raw
      // pointer (bounded to `[0, n-1]` by `computeTarget`), so a drag past the
      // edge still drops at the nearest end.
      const draggedRect = rects[dragIndex];
      const minDy = containerRect.top - draggedRect.top;
      const maxDy = containerRect.bottom - draggedRect.bottom;
      const clampDy = (dy: number): number =>
        Math.max(minDy, Math.min(maxDy, dy));

      const moveTo = (clientY: number): void => {
        const dy = clampDy(clientY - startY);
        for (const el of dragged) {
          el.style.transform = `translateY(${dy}px) scale(0.99)`;
        }
        const t = computeTarget(clientY);
        if (t !== targetIndex) {
          targetIndex = t;
          applyShift(t);
        }
      };
      const onMove = (ev: PointerEvent): void => moveTo(ev.clientY);

      const carried = blocks.flat();

      const clearInline = (): void => {
        for (const el of carried) {
          el.style.transition = "";
          el.style.transform = "";
        }
      };

      // The end of every carry, and it does NOT wait for the settle to play.
      // Releasing the latch and handing back the keyboard are the gesture's
      // OUTCOME; the settle is how it looks arriving. Hanging the outcome off
      // the animation is what let a drop in a background window leave the
      // surface permanently latched — the window ran no frames, so the play
      // never started, so the gesture never ended. State first, motion after.
      const finish = (landed: boolean): void => {
        for (const el of dragged) el.removeAttribute("data-dragging");
        container.removeAttribute(CARRYING_ATTR);
        caret?.removeAttribute("data-visible");
        draggingRef.current = false;
        if (landed) landKeyboardRef.current?.(kind);
      };

      // Play a settle over `moves` and drop the animations when it is done.
      // `fill: "none"` because every one of these ends at the element's own
      // resting transform — there is nothing to hold, and a filled animation
      // left behind would quietly override the next inline write ([L23]).
      const playSettle = (
        moves: ReadonlyArray<{ el: HTMLElement; from: string }>,
      ): void => {
        if (moves.length === 0) return;
        const settle = group({ duration: SETTLE_MS, easing: "ease" });
        const anims = moves.map(({ el, from }) =>
          settle.animate(el, { transform: [from, "none"] }, { fill: "none" }),
        );
        void settle.finished
          .then(() => {
            for (const anim of anims) anim.raw.cancel();
          })
          .catch(() => {
            /* superseded or cancelled — nothing left to release */
          });
      };

      // Ease every carried block from where it is back to none — an abort, or
      // a drop whose index never changed (no commit either way).
      const settleBack = (landed: boolean): void => {
        const moves = carried
          .map((el) => ({ el, from: el.style.transform }))
          .filter((m) => m.from !== "");
        clearInline();
        finish(landed);
        playSettle(moves);
      };

      // FLIP the commit: snapshot the pre-commit visual, reorder synchronously,
      // then play each element from where it LOOKED into its committed slot, so
      // the settle is jump-free across unequal heights. Per ELEMENT rather than
      // per block: a block's members can be re-parented into different slots by
      // the commit, and each one still has to land without a jump.
      //
      // The invert is the animation's first keyframe rather than an inline
      // style, which is what removes the old forced reflow and the frame hop
      // that used to follow it: WAAPI is told where the element came from, so
      // nothing has to be written and then read back.
      const settleCommit = (): void => {
        const newVisible = moveInArray(visible, dragIndex, targetIndex);
        const first = new Map<HTMLElement, number>();
        for (const el of allEls) first.set(el, el.getBoundingClientRect().top);

        clearInline();
        flushSync(() => commitRef.current(newVisible));

        const moves: { el: HTMLElement; from: string }[] = [];
        for (const el of allEls) {
          const last = el.getBoundingClientRect().top;
          const dy = (first.get(el) ?? last) - last;
          if (dy !== 0) moves.push({ el, from: `translateY(${dy}px)` });
        }
        // Measured against the committed layout, so the gesture can end — and
        // its keyboard landing can scroll, if it needs to — without moving the
        // ground the settle was computed from.
        finish(true);
        playSettle(moves);
      };

      // An engaged carry is a DRAG, never a row activation — but the pointerup
      // still spawns a trailing `click` on the cell under the pointer, which the
      // list would read as a select/activate (e.g. front the session card, or
      // focus a band's list). Swallow that one click at capture phase so a drop
      // never activates a row.
      //
      // What it is aimed at is the click the BROWSER makes out of this
      // gesture's own pointerup, so it only ever swallows a trusted one. A
      // synthetic `.click()` is some other code deciding to activate a row and
      // has nothing to do with the drag that just ended — swallowing that
      // would make a drag quietly disable a row for whatever came next.
      //
      // It is released two ways, and neither is a clock. The click itself
      // releases it; and if no click follows (a drop over a gap), the next
      // POINTERDOWN does — a later gesture cannot begin before this one's
      // click would have arrived, so a press is proof none is coming. The
      // duration a timer would have to guess is unknowable, and a window that
      // is not in front stretches every timer to about a second, which is long
      // enough to swallow a real click the user meant.
      const releaseSwallow = (): void => {
        window.removeEventListener("click", swallowNextClick, true);
        window.removeEventListener("pointerdown", releaseSwallow, true);
      };
      function swallowNextClick(ev: MouseEvent): void {
        if (!ev.isTrusted) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        releaseSwallow();
      }
      const armSwallowRelease = (): void => {
        window.addEventListener("pointerdown", releaseSwallow, true);
      };

      const detach = (): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("keydown", onKey, true);
      };

      const onUp = (): void => {
        detach();
        armSwallowRelease();
        if (targetIndex !== dragIndex) settleCommit();
        // A release that changed nothing is still a release: the block was
        // carried and set down, so the keyboard lands on it either way.
        else settleBack(true);
      };

      const onKey = (ev: KeyboardEvent): void => {
        if (ev.key !== "Escape") return;
        // Keep the abort local: swallow Escape so the rail `CANCEL_DIALOG`
        // responder does not also fire (which would focus the rail out).
        //
        // Substrate-local rather than a scoped binding, for the same reason
        // the card drag's Escape is: the claim lasts exactly as long as the
        // pointer is down, and a keymap that reported ⎋ as taken would be
        // describing a state the user is almost never in.
        ev.preventDefault();
        ev.stopImmediatePropagation();
        detach();
        armSwallowRelease();
        // Aborted, so the keyboard stays where it was. Escape means the
        // gesture never happened, and a taken-back drag must not leave the
        // keyboard somewhere the user did not put it.
        settleBack(false);
      };

      window.addEventListener("click", swallowNextClick, true);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("keydown", onKey, true);

      // The move that engaged the drag is spent — it was consumed deciding
      // this IS a drag — so replay it here. Without it a gesture whose whole
      // travel arrives in one move (a synthesized drag, a fast flick) would
      // engage and then never be told where the pointer went.
      moveTo(currentY);
    },
    [containerRef, caretRef, selector, kindAttr],
  );

  // Arm: a press on the row's own surface. Nothing has been decided yet — the
  // gesture is still a click until the pointer says otherwise.
  const onRowPointerDown = React.useCallback(
    (kind: string, event: React.PointerEvent) => {
      if (draggingRef.current) return;
      if (event.button !== 0) return;
      const target = event.target;
      if (target instanceof Element && target.closest(CONTROL_SELECTOR) !== null) {
        return;
      }
      // Claim the press. The enclosing list reads `defaultPrevented` as "this
      // gesture has not decided what it is yet" and holds its selection until
      // the click, so a carry never selects the row it is carrying. Skipped on
      // a row that is also a native drag source — see `nativeDragSource`.
      if (!nativeDragSource) event.preventDefault();

      const startX = event.clientX;
      const startY = event.clientY;
      let dx = 0;
      let dy = 0;
      let armed = true;

      const disarm = (): void => {
        armed = false;
        window.removeEventListener("pointermove", onArmMove);
        window.removeEventListener("pointerup", disarm);
        window.removeEventListener("dragstart", onDragStart, true);
      };
      const engage = (currentY: number): void => {
        disarm();
        beginDrag(kind, startY, currentY);
      };

      // Travel decides. On an ordinary row there is nothing else the press
      // could become, so any travel past the threshold is the carry — a
      // diagonal drag from a row's left edge toward the middle of the list is
      // a carry like any other. Only where a SECOND drag shares the surface
      // does the axis have a job: there, a vertical act is the carry (the list
      // is a column) and a horizontal one is handed back to the drag-out.
      function onArmMove(ev: PointerEvent): void {
        dx = ev.clientX - startX;
        dy = ev.clientY - startY;
        if (!nativeDragSource) {
          if (Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) engage(ev.clientY);
          return;
        }
        if (Math.abs(dy) >= DRAG_THRESHOLD_PX && Math.abs(dy) > Math.abs(dx)) {
          engage(ev.clientY);
        } else if (Math.abs(dx) >= DRAG_THRESHOLD_PX) {
          disarm();
        }
      }

      // A Jots row's incipit is ALSO a native drag source (drop the text
      // into a session prompt), and the browser decides to start that drag on
      // its own few pixels of movement — which can land before this arm has
      // seen enough to engage. So the two gestures are arbitrated here, on the
      // same axis rule: a vertical press-and-move is the reorder's, and the
      // native drag is refused so the arm survives to engage; a horizontal one
      // is the drag-out's, and the arm stands down.
      function onDragStart(ev: DragEvent): void {
        if (!armed) return;
        if (Math.abs(dy) > Math.abs(dx)) {
          ev.preventDefault();
          return;
        }
        disarm();
      }

      window.addEventListener("pointermove", onArmMove);
      window.addEventListener("pointerup", disarm);
      window.addEventListener("dragstart", onDragStart, true);
    },
    [beginDrag, nativeDragSource],
  );

  return { onRowPointerDown };
}
