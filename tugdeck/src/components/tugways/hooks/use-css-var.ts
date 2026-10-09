/**
 * useCSSVar -- Appearance-zone hook for CSS custom property mutations.
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
 * useCSSVar(ref, "--tug7-element-global-fill-normal-accent-rest", isActive ? "var(--tug7-element-global-fill-normal-accent-rest)" : "var(--tug7-element-global-fill-normal-accentCool-rest)");
 * ```
 *
 * @module hooks/use-css-var
 */

import { useEffect } from "react";

/**
 * Set a CSS custom property on a ref'd element -- zero React re-renders.
 *
 * Appearance-zone hook. Uses useEffect to call `ref.current.style.setProperty()`
 * when `name` or `value` changes. Safe against null refs.
 *
 * The ref itself is excluded from the dependency array because React ref objects
 * are stable (same object identity across renders). The hook reacts to changes
 * in `name` and `value` only.
 *
 * Cleanup removes the property via `style.removeProperty(name)` using the
 * element reference captured at effect-run time, ensuring stable cleanup even
 * if `ref.current` changes or becomes null during unmount.
 *
 * @param ref   - React ref to the target DOM element
 * @param name  - CSS custom property name (e.g., "--tug7-element-global-fill-normal-accent-rest")
 * @param value - CSS value string (e.g., "var(--tug7-element-global-fill-normal-accent-rest)")
 */
export function useCSSVar(
  ref: React.RefObject<HTMLElement | null>,
  name: string,
  value: string
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty(name, value);
    return () => {
      el.style.removeProperty(name);
    };
  }, [ref, name, value]);
}
