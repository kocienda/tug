/**
 * The atom placeholder, alone in a leaf module.
 *
 * `tug-atom-img.ts` re-exports it, and most callers import it from there. A
 * module low in the graph that needs only the character — `slash-commands.ts`
 * — imports it from here, because `tug-atom-img` pulls in a graph that comes
 * back around to it before it has finished evaluating.
 */

/** U+FFFC — Object Replacement Character representing an atom in the text flow. */
export const TUG_ATOM_CHAR = "￼";
