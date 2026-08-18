/**
 * ConfigureTugRequest — the gate in front of the on-demand setup wizard. Mounted
 * once as a deck-root sibling of ConfigureTug (under `TugAlertProvider`); renders
 * nothing. It watches the configure-tug-request nonce ({@link useConfigureTugRequest}) and
 * decides whether the wizard may open:
 *
 *   nothing running                 → open the wizard
 *   turns in flight → confirm       → interrupt every turn → open the wizard
 *                   → cancel        → nothing happens
 *
 * The wizard is app-modal and its steps re-run install / log-in / model
 * acquisition, so it must not come up over live work. That makes this the same
 * shape as {@link TugLogout} — an app-level orchestrator that stops turns
 * before an app-level state change — and it shares TugLogout's interrupt loop
 * and the TugAlert singleton ([L02]/[L06]).
 *
 * @module components/tugways/configure-tug-request
 */

import { useEffect, useRef } from "react";

import { useConfigureTugRequest, openConfigureTugOnDemand } from "@/lib/configure-tug-request-store";
import { getConnection } from "@/lib/connection-singleton";
import { cardServicesStore } from "@/lib/card-services-store";
import { useDeckManager } from "@/deck-manager-context";
import { useTugAlert } from "./tug-alert";

export function ConfigureTugRequest(): null {
  const nonce = useConfigureTugRequest();
  const deck = useDeckManager();
  const showAlert = useTugAlert();
  const handledRef = useRef(0);

  useEffect(() => {
    if (nonce === 0 || nonce === handledRef.current) return;
    handledRef.current = nonce;

    // Re-probe the Claude Code version pair on the way in. The launch probe
    // could be days old on a long-lived app, and the install row is about to
    // tell the user whether they are current — a stale answer there is worse
    // than a late one. Imperative on a transition, not a component effect
    // ([L02]/[L24]); the answering frame updates the store.
    getConnection()?.sendControlFrame("check_claude_version");

    // Which sessions are mid-turn right now. Same read as the logout path:
    // `canInterrupt` is the store's own answer to "is there a turn to stop".
    const running: Array<{ interrupt: () => void }> = [];
    for (const card of deck.getSnapshot().cards) {
      const services = cardServicesStore.getServices(card.id);
      if (services?.codeSessionStore.getSnapshot().canInterrupt) {
        running.push({
          interrupt: () => services.codeSessionStore.interrupt("configure-tug"),
        });
      }
    }

    if (running.length === 0) {
      openConfigureTugOnDemand();
      return;
    }

    let cancelled = false;
    void (async () => {
      const plural = running.length === 1 ? "session is" : "sessions are";
      const confirmed = await showAlert({
        title: "Stop Work and Open Setup?",
        message: `${running.length} ${plural} still working. Setup takes over the whole app, so those turns will stop.`,
        confirmLabel: "Stop and Open Setup",
        cancelLabel: "Cancel",
        confirmRole: "danger",
      });
      if (cancelled || !confirmed) return;
      // Stop the turns before the wizard covers them, so nothing is left
      // running behind a modal the user can't see past. Guarded: a card whose
      // session went away between the count and the confirm must not strand
      // the wizard.
      for (const session of running) {
        try {
          session.interrupt();
        } catch {
          // Session already gone — setup proceeds.
        }
      }
      openConfigureTugOnDemand();
    })();

    return () => {
      cancelled = true;
    };
  }, [nonce, showAlert, deck]);

  return null;
}
