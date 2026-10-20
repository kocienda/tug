/**
 * configure-tug-request-store — the on-demand channel into ConfigureTug ([L02]).
 *
 * ConfigureTug normally opens on its own terms: a first run, or an app that isn't
 * set up yet. The Tug-menu "Configure Tug…" item is the other way in — the user
 * asking for the wizard on an app that is already set up. That request can't be a
 * prop (ConfigureTug is mounted once at the deck root with no parent to pass one)
 * and it isn't derivable from auth or the deck, so it lives here.
 *
 * Two pieces of state, because the request and the open wizard have different
 * lifetimes:
 *   - `nonce` — a monotonic "Configure Tug… was invoked" signal. A nonce, not a
 *     boolean, so repeated invocations each fire with nothing to reset.
 *     `ConfigureTugRequest` watches it and runs the gate (confirm → interrupt).
 *   - `onDemand` — whether the wizard is currently open by request. ConfigureTug
 *     ORs it into its own `open` derivation and clears it on Done.
 *
 * @module lib/configure-tug-request-store
 */

import { Subscribable } from "./subscribable";
import { useSyncExternalStore } from "@/lib/gesture-scope";


class ConfigureTugRequestStore extends Subscribable {
  private _nonce = 0;
  private _onDemand = false;

  getNonce = (): number => this._nonce;

  getOnDemand = (): boolean => this._onDemand;

  request(): void {
    this._nonce += 1;
    this.notify();
  }

  setOnDemand(open: boolean): void {
    if (this._onDemand === open) return;
    this._onDemand = open;
    this.notify();
  }
}

const configureTugRequestStore = new ConfigureTugRequestStore();

/** Request the Configure Tug wizard (from the Tug menu). Runs the gate first. */
export function requestConfigureTug(): void {
  configureTugRequestStore.request();
}

/** Open the wizard on demand — called once the gate has cleared. */
export function openConfigureTugOnDemand(): void {
  if (onDemandSink !== null) onDemandSink();
  else configureTugRequestStore.setOnDemand(true);
}

let onDemandSink: (() => void) | null = null;

/**
 * Open the wizard somewhere other than this page: where the host keeps an
 * overlay, the wizard is the overlay's, and the shell's request opens it
 * there (`overlay.openConfigure`). `null` opens it here again.
 */
export function setConfigureTugOnDemandSink(sink: (() => void) | null): void {
  onDemandSink = sink;
}

/** Open the wizard in this page, whatever the sink: the overlay's answer to `overlay.openConfigure`. */
export function showConfigureTugOnDemand(): void {
  configureTugRequestStore.setOnDemand(true);
}

/** Close an on-demand wizard (the Done button). */
export function closeConfigureTugOnDemand(): void {
  configureTugRequestStore.setOnDemand(false);
}

/** React read of the configure-tug-request nonce ([L02]); changes on each request. */
export function useConfigureTugRequest(): number {
  return useSyncExternalStore(
    configureTugRequestStore.subscribe,
    configureTugRequestStore.getNonce,
  );
}

/** React read of whether the wizard is open by request ([L02]). */
export function useConfigureTugOnDemand(): boolean {
  return useSyncExternalStore(
    configureTugRequestStore.subscribe,
    configureTugRequestStore.getOnDemand,
  );
}
