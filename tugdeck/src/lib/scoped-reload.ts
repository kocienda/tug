/**
 * A reload scoped to the pages that import the changed module.
 *
 * Vite's module graph is one graph for every page the dev server serves, and
 * when an edit's propagation reaches a root with no accept boundary Vite
 * answers with `full-reload` to every connected client: the shell, the
 * overlay, every body and the spare all reload for an edit only one of them
 * imports. The tug deck's pages share one root, `entry.ts`, which picks one of
 * four page entries by the query — and every path from a changed module to
 * that root passes through the entry of the page that imports it. So the walk
 * here is Vite's own propagation with one change: a path that arrives at a
 * page entry stops there and names it, rather than running on to the shared
 * root and reloading everything.
 *
 * The dev server's `scopedReloadPlugin` (`vite.config.ts`) runs the walk over
 * Vite's graph and sends `tug:reload` naming the entries reached, and each
 * page's client (`installScopedReload`) reloads itself only when its own entry
 * is named. Accept boundaries found on the way are still updated in place, in
 * the pages that are not reloading.
 *
 * The walk reads what Vite records — `isSelfAccepting`, `acceptedHmrDeps`,
 * `acceptedHmrExports` — rather than guessing by extension, so the two agree
 * on what counts as an accepting module.
 *
 * @module lib/scoped-reload
 */

/** The four pages `entry.ts` chooses between. */
export type PageEntry = "shell" | "body" | "overlay" | "spike";

/** Each page's entry module, relative to the deck's root (`tugdeck/`). */
export const PAGE_ENTRY_FILES: Readonly<Record<PageEntry, string>> = {
  shell: "src/main.tsx",
  body: "src/body/body-main.ts",
  overlay: "src/overlay/overlay-main.ts",
  spike: "src/body/spike-page.ts",
};

/** The custom HMR event the plugin sends and every page listens for. */
export const SCOPED_RELOAD_EVENT = "tug:reload";

/** What `tug:reload` carries. */
export interface ScopedReload {
  readonly entries: readonly PageEntry[];
}

/** The part of a Vite module node the walk reads. */
export interface GraphNode {
  readonly id: string | null;
  readonly file: string | null;
  readonly isSelfAccepting?: boolean;
  readonly acceptedHmrDeps: ReadonlySet<GraphNode>;
  readonly acceptedHmrExports: ReadonlySet<string> | null;
  readonly importedBindings: ReadonlyMap<string, ReadonlySet<string>> | null;
  readonly importers: ReadonlySet<GraphNode>;
}

/** A module that takes the update in place, and the module it took it through. */
export interface Boundary<N extends GraphNode> {
  readonly boundary: N;
  readonly acceptedVia: N;
}

/**
 * What an edit asks of the pages:
 * - `update` — every path met an accept boundary, so Vite's own update is all there is.
 * - `reload` — some paths reached page entries: those pages reload, and the boundaries the other paths met are updated in place.
 * - `unscoped` — some path reached a root that is not past a page entry (`entry.ts` itself, or a module outside the pages), so only Vite's full reload is safe.
 */
export type ReloadScope<N extends GraphNode> =
  | { readonly kind: "update" }
  | { readonly kind: "reload"; readonly entries: readonly PageEntry[]; readonly boundaries: readonly Boundary<N>[] }
  | { readonly kind: "unscoped" };

function allAccepted(bindings: ReadonlySet<string>, accepted: ReadonlySet<string>): boolean {
  for (const binding of bindings) if (!accepted.has(binding)) return false;
  return true;
}

/**
 * Walk from the changed modules toward the root, as Vite's `propagateUpdate`
 * does, stopping a path at a page entry. `entryOf` names the page a module
 * is the entry of, or null.
 */
export function reloadScopeOf<N extends GraphNode>(
  changed: readonly N[],
  entryOf: (node: N) => PageEntry | null,
): ReloadScope<N> {
  const traversed = new Set<N>();
  const boundaries: Boundary<N>[] = [];
  const entries = new Set<PageEntry>();

  // True when the path reaches a root that no page entry stands before.
  const walk = (node: N, chain: readonly N[]): boolean => {
    if (traversed.has(node)) return false;
    traversed.add(node);
    // Not yet transformed: Vite stops here too, since no page has run it.
    if (node.id !== null && node.isSelfAccepting === undefined) return false;
    if (node.isSelfAccepting) {
      boundaries.push({ boundary: node, acceptedVia: node });
      return false;
    }
    const entry = entryOf(node);
    if (entry !== null) {
      entries.add(entry);
      return false;
    }
    if (node.acceptedHmrExports) boundaries.push({ boundary: node, acceptedVia: node });
    else if (node.importers.size === 0) return true;
    for (const importer of node.importers as ReadonlySet<N>) {
      if (importer.acceptedHmrDeps.has(node)) {
        boundaries.push({ boundary: importer, acceptedVia: node });
        continue;
      }
      if (node.id !== null && node.acceptedHmrExports && importer.importedBindings) {
        const bindings = importer.importedBindings.get(node.id);
        if (bindings && allAccepted(bindings, node.acceptedHmrExports)) continue;
      }
      if (!chain.includes(importer) && walk(importer, [...chain, importer])) return true;
    }
    return false;
  };

  for (const node of changed) {
    if (walk(node, [node])) return { kind: "unscoped" };
  }
  if (entries.size === 0) return { kind: "update" };
  // A boundary only every reloading page holds has nothing to update: the
  // reload brings the new module, and an update sent into a page that is
  // reloading fails as it tears down.
  const held = boundaries.filter(({ boundary }) => {
    const pages = pagesHolding(boundary, entryOf);
    return pages === null || pages.some((page) => !entries.has(page));
  });
  return { kind: "reload", entries: [...entries].sort(), boundaries: held };
}

/** The pages whose entries import `node`, or null when some path reaches a root no entry stands before. */
function pagesHolding<N extends GraphNode>(node: N, entryOf: (node: N) => PageEntry | null): PageEntry[] | null {
  const pages = new Set<PageEntry>();
  const seen = new Set<N>([node]);
  const queue: N[] = [node];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const entry = entryOf(current);
    if (entry !== null) {
      pages.add(entry);
      continue;
    }
    if (current.importers.size === 0) return null;
    for (const importer of current.importers as ReadonlySet<N>) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      queue.push(importer);
    }
  }
  return [...pages];
}

/** Whether a `tug:reload` names `entry`. */
export function namesEntry(payload: unknown, entry: PageEntry): boolean {
  const entries = (payload as Partial<ScopedReload> | null)?.entries;
  return Array.isArray(entries) && entries.includes(entry);
}

/**
 * Reload this page when a `tug:reload` names its entry, after `beforeReload`
 * (the shell's teardown capture). Dev only: the caller passes its entry's
 * `import.meta.hot`.
 */
export function installScopedReload(
  hot: NonNullable<ImportMeta["hot"]>,
  entry: PageEntry,
  beforeReload?: () => void,
): void {
  hot.on(SCOPED_RELOAD_EVENT, (payload: unknown) => {
    if (!namesEntry(payload, entry)) return;
    beforeReload?.();
    window.location.reload();
  });
}
