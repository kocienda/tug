/**
 * `useAnnotationClicks` — the delegated primary-click layer for annotated ink.
 *
 * Everything an interaction layer needs about an annotated element is on the
 * element (`annotation-element.ts`), so one listener on a surface's root
 * services every reference under it, whoever rendered it: prose the annotator
 * marked, a tool header a component stamped, the file reference a beat
 * wears. The registry decides what a click on a given kind does, so a new kind
 * costs a surface nothing.
 *
 * The transcript wrote this layer first and the Overview copied it verbatim; a
 * third surface asking for it (the masthead's beat line and its beat-history
 * popover) is what makes it a hook rather than a shape to re-type. What a
 * surface still owns is WHERE the root is and what a click may reach —
 * `activateCard`, and the session store a command seeds into.
 *
 * **A surface with a click of its own asks first.** The beat line toggles its
 * history popover on click and carries a file reference inside that same run;
 * {@link annotationClaimsClick} is how the host declines the gesture the
 * reference is about to take, so a click on the path opens the file rather
 * than doing both.
 *
 * Laws: [L03] the listener is live before any click it services.
 *
 * @module components/tugways/use-annotation-clicks
 */

import React from "react";

import {
  annotationFromEvent,
  type ResolvedAnnotation,
} from "@/lib/annotator/annotation-element";
import {
  annotationEntryFor,
  type AnnotationDispatchContext,
} from "@/lib/annotator/registry";

/**
 * The annotation this click acts on, or `null` when it acts on none.
 *
 * Modified clicks fall through so text selection and the platform's own link
 * gestures keep working; an anchor navigates itself (the host's navigation
 * delegate routes it), and acting here too would open it twice; the tail of a
 * drag-selection over an annotation is not a click on it; and a kind with no
 * registered click behavior claims nothing.
 */
function clickedAnnotation(event: MouseEvent): ResolvedAnnotation | null {
  if (event.button !== 0 || event.metaKey || event.shiftKey) return null;
  const hit = annotationFromEvent(event);
  if (hit === null) return null;
  if (hit.element instanceof HTMLAnchorElement) return null;
  if (annotationEntryFor(hit.payload.kind)?.primaryClick === undefined) {
    return null;
  }
  const selection = window.getSelection();
  if (selection !== null && !selection.isCollapsed) return null;
  return hit;
}

/**
 * Whether this click is an annotation's — a host with a click gesture of its
 * own calls this to stand down, so one press performs one act.
 */
export function annotationClaimsClick(event: MouseEvent): boolean {
  return clickedAnnotation(event) !== null;
}

/**
 * Service annotation clicks under `ref`. Attached once, for the life of the
 * surface: `ctx` is read through a ref, so a changing card id or store moves
 * what a click reaches without re-attaching the listeners.
 */
export function useAnnotationClicks(
  ref: React.RefObject<HTMLElement | null>,
  ctx: AnnotationDispatchContext,
): void {
  const ctxRef = React.useRef(ctx);
  React.useLayoutEffect(() => {
    ctxRef.current = ctx;
  }, [ctx]);

  React.useLayoutEffect(() => {
    const root = ref.current;
    if (root === null) return;
    const onClick = (event: MouseEvent): void => {
      const hit = clickedAnnotation(event);
      if (hit === null) return;
      annotationEntryFor(hit.payload.kind)?.primaryClick?.(
        hit.payload,
        ctxRef.current,
      );
    };
    // An annotation that opens something must not let the press move DOM
    // focus (the composer's caret would go with it). The kinds that need that
    // protection declare it on the element; the rest are left alone so a press
    // inside prose still starts a selection.
    const onMouseDown = (event: MouseEvent): void => {
      if (event.button !== 0 || event.metaKey || event.shiftKey) return;
      const hit = annotationFromEvent(event);
      if (hit === null) return;
      if (hit.element.dataset.noActivate === undefined) return;
      event.preventDefault();
    };
    root.addEventListener("click", onClick);
    root.addEventListener("mousedown", onMouseDown);
    return () => {
      root.removeEventListener("click", onClick);
      root.removeEventListener("mousedown", onMouseDown);
    };
  }, [ref]);
}
