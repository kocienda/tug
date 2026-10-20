/**
 * plain-equal — value equality for the plain-data props the canvas hands a
 * pane, and the props a pane hands its chrome.
 *
 * @module lib/plain-equal
 */

/**
 * Value equality for the plain-data props the canvas hands a pane.
 *
 * The canvas derives its arrangement afresh on every deck commit, so
 * `placement`, `slotStack`, `columnMember`, `sidebarStack`, `sizePolicy` and
 * `cards` arrive as new objects each time — equal in content for every pane
 * the commit did not move. Compared by identity they never match, and a fold
 * of one card re-rendered all eleven frames on the user's deck before its
 * first frame could paint. Compared by value, a pane whose props say the same
 * thing has nothing to render: its frame is where it was, and the card under
 * it reads its own stores.
 *
 * Plain objects and arrays compare by value, recursively. Anything else — a
 * function, a class instance, a React element — compares by identity, which
 * is why the canvas keeps its per-stack callbacks stable (`LayerPanes`).
 */
export function plainEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (!plainEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const protoA = Object.getPrototypeOf(a);
  const protoB = Object.getPrototypeOf(b);
  const plainA = protoA === Object.prototype || protoA === null;
  const plainB = protoB === Object.prototype || protoB === null;
  if (!plainA || !plainB) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keysA = Object.keys(ra);
  if (keysA.length !== Object.keys(rb).length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(rb, key)) return false;
    if (!plainEqual(ra[key], rb[key])) return false;
  }
  return true;
}
