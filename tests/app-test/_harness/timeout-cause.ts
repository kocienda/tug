/**
 * timeout-cause.ts — what a shell-side timeout most likely means.
 *
 * A card that is a body is its own page, and its DOM is not in the shell's
 * document. A shell `waitForCondition` whose script scopes a selector by
 * `[data-card-id="X"]` therefore waits forever when X is a body: the
 * expression is right and the page is wrong. The census
 * (`scripts/card-dom-census.ts`) catches the reaches it can read, but not
 * every one, and the ones it misses fail as a bare timeout that looks like
 * any other. This names the cause in the error, so the reds of one run group
 * by it instead of by their selectors.
 */

/** The card ids a script scopes by `data-card-id`, in order, once each. */
export function cardIdsNamed(script: string): string[] {
  const ids: string[] = [];
  for (const m of script.matchAll(/data-card-id=\\*["']([^"'\\\]]+)\\*["']/g)) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

/**
 * The sentence to add to a shell-side timeout, or null when nothing points
 * at a body: the cards the script names that the host holds as bodies.
 * A selector naming a body's placeholder (`[data-body-placeholder]`) reads
 * the shell on purpose and is not counted.
 */
export function shellTimeoutCause(
  script: string,
  bodyCardIds: readonly string[],
): string | null {
  const named = cardIdsNamed(script.replace(/\[data-body-placeholder\][^\s,)]*/g, ""));
  const inBodies = named.filter((id) => bodyCardIds.includes(id));
  if (inBodies.length === 0) return null;
  const list = inBodies.map((id) => JSON.stringify(id)).join(", ");
  return (
    `evaluated in the shell, but card ${list} ${inBodies.length === 1 ? "is a body" : "are bodies"}: ` +
    `its DOM is in its own page — reach it with app.body(${JSON.stringify(inBodies[0])})`
  );
}
