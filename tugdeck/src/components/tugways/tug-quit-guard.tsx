/**
 * TugQuitGuard — the app-level quit orchestrator. Mounted once as a deck-root
 * sibling of TugLogout (under the shell's alert provider); renders nothing. It
 * watches the quit-request nonce ({@link useQuitRequest}) and runs the guard's
 * question in the shared alert, which the host keeps in the overlay page. The
 * decision and the copy are `quitGuard`'s; only the alert is here, because
 * `useTugAlert` needs a component to read it from.
 *
 * @module components/tugways/tug-quit-guard
 */

import { useEffect, useRef } from "react";

import { quitGuard, useQuitRequest } from "@/lib/quit-guard-store";
import { useTugAlert } from "./tug-alert";

export function TugQuitGuard(): null {
  const nonce = useQuitRequest();
  const showAlert = useTugAlert();
  const handledRef = useRef(0);

  useEffect(() => {
    if (nonce === 0 || nonce === handledRef.current) return;
    handledRef.current = nonce;
    void quitGuard.ask(showAlert);
  }, [nonce, showAlert]);

  return null;
}
