/**
 * spelling-actions — the Learn Spelling / Ignore Spelling handlers every
 * editable text surface registers beside its own `CORRECT_SPELLING`.
 *
 * Unlike a correction, neither touches the surface's text: each hands the
 * word the menu was opened over to the host's spell checker. They are
 * registered on the surface that offered the spelling block, rather than at
 * the deck root, so they answer from whichever page that surface lives in.
 *
 * @module components/tugways/spelling-actions
 */

import { TUG_ACTIONS, type TugAction } from "./action-vocabulary";
import type { ActionEvent, ActionHandler } from "./responder-chain";
import { rememberSpelling } from "@/lib/spelling-guesses";

/** Spread into a surface's actions map. */
export const SPELLING_MEMORY_HANDLERS: Partial<Record<TugAction, ActionHandler>> = {
  [TUG_ACTIONS.LEARN_SPELLING]: (event: ActionEvent) => {
    if (typeof event.value === "string") rememberSpelling(event.value, "learn");
  },
  [TUG_ACTIONS.IGNORE_SPELLING]: (event: ActionEvent) => {
    if (typeof event.value === "string") rememberSpelling(event.value, "ignore");
  },
};
