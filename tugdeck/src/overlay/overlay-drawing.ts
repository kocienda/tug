/**
 * What the overlay draws for the shell outside React: the surfaces cards
 * raise past their own box (`overlay-surface-drawer.ts`) and what a drag
 * indicates (`overlay-indication.ts`). Both are DOM written straight into the
 * page's overlay root from the stores the shell sends ([L06]); both wait for
 * that root, which mounts with the page's tree, and redraw when it comes.
 *
 * @module overlay/overlay-drawing
 */

import {
  overlayIndication,
  overlaySurfaceActivate,
  overlaySurfaceDismissed,
  overlaySurfaces,
} from "../bus/declarations/overlay";
import * as canvasOverlayRegistry from "../lib/canvas-overlay-registry";
import { paintIndication } from "./overlay-indication";
import { OverlaySurfaceDrawer } from "./overlay-surface-drawer";

/** Draw the shell's surfaces and indication in this page from now on. Returns the uninstall. */
export function installOverlayDrawing(): () => void {
  const drawer = new OverlaySurfaceDrawer({
    onActivate: (cardId, path) => overlaySurfaceActivate.dispatch({ cardId, path }),
    onDismiss: (cardId) => overlaySurfaceDismissed.dispatch({ cardId }),
  });
  const drawSurfaces = (): void => drawer.sync(overlaySurfaces.getSnapshot());
  const drawIndication = (): void => {
    const root = canvasOverlayRegistry.getRoot();
    if (root !== null) paintIndication(root, overlayIndication.getSnapshot());
  };
  const drawAll = (): void => {
    drawSurfaces();
    drawIndication();
  };
  const releases = [
    overlaySurfaces.subscribe(drawSurfaces),
    overlayIndication.subscribe(drawIndication),
    canvasOverlayRegistry.subscribe(drawAll),
  ];
  drawAll();
  return () => {
    for (const release of releases) release();
    drawer.dispose();
  };
}
