/**
 * The two channels an `IngestHost` runs behind.
 *
 * Both carry the same messages — controls in, batches out — and the page's
 * facade cannot tell them apart:
 *
 *  - `WorkerIngestChannel` hosts it in the dedicated ingest Worker. This is
 *    production.
 *  - `InProcessIngestChannel` hosts it on the calling thread and passes every
 *    message through `structuredClone` in both directions, transferring the
 *    same buffers the Worker would, so anything that could not cross a thread
 *    fails here too. By default it flushes at the end of every message the
 *    host handles, which keeps delivery synchronous: a socket event in a unit
 *    test has reached the page's callbacks by the time the event returns.
 *
 * A batch the host posts while the page is still applying an earlier one (the
 * page's apply sent a frame, and the host answered) is queued and delivered
 * after it, in order, as a thread's message queue would.
 *
 * A channel can fail. The Worker's does when its module will not load, when a
 * message from it cannot be deserialized, or when the host throws out of a
 * control and the Worker reports it; each is reported once to the failure
 * listener, and the connection replaces the channel. The in-process channel
 * never reports one: a throw on the calling thread reaches its caller.
 */

import { IngestHost, type FlushPolicyFactory, type IngestHostOptions } from "./ingest-host";
import { PerMessageFlush } from "./pacer";
import type { SessionBatch, SessionControl } from "./session-patch";

/** The page's end of a channel. */
export interface IngestChannel {
  /** Post one control; `transfer` lists buffers the control gives away. */
  post(control: SessionControl, transfer?: ArrayBuffer[]): void;
  /** Where batches go. Batches posted before a listener is set wait for it. */
  setBatchListener(listener: (batch: SessionBatch) => void): void;
  /**
   * Where the channel's one failure goes, with a sentence saying what failed.
   * A failure reported before a listener is set waits for it.
   */
  setFailureListener(listener: (detail: string) => void): void;
  /** Stop the host. */
  dispose(): void;
}

export interface InProcessIngestChannelOptions extends IngestHostOptions {
  /** The host's flush policy; per-message by default. */
  readonly makePolicy?: FlushPolicyFactory;
}

export class InProcessIngestChannel implements IngestChannel {
  private readonly host: IngestHost;
  private listener: ((batch: SessionBatch) => void) | null = null;
  private readonly queue: SessionBatch[] = [];
  private delivering = false;

  constructor(options: InProcessIngestChannelOptions = {}) {
    this.host = new IngestHost(
      (batch, transfer) => this.deliver(structuredClone(batch, { transfer })),
      options.makePolicy ?? ((flush) => new PerMessageFlush(flush)),
      options,
    );
  }

  post(control: SessionControl, transfer: ArrayBuffer[] = []): void {
    this.host.handle(structuredClone(control, { transfer }));
  }

  /**
   * Feed the host one session-feed frame its owner received. Only a host
   * with no socket of its own is fed this way: the per-session host a test
   * frame source opens on this thread.
   */
  ingestFrame(feedId: number, payload: Uint8Array): void {
    this.host.ingestFrame(feedId, payload);
  }

  setBatchListener(listener: (batch: SessionBatch) => void): void {
    this.listener = listener;
    this.drain();
  }

  setFailureListener(): void {}

  dispose(): void {
    this.host.dispose();
  }

  private deliver(batch: SessionBatch): void {
    this.queue.push(batch);
    this.drain();
  }

  private drain(): void {
    if (this.delivering || this.listener === null) return;
    this.delivering = true;
    try {
      let batch = this.queue.shift();
      while (batch !== undefined) {
        this.listener(batch);
        batch = this.queue.shift();
      }
    } finally {
      this.delivering = false;
    }
  }
}

/** Builds the Worker; the default is the bundled ingest Worker entry. */
export type IngestWorkerFactory = () => Worker;

function bundledIngestWorker(): Worker {
  return new Worker(new URL("@/lib/workers/ingest-worker.ts", import.meta.url), { type: "module" });
}

/**
 * What the Worker posts instead of a batch when the host threw out of a
 * control: the host's state is no longer known, so the page replaces it.
 */
export interface IngestWorkerFailure {
  readonly kind: "failed";
  readonly error: string;
}

export class WorkerIngestChannel implements IngestChannel {
  private readonly worker: Worker;
  private batchListener: ((batch: SessionBatch) => void) | null = null;
  /** Batches that arrived before the listener was set. */
  private early: SessionBatch[] = [];
  private failureListener: ((detail: string) => void) | null = null;
  /** The failure, once one is seen; reported once, and nothing is delivered after it. */
  private failure: string | null = null;
  private disposed = false;

  constructor(makeWorker: IngestWorkerFactory = bundledIngestWorker) {
    this.worker = makeWorker();
    this.worker.onmessage = (event: MessageEvent<SessionBatch | IngestWorkerFailure>): void => {
      const message = event.data;
      if (message.kind === "failed") {
        this.fail(`the ingest Worker threw: ${message.error}`);
        return;
      }
      if (this.failure !== null) return;
      if (this.batchListener === null) this.early.push(message);
      else this.deliver(this.batchListener, message);
    };
    this.worker.onerror = (event: ErrorEvent): void => {
      // Handled here, so it is not also reported as the page's own error.
      event.preventDefault();
      this.fail(`the ingest Worker failed: ${event.message || "an error with no message"}`);
    };
    this.worker.onmessageerror = (): void => {
      this.fail("a message from the ingest Worker could not be deserialized");
    };
  }

  post(control: SessionControl, transfer: ArrayBuffer[] = []): void {
    if (this.failure !== null || this.disposed) return;
    this.worker.postMessage(control, transfer);
  }

  setBatchListener(listener: (batch: SessionBatch) => void): void {
    this.batchListener = listener;
    const early = this.early;
    this.early = [];
    for (const batch of early) this.deliver(listener, batch);
  }

  setFailureListener(listener: (detail: string) => void): void {
    this.failureListener = listener;
    if (this.failure !== null && !this.disposed) listener(this.failure);
  }

  /**
   * Hand a batch to the page, then tell the Worker it was applied — whatever
   * the listener did, so a throw on the page never stalls the next batch.
   */
  private deliver(listener: (batch: SessionBatch) => void, batch: SessionBatch): void {
    try {
      listener(batch);
    } finally {
      this.post({ kind: "batch-applied" });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.early = [];
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    this.worker.terminate();
  }

  private fail(detail: string): void {
    if (this.failure !== null || this.disposed) return;
    this.failure = detail;
    this.failureListener?.(detail);
  }
}
