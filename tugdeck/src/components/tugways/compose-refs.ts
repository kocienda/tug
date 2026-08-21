/**
 * `composeRefs` — hand one DOM node to several refs.
 *
 * **Why this exists.** A wrapper that needs the live trigger element reaches
 * for `React.cloneElement(child, { ref: mine })` — and a `ref` in the clone's
 * props *replaces* the child's own. The child then never learns its own node,
 * silently: it still renders, still takes clicks, and only the machinery that
 * reads the element through its ref stops working. That is how a tooltip on a
 * choice segment cost the whole group its keyboard cursor — the segment's ref
 * populated the array the movement cursor moves over, the tooltip's clone
 * overwrote it, `collectItems()` came back empty, and no ring ever painted
 * even though the group held the key view.
 *
 * So a wrapper composes rather than assigns: `composeRefs(child.props.ref,
 * mine)` gives the node to both, in order, and the child keeps whatever it was
 * already doing with it.
 *
 * Callback and object refs are both accepted, and `null`/`undefined` entries
 * are skipped so a caller can pass an optional ref straight through. React 19
 * lets a callback ref return its own cleanup; when any of the composed refs
 * does, the composition returns one that runs every teardown — the returned
 * cleanups for the refs that gave one, and the classic `ref(null)` call for
 * the refs that did not.
 */

import type { Ref } from "react";

/** What a composed ref may be handed — the shapes React itself accepts. */
type ComposableRef<T> = Ref<T> | undefined;

/**
 * Compose `refs` into one callback ref. Refs are applied left to right, so a
 * child's own ref should come first: it is the one whose contract predates the
 * wrapper's.
 */
export function composeRefs<T>(
  ...refs: ComposableRef<T>[]
): (node: T | null) => void | (() => void) {
  return (node: T | null) => {
    const cleanups: (void | (() => void))[] = refs.map((ref) => {
      if (typeof ref === "function") return ref(node);
      if (ref !== null && ref !== undefined) {
        (ref as { current: T | null }).current = node;
      }
      return undefined;
    });
    if (!cleanups.some((cleanup) => typeof cleanup === "function")) return;
    return () => {
      refs.forEach((ref, index) => {
        const cleanup = cleanups[index];
        if (typeof cleanup === "function") {
          cleanup();
        } else if (typeof ref === "function") {
          ref(null);
        } else if (ref !== null && ref !== undefined) {
          (ref as { current: T | null }).current = null;
        }
      });
    };
  };
}

/**
 * The ref a JSX element was authored with. React 19 carries `ref` as an
 * ordinary prop, and reading it off the element itself is the access the
 * version removed — so a wrapper about to clone reads it from here.
 */
export function refOfElement<T>(element: {
  props: unknown;
}): ComposableRef<T> {
  const props = element.props as { ref?: ComposableRef<T> } | null;
  return props?.ref;
}
