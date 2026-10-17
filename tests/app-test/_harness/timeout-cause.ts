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
 *
 * A selector that names no card (`[data-slot="tug-sheet"]`) gives the script
 * nothing to read a card from, so the harness asks the pages instead: after a
 * shell timeout it evaluates the same condition in every body, and checks in
 * the shell and in every body each selector the script queries. A condition
 * that holds in a body, or a selector that matches there and not in the
 * shell, is the same cause found by evidence ({@link bodyEvidenceCause}).
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

/**
 * The selectors `script` passes to `querySelector` / `querySelectorAll` as
 * string literals, once each. A selector built at run time (`card + " .x"`) is
 * not read.
 */
export function selectorsQueried(script: string): string[] {
  const out: string[] = [];
  for (const m of script.matchAll(/querySelector(?:All)?\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)/g)) {
    const raw = m[1];
    let selector: string;
    try {
      selector = raw.startsWith('"') ? (JSON.parse(raw) as string) : (JSON.parse(`"${raw.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`) as string);
    } catch {
      continue;
    }
    if (!out.includes(selector)) out.push(selector);
  }
  return out;
}

/** A script, for any page, answering which of `selectors` match there. */
export function selectorProbe(selectors: readonly string[]): string {
  return `(function(){ var s = ${JSON.stringify(selectors)}; return s.map(function(x){ try { return document.querySelector(x) !== null; } catch (e) { return false; } }); })()`;
}

/** What one body answered after a shell timeout. */
export interface BodyEvidence {
  readonly cardId: string;
  /** The waited-on condition, evaluated in the body, was truthy. */
  readonly holds: boolean;
  /** The queried selectors that match in the body. */
  readonly matches: readonly string[];
}

/**
 * The sentence to add to a shell-side timeout from what the pages answered,
 * or null when nothing points at a body: the bodies where the condition
 * holds, else the bodies where a queried selector the shell lacks matches.
 */
export function bodyEvidenceCause(shellMatches: readonly string[], bodies: readonly BodyEvidence[]): string | null {
  const holds = bodies.filter((b) => b.holds).map((b) => b.cardId);
  if (holds.length > 0) {
    return (
      `evaluated in the shell, but the condition holds in card ${holds.map((id) => JSON.stringify(id)).join(", ")}'s body — ` +
      `reach it with app.body(${JSON.stringify(holds[0])})`
    );
  }
  const found = bodies
    .map((b) => ({ cardId: b.cardId, only: b.matches.filter((s) => !shellMatches.includes(s)) }))
    .filter((b) => b.only.length > 0);
  if (found.length === 0) return null;
  const first = found[0];
  return (
    `evaluated in the shell, but ${JSON.stringify(first.only[0])} matches only in card ` +
    `${found.map((b) => JSON.stringify(b.cardId)).join(", ")}'s body — reach it with app.body(${JSON.stringify(first.cardId)})`
  );
}
