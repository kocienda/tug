/**
 * The marker a focused text surface sets on (or within) itself to say it owns
 * Tab and Escape right now. Its meaning, and the pipeline that reads it, are
 * the focus manager's (`focus-manager.ts`, which re-exports this name); it
 * stands in a module of its own so the bus's command route can read the
 * marker without importing the focus manager, which imports the route back.
 *
 * @module lib/tab-consume-attribute
 */
export const TAB_CONSUME_ATTRIBUTE = "data-tug-tab-consume";
