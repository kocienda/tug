/**
 * activation-click-bridge.ts — receives the macOS host's click-through
 * activation point.
 *
 * When Tug.app is in the background, the click that brings it forward is
 * consumed by AppKit: `WKWebView` does not accept first mouse, so the document
 * sees no `pointerdown` at all and the card the user aimed at never becomes
 * active. `MainWindow.sendEvent` recognizes that first click, converts its
 * location into viewport (CSS) coordinates, and calls
 * `window.__tugBridge.onActivationClick({x, y})` (emit site:
 * `MainWindow.forwardActivationClick` — keep the callback name in lockstep).
 *
 * The point is handed to the gesture interpreter, which classifies it exactly
 * as it classifies a real pointerdown and runs the activation transfer. The
 * click itself is still swallowed: it activates, it does not press the button
 * or place the caret under the cursor.
 *
 * @module lib/activation-click-bridge
 */

import { activateAtViewportPoint } from "@/gesture-interpreter";
import { installHostChannel, onHostMessage } from "@/host/channel";
import { activationClickToPage } from "@/host/declarations/services";

let installed = false;

/**
 * Take `__tugBridge.onActivationClick({x, y})` in this page. Called once from
 * deck boot; safe to call again.
 */
export function installActivationClickBridge(): void {
  installHostChannel();
  if (installed) return;
  installed = true;
  onHostMessage(activationClickToPage, (payload) => {
    const { x, y } = payload as { x?: unknown; y?: unknown };
    if (typeof x !== "number" || typeof y !== "number") return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    activateAtViewportPoint(x, y);
  });
}
