/**
 * useDOMStyle -- Appearance-zone hook for inline style property mutations.
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
 * `style.setProperty()` inside a `useEffect`, bypassing React's reconciler
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
 * properties instead of passing an object (avoids the Rule 5 footgun).
 *
 * ## Usage
 *
 * ```tsx
 * const ref = useRef<HTMLDivElement>(null);
 * useDOMStyle(ref, "border-width", isThick ? "3px" : "1px");
 * useDOMStyle(ref, "opacity", isVisible ? "1" : "0");
 * // Pass empty string to remove the property entirely:
 * useDOMStyle(ref, "border-color", overrideActive ? "var(--tug7-element-global-fill-normal-accent-rest)" : "");
 * ```
 *
 * @module hooks/use-dom-style
 */

import { useEffect } from "react";

/**
 * Set a single inline style property on a ref'd element -- zero React re-renders.
 *
 * Appearance-zone hook. Uses useEffect to call `ref.current.style.setProperty()`
 * when `property` or `value` changes. Removes the property when value is empty
 * string. Safe against null refs.
 *
 * The ref itself is excluded from the dependency array because React ref objects
 * are stable (same object identity across renders). The hook reacts to changes
 * in `property` and `value` only.
 *
 * Cleanup removes the property via `style.removeProperty(property)` using the
 * element reference captured at effect-run time, ensuring stable cleanup even
 * if `ref.current` changes or becomes null during unmount.
 *
 * @param ref      - React ref to the target DOM element
 * @param property - CSS property name (e.g., "border-width")
 * @param value    - CSS value string (e.g., "2px"), or "" to remove the property
 */
export function useDOMStyle(
  ref: React.RefObject<HTMLElement | null>,
  property: string,
  value: string
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (value !== "") {
      el.style.setProperty(property, value);
    } else {
      el.style.removeProperty(property);
    }
    return () => {
      el.style.removeProperty(property);
    };
  }, [ref, property, value]);
}
