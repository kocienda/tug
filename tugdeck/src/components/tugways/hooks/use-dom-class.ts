/**
 * useDOMClass -- Appearance-zone hook for CSS class toggling.
 *
 * Part of the three-zone mutation model (design-system-concepts.md Concept 5).
 *
 * ## Three Mutation Zones
 *
 * | Zone       | Mechanism                              | Re-renders |
 * |------------|----------------------------------------|------------|
 * | Appearance | CSS custom properties, classes, styles | Never      |
 * | Local data | External mutable store + subscriptions | Subscribing component only |
 * | Structure  | React state at lowest common ancestor  | Affected subtree |
 *
 * This hook serves the **appearance zone**: it writes directly to the DOM via
 * `classList.toggle()` inside a `useEffect`, bypassing React's reconciler
 * entirely. No state changes. No re-renders.
 *
 * ## Governing rules
 *
 * - [L24] Appearance-zone mutations never use React state
 * - [D13] DOM utility hooks for the appearance zone
 *
 * ## Design choice
 *
 * Single-property signature: call the hook multiple times for multiple
 * class names instead of passing an array (avoids the Rule 5 footgun).
 *
 * ## Usage
 *
 * ```tsx
 * const ref = useRef<HTMLDivElement>(null);
 * useDOMClass(ref, "demo-highlighted", isHighlighted);
 * useDOMClass(ref, "demo-active", isActive);
 * ```
 *
 * @module hooks/use-dom-class
 */

import { useEffect } from "react";

/**
 * Toggle a CSS class on a ref'd element -- zero React re-renders.
 *
 * Appearance-zone hook. Uses useEffect to call `ref.current.classList.toggle()`
 * when `className` or `condition` changes. Safe against null refs.
 *
 * The ref itself is excluded from the dependency array because React ref objects
 * are stable (same object identity across renders). The hook reacts to changes
 * in `className` and `condition` only.
 *
 * Cleanup removes the class via `classList.remove(className)` using the
 * element reference captured at effect-run time, ensuring stable cleanup even
 * if `ref.current` changes or becomes null during unmount.
 *
 * @param ref       - React ref to the target DOM element
 * @param className - CSS class name to toggle
 * @param condition - Boolean: true adds the class, false removes it
 */
export function useDOMClass(
  ref: React.RefObject<HTMLElement | null>,
  className: string,
  condition: boolean
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.classList.toggle(className, condition);
    return () => {
      el.classList.remove(className);
    };
  }, [ref, className, condition]);
}
