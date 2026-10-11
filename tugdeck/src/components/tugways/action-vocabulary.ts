/**
 * action-vocabulary.ts — re-exports `lib/action-vocabulary.ts`.
 *
 * The vocabulary is a table of constants with no component dependency, and
 * `lib` modules dispatch actions too, so it lives in `lib` where both layers
 * can import it. Component callers keep importing it from here.
 */

export * from "@/lib/action-vocabulary";
