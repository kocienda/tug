/**
 * focus-marks — the elements the focus projection has written one mark onto.
 *
 * The engine is the only writer of its projection marks (`data-key-view`,
 * `data-key-within`, `data-default-ring`), so clearing a stale mark means
 * clearing exactly what it wrote — no document-wide scan per projection, which
 * is paid about nine times per activation and grows with the deck.
 *
 * The bookkeeping is the engine's, so it must not outlive what it tracks: an
 * element that has left the document is forgotten when the engine learns a
 * registration went away ({@link TrackedMark.forgetDetached}) rather than held
 * until some later projection happens to run. That is what keeps an unmounted
 * card's subtree from being retained by a set nobody reads.
 *
 * Written against {@link MarkTarget} rather than `HTMLElement`, so the
 * bookkeeping is a pure function over data and its tests need no document.
 */

/** The slice of an element a projection mark reads and writes. */
export interface MarkTarget {
  readonly isConnected: boolean;
  hasAttribute(name: string): boolean;
  removeAttribute(name: string): void;
}

export class TrackedMark<E extends MarkTarget = HTMLElement> {
  private readonly marked: Set<E> = new Set();

  /** `attrs` is every attribute this mark owns; a clear removes all of them. */
  constructor(private readonly attrs: readonly string[]) {}

  /**
   * Clear the mark from every tracked element other than `keep`, forgetting
   * each as it goes. Returns how many elements actually carried the mark — an
   * element the engine marked and something else since unmarked costs a write
   * it does not count.
   */
  clearExcept(keep: E | null): number {
    let writes = 0;
    for (const el of this.marked) {
      if (el === keep) continue;
      this.marked.delete(el);
      if (this.attrs.some((a) => el.hasAttribute(a))) writes += 1;
      for (const a of this.attrs) el.removeAttribute(a);
    }
    return writes;
  }

  /** Record that the projection wrote this mark onto `el`. */
  track(el: E): void {
    this.marked.add(el);
  }

  /**
   * Drop every tracked element that has left the document. Its attributes
   * are left alone: nothing can see a mark on a detached element, and the
   * element is the unmounted subtree's to free.
   */
  forgetDetached(): void {
    for (const el of this.marked) {
      if (!el.isConnected) this.marked.delete(el);
    }
  }

  /** Whether `el` is tracked. */
  has(el: E): boolean {
    return this.marked.has(el);
  }

  /** How many elements are tracked. */
  get size(): number {
    return this.marked.size;
  }
}
