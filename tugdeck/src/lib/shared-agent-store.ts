/**
 * shared-agent-store — the deck's view of the SharedAgent's tenant switches.
 *
 * The agent itself lives in tugcast; nothing on this side runs a model or knows
 * how one is spawned. What the deck needs is narrower: whether a tenant is
 * switched on, and whether there is a socket to ask over.
 *
 * That pair *is* readiness. There is deliberately no "can the agent answer right
 * now" probe to go with them, because the answer would be worthless: the agent
 * is a remote model over the user's subscription, so the only honest way to know
 * whether it can answer is to ask it, and every caller already degrades cleanly
 * when it cannot. A readiness probe would add a round trip to learn something
 * the next round trip settles anyway, and would go stale between the asking and
 * the acting.
 *
 * [L02] `useSyncExternalStore` over the tugbank client's change notifications;
 * no local persistence.
 *
 * @module lib/shared-agent-store
 */

import { useSyncExternalStore } from "react";

import { getTugbankClient } from "./tugbank-singleton";
import { getConnectionLifecycle } from "./connection-lifecycle";

/**
 * Tugbank domain for the shared agents. Mirrors `SHARED_AGENT_DOMAIN` in
 * `tugrust/crates/tugcast/src/shared_agent.rs`.
 */
export const SHARED_AGENT_DOMAIN = "dev.tugtool.shared-agent";

/** Per-tenant kill switch for shell arbitration. Deck-only; no Rust reader. */
export const SHELL_ROUTING_KEY = "shell-routing";

export type SharedAgentTenant = typeof SHELL_ROUTING_KEY;

/**
 * A tenant kill switch. Absent — and any non-bool — reads as enabled, the
 * repo's kill-switch convention, so a tenant is never accidentally dark because
 * a value was never written.
 */
export function readTenantEnabled(key: SharedAgentTenant): boolean {
  const client = getTugbankClient();
  if (!client) return true;
  const entry = client.get(SHARED_AGENT_DOMAIN, key);
  if (entry === undefined) return true;
  return entry.value !== false;
}

/** Subscribe to changes in this domain, so a flipped switch is live. */
function subscribeToDomain(listener: () => void): () => void {
  const client = getTugbankClient();
  if (!client) return () => {};
  return client.onDomainChanged((domain: string) => {
    if (domain === SHARED_AGENT_DOMAIN) listener();
  });
}

/** Whether a tenant's switch is on. */
export function useTenantEnabled(tenant: SharedAgentTenant): boolean {
  return useSyncExternalStore(
    subscribeToDomain,
    () => readTenantEnabled(tenant),
    () => true,
  );
}

/**
 * Every lifecycle edge that can change whether the wire is alive. The
 * lifecycle publishes transitions rather than state, so readiness subscribes to
 * all four and re-reads `getState()`.
 */
function subscribeToTransport(listener: () => void): () => void {
  const lifecycle = getConnectionLifecycle();
  if (lifecycle === null) return () => {};
  const unsubscribes = [
    lifecycle.observeConnectionDidOpen(listener),
    lifecycle.observeConnectionDidReconnect(listener),
    lifecycle.observeConnectionDidClose(listener),
    lifecycle.observeConnectionDidEnterReconnecting(listener),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

/** Whether there is a live wire to ask over. */
function transportOpen(): boolean {
  return getConnectionLifecycle()?.getState() === "open";
}

/**
 * Whether a tenant should ask the agent right now: its switch is on and there
 * is a transport to ask over. A slow or failed call degrades on its own, so
 * these two are the whole precondition.
 */
export function useSharedAgentReady(tenant: SharedAgentTenant): boolean {
  const enabled = useTenantEnabled(tenant);
  const connected = useSyncExternalStore(
    subscribeToTransport,
    transportOpen,
    () => false,
  );
  return enabled && connected;
}
