/// <reference lib="webworker" />

/**
 * Installed in the ingest Worker's realm ahead of its entry (see
 * `holding-ingest-worker.ts`): every batch the Worker posts reaches the page
 * {@link HOLD_MS} late, in order. The socket is not held, so tugcast has the
 * hello while the page has heard nothing — the order a descheduled Worker
 * thread produces by chance, here on purpose.
 */

export {};

const HOLD_MS = 250;

const scope = self as unknown as DedicatedWorkerGlobalScope;

const post = scope.postMessage.bind(scope);
scope.postMessage = ((message: unknown, transfer: Transferable[] = []) => {
  setTimeout(() => post(message, transfer), HOLD_MS);
}) as typeof scope.postMessage;
