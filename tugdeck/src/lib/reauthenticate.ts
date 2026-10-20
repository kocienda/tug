/**
 * reauthenticate — a page's answer to a tugcast that restarted under it.
 *
 * The host calls `window.tugdeck.reauthenticate({ token })` in every page when
 * tugcast comes back with a new auth token. The `/auth` fetch sets the new
 * session cookie, and the forced reconnect then opens the WebSocket on it
 * without waiting out the backoff. A failed fetch leaves the reconnect loop
 * to keep trying on its own.
 *
 * @module lib/reauthenticate
 */

/** Take the restarted tugcast's cookie for `payload.token`, then reconnect. */
export function reauthenticate(payload: { token: string }, connection: { forceReconnect(): void }): null {
  void fetch(`/auth?token=${encodeURIComponent(payload.token)}`, { credentials: "include" }).then(
    () => connection.forceReconnect(),
    () => {},
  );
  return null;
}
