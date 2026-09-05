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
 */
export function useAnnotatedElement<T extends HTMLElement>(
  deps: React.DependencyList = [],
): React.RefObject<T | null> {
  const ref = React.useRef<T | null>(null);
  const context = useAnnotationScope();
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || context === null) return;
    annotateElement(element, context);
    const subscribe = context.subscribe;
    if (subscribe === undefined) return;
    return subscribe((changed) => {
      const target = ref.current;
      if (target === null || !containerDependsOnVerdicts(target, changed)) {
        return;
      }
      annotateElement(target, context);
    });
    // `deps` is the caller's declaration of what its text derives from;
    // spreading it is the whole point of the parameter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, ...deps]);
  return ref;
}
