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
   * with no socket of its own is fed this way: the page's in-process session
   * host, until the engines move to the Worker.
   */
  ingestFrame(feedId: number, payload: Uint8Array): void {
    this.host.ingestFrame(feedId, payload);
  }

  setBatchListener(listener: (batch: SessionBatch) => void): void {
    this.listener = listener;
    this.drain();
  }

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

export class WorkerIngestChannel implements IngestChannel {
  private readonly worker: Worker;

  constructor(makeWorker: IngestWorkerFactory = bundledIngestWorker) {
    this.worker = makeWorker();
  }

  post(control: SessionControl, transfer: ArrayBuffer[] = []): void {
    this.worker.postMessage(control, transfer);
  }

  setBatchListener(listener: (batch: SessionBatch) => void): void {
    this.worker.onmessage = (event: MessageEvent<SessionBatch>): void => {
      listener(event.data);
    };
  }

  dispose(): void {
    this.worker.terminate();
  }
}
