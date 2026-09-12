/**
 * The annotation scope — how a block deep in the transcript gets the
 * annotator without being handed it.
 *
 * The annotator needs live inputs (the command catalog, the path
 * resolvers) that only the transcript host can assemble. Passing those
 * down as props works for the handful of components the host renders
 * directly, and fails for everything below them: a Bash tool block is many
 * levels down, renders its command line itself, and would have needed
 * every ancestor to agree to forward a prop it does not otherwise care
 * about. That is why tool headers went unannotated — not a decision, a
 * consequence of the plumbing.
 *
 * So the inputs travel as React context and a block opts in with one hook:
 *
 * ```tsx
 * const ref = useAnnotatedElement<HTMLElement>([command]);
 * return <code ref={ref}>{command}</code>;
 * ```
 *
 * Outside a provider the hook is inert, so a component that also renders
 * in a gallery or a non-transcript surface needs no conditional.
 *
 * **Laws:** [L03] — marking runs in `useLayoutEffect`, because the
 * transcript's delegated click and context-menu listeners resolve a
 * gesture by reading these marks; a mark applied in a passive effect could
 * miss a gesture in the frame it was painted. [L06] — the hook writes DOM
 * attributes and classes only; whether something looks clickable is CSS
 * reading those attributes, never React state.
 *
 * @module components/tugways/annotation-scope
 */

import React from "react";
import { flushSync } from "react-dom";

import {
  annotateElement,
  containerDependsOnVerdicts,
} from "@/lib/annotator/annotate-content";
import type { AnnotationContext } from "@/lib/annotator/types";

const AnnotationScopeContext = React.createContext<AnnotationContext | null>(
  null,
);

/** Props for {@link AnnotationScope}. */
export interface AnnotationScopeProps {
  /** The live annotator inputs, or `undefined` to leave descendants inert. */
  value: AnnotationContext | undefined;
  children: React.ReactNode;
}

/**
 * Publish the annotator's inputs to every descendant. Mounted once by the
 * transcript host around the rows it renders.
 */
export function AnnotationScope({
  value,
  children,
}: AnnotationScopeProps): React.ReactElement {
  return (
    <AnnotationScopeContext.Provider value={value ?? null}>
      {children}
    </AnnotationScopeContext.Provider>
  );
}

/**
 * The annotator inputs in scope, or `null` outside a provider. For a
 * component that needs to pass the context on rather than mark its own
 * DOM — a markdown block, which annotates as part of rendering.
 */
export function useAnnotationScope(): AnnotationContext | null {
  return React.useContext(AnnotationScopeContext);
}

/**
 * Mark the entities in an element's own text. Attach the returned ref to
 * the element whose text should be scanned.
 *
 * `deps` names what the element's text is derived from, so the scan re-runs
 * when the text changes rather than on every render of an ancestor. The
 * annotator inputs are always a dependency. A verdict arriving late does
 * not change the context's identity — it arrives through the context's
 * batched subscription, and re-marks this element only when the batch names
 * a verdict this element's last pass actually consulted.
 *
 * `onAnnotated` runs after every pass, over the element just marked — the
 * same callback a markdown block hands its renderer, and how a surface that
 * marks its own DOM earns the portalled hovers its marks deserve
 * ({@link useAnnotationPortals}). It is read from a ref rather than kept in
 * the effect's dependencies on purpose: the callback fires on annotation
 * passes, not on renders, so a caller that rebuilds it per render re-marks
 * nothing.
 *
 * **The verdict pass flushes.** A portal hook meeting a newly marked run
 * EMPTIES the host and `setState`s so a portal fills it. In the layout
 * effect those are one frame, because React flushes an update scheduled
 * during the commit phase before the browser paints. The verdict
 * subscription is a timer callback and gets no such guarantee, so the frame
 * that empties a newly confirmed path would be a frame the reader sees a
 * hole in the sentence. `flushSync` makes it one frame there too — the same
 * guard `TugMarkdownBlock`'s `announceAnnotated` makes for the streaming
 * path, for the same reason.
 */
export function useAnnotatedElement<T extends HTMLElement>(
  deps: React.DependencyList = [],
  onAnnotated?: (element: HTMLElement) => void,
): React.RefObject<T | null> {
  const ref = React.useRef<T | null>(null);
  const context = useAnnotationScope();
  const annotated = React.useRef(onAnnotated);
  // Declared ahead of the marking effect so it holds this render's callback
  // before that effect runs; on the first mount the ref's initial value is
  // already the right one.
  React.useLayoutEffect(() => {
    annotated.current = onAnnotated;
  });
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || context === null) return;
    annotateElement(element, context);
    annotated.current?.(element);
    const subscribe = context.subscribe;
    if (subscribe === undefined) return;
    return subscribe((changed) => {
      const target = ref.current;
      if (target === null || !containerDependsOnVerdicts(target, changed)) {
        return;
      }
      annotateElement(target, context);
      const announce = annotated.current;
      if (announce !== undefined) flushSync(() => announce(target));
    });
    // `deps` is the caller's declaration of what its text derives from;
    // spreading it is the whole point of the parameter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, ...deps]);
  return ref;
}
