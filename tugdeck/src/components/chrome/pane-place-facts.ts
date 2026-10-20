/**
 * pane-place-facts.ts — re-exports `lib/pane-place-facts.ts`.
 *
 * The reading moved to `lib/` so the pane-chrome projection and the pane
 * verbs, which live there, can import it. Component callers keep importing
 * it from here.
 */
export * from "@/lib/pane-place-facts";
