/**
 * TugVersionGate — the app-wide, blocking "update macOS" gate. A sibling of
 * {@link ConfigureTug} at the deck root that reuses the same TugAlert chrome (Radix
 * AlertDialog portalled into the canvas overlay, `tug-alert-overlay`/
 * `tug-alert-content` at z 99990/99991). It opens only when the host macOS
 * version is *known* to be below its line's floor ([P05], Spec S02); above the
 * floor — or while the host is still unknown (pre-handshake) — it renders
 * nothing and the deck/ConfigureTug proceed.
 *
 * Precedence: the gate wins over ConfigureTug. Both read `useVersionGateOpen`, and
 * ConfigureTug suppresses its own `open` while the gate is open, so the two
 * app-modals never stack (Spec S02).
 *
 * No dismiss — like ConfigureTug, this is strictly required. Pure read of
 * `hostInfoStore` via the gate derivation ([L02]).
 */

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { TriangleAlert } from "lucide-react";
import { type ReactElement } from "react";
import { useCanvasOverlay } from "@/lib/use-canvas-overlay";
import { useHostInfo } from "@/lib/host-info-store";
import { useVersionGateOpen, requiredMinimumLabel } from "@/lib/macos-support";
import { usePublishAppModalOpen } from "@/lib/app-modal-store";
import "./tug-alert.css";
import "./tug-version-gate.css";

export function TugVersionGate(): ReactElement {
  const open = useVersionGateOpen();
  const host = useHostInfo();
  const overlayRoot = useCanvasOverlay();
  const required = requiredMinimumLabel(host);

  // Freeze the deck's card count while the gate is up ([B01]): the menu bar
  // is not inside Radix's focus trap, so ⌘N would open a card behind it.
  usePublishAppModalOpen("version-gate", open);

  return (
    <AlertDialog.Root open={open}>
      <AlertDialog.Portal container={overlayRoot}>
        <AlertDialog.Overlay className="tug-alert-overlay" />
        <AlertDialog.Content
          className="tug-alert-content tug-version-gate"
          data-slot="tug-version-gate"
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          {/* In-jail key sink ([P13]): AlertDialog.Content's FocusScope is
              always trapped — it yanks focus back from anywhere outside the
              jail. The engine's park must land INSIDE it (the engine parks
              at the innermost mounted sink), or every park while this gate
              is up is answered by a Radix refocus and the two systems
              fight. */}
          <div
            data-tug-key-sink=""
            tabIndex={-1}
            className="tug-key-sink"
            aria-label="Keyboard"
          />
          {/* Shared alert-case modal header (tugx-header.css): icon
              top-aligned to the title, multi-paragraph message below. */}
          <div className="tug-alert-body" data-has-message="true">
            <div className="tug-alert-icon" aria-hidden="true">
              <TriangleAlert />
            </div>
            <div className="tug-alert-text">
              <AlertDialog.Title className="tug-alert-title">
                Update macOS to Continue
              </AlertDialog.Title>
              <AlertDialog.Description className="tug-alert-message" asChild>
                <div>
                  <p>
                    Tug needs macOS {required} or later.
                    {host !== null
                      ? ` This Mac is running macOS ${host.version}.`
                      : ""}
                  </p>
                  <p className="tug-version-gate-hint">
                    Update in System Settings → General → Software Update, then
                    reopen Tug.
                  </p>
                </div>
              </AlertDialog.Description>
            </div>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
