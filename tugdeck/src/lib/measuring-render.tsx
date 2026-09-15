/**
 * measuring-render — the flag a component reads to know it is being rendered
 * for its size rather than for the screen.
 *
 * A measuring render exists to answer one question: how tall is this panel at
 * this width? It is thrown away in the same synchronous flush that produced it,
 * and it is INERT ([P09]) — it starts no timers, opens no subscriptions, fires
 * no analytics, and takes no focus. Most of the tree needs no help with that,
 * because most of the tree does none of those things at render. The ones that do
 * read this flag and skip.
 *
 * It is a context rather than a module-level boolean because the measuring root
 * and the live roots render into the same document, and a global would be read
 * by whichever tree happened to render next.
 */

import { createContext, useContext } from "react";
import type { ReactNode } from "react";

const MeasuringRenderContext = createContext<boolean>(false);

/**
 * Marks its subtree as a measuring render. Mounted only by the measuring root;
 * nothing on the live path provides it, so the default `false` is what every
 * on-screen render reads.
 */
export function MeasuringRenderProvider({ children }: { children?: ReactNode }) {
  return <MeasuringRenderContext value={true}>{children}</MeasuringRenderContext>;
}

/** True when this render is being taken to read a size, not to paint. */
export function useIsMeasuringRender(): boolean {
  return useContext(MeasuringRenderContext);
}
