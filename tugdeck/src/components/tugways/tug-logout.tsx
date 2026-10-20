/**
 * TugLogout — the app-level logout orchestrator. Mounted once as a deck-root
 * sibling of ConfigureTug (under `TugAlertProvider`); renders nothing. It watches
 * the logout-request nonce ({@link useLogoutRequest}) and drives the flow:
 *
 *   confirm (app-modal TugAlert) → interrupt every in-progress turn →
 *   `claude_logout` → on success ConfigureTug reopens (auth flips logged-out),
 *   on failure/timeout a "Couldn't log out" alert (the user stays logged in).
 *
 * Logout is app-level (it stops every session and reopens the wizard), so it
 * lives here rather than on a Session card — both the File-menu item and the
 * `/logout` slash command funnel through {@link requestLogout}. The confirm and
 * error surfaces use the shared TugAlert singleton ([L02]/[L06]); the login
 * state itself is owned by `authStore` and read by ConfigureTug.
 *
 * @module components/tugways/tug-logout
 */

import { useEffect, useRef } from "react";

import { authStore, useAuth } from "@/lib/auth-store";
import { useLogoutRequest } from "@/lib/logout-store";
import { getConnection } from "@/lib/connection-singleton";
import { cardServicesStore } from "@/lib/card-services-store";
import { useCardDeck } from "@/card-deck-context";
import { useTugAlert } from "./tug-alert";

/**
 * No `claude_logout_result` within this window → treat the logout as failed.
 * It's a quick local CLI op, so a hang means the wire or the CLI is stuck; the
 * user gets an error instead of a spinner that never resolves.
 */
const LOGOUT_TIMEOUT_MS = 30_000;

export function TugLogout(): null {
  const nonce = useLogoutRequest();
  const { loggingOut, logoutError } = useAuth();
  const deck = useCardDeck();
  const showAlert = useTugAlert();
  const handledRef = useRef(0);

  // A new logout request: confirm, then run it.
  useEffect(() => {
    if (nonce === 0 || nonce === handledRef.current) return;
    handledRef.current = nonce;
    // Only meaningful when logged in. If we're already logged out (ConfigureTug is
    // showing), a logout request is a no-op — don't stack a confirm over it.
    if (authStore.getSnapshot().loggedIn !== true) return;
    let cancelled = false;
    void (async () => {
      const confirmed = await showAlert({
        title: "Log Out of Claude?",
        message:
          "Your in-progress turns will stop, and you'll need to log in again to continue.",
        confirmLabel: "Log Out",
        cancelLabel: "Cancel",
        confirmRole: "danger",
      });
      if (cancelled || !confirmed) return;
      // Interrupt every in-progress turn FIRST — stop turns cleanly before
      // the auth machinery pulls the rug, so no turn is mid-flight when the
      // login is revoked. Tagged "logout" so each committed turn's end-state
      // reads "Stopped — logged out". Kept synchronous and guarded (no await
      // before the logout frame) so a card without a live session can't throw
      // and strand the critical path.
      try {
        for (const card of deck.getSnapshot().cards) {
          const services = cardServicesStore.getServices(card.id);
          if (services?.codeSessionStore.getSnapshot().canInterrupt) {
            services.codeSessionStore.interrupt("logout");
          }
        }
      } catch {
        // A card without an interruptible session — ignore; logout proceeds.
      }
      // Then run the logout: flip the in-flight flag and send the frame.
      authStore.setLoggingOut(true);
      getConnection()?.sendControlFrame("claude_logout");
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce, showAlert, deck]);

  // Bound the wait so a stuck logout surfaces an error instead of hanging.
  useEffect(() => {
    if (!loggingOut) return;
    const timer = window.setTimeout(
      () => authStore.markLogoutTimedOut(),
      LOGOUT_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [loggingOut]);

  // Surface a logout failure. Clear it first so it fires exactly once.
  useEffect(() => {
    if (logoutError === null) return;
    const reason = logoutError;
    authStore.clearLogoutError();
    void showAlert({
      title: "Couldn't Log Out",
      message: `${reason} You're still logged in.`,
      confirmLabel: "OK",
      cancelLabel: null,
      confirmRole: "action",
    });
  }, [logoutError, showAlert]);

  return null;
}
