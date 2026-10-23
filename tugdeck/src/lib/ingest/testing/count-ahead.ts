/// <reference lib="webworker" />

/**
 * Installed in the ingest Worker's realm ahead of its entry (see
 * `counting-ingest-worker.ts`): stamps each batch the Worker posts with
 * `aheadAtPost`, the number of batches posted and not yet acknowledged by the
 * page, this one included. A host bounded on the page's acknowledgement never
 * stamps more than 1; one that posts a batch a period whatever the page does
 * stamps a growing queue.
 *
 * The listener is registered here, before the entry sets `onmessage`, so an
 * acknowledgement is counted before the host's flush can post the next batch.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;
let ahead = 0;

scope.addEventListener("message", (event: MessageEvent<{ kind?: unknown }>) => {
  if (event.data?.kind === "batch-applied") ahead = Math.max(0, ahead - 1);
});

const post = scope.postMessage.bind(scope);
scope.postMessage = ((message: unknown, transfer: Transferable[] = []) => {
  if (typeof message === "object" && message !== null && (message as { kind?: unknown }).kind === "batch") {
    ahead += 1;
    post({ ...message, aheadAtPost: ahead }, transfer);
    return;
  }
  post(message, transfer);
}) as typeof scope.postMessage;
