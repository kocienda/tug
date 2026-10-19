/**
 * The wire under a page bus: frames out, frames in parsed once, and the
 * three connection facts the page bus needs — a target tugcast could not
 * deliver to, the connection closing, and the connection opening (the first
 * time and every time it comes back).
 *
 * {@link connectionTransport} is the real one, over a `TugConnection`'s
 * `DECK_BUS` feed. `createTestBus()` (`bus/test-bus.ts`) supplies a fake
 * one per page, so the page bus above it is the real library in both.
 *
 * @module bus/transport
 */

import type { TugConnection } from "../connection";
import type { ConnectionLifecycle } from "../lib/connection-lifecycle";
import { FeedId } from "../protocol";
import { tugDevLogStore } from "../lib/tug-dev-log-store/tug-dev-log-store";
import type { BusTarget, EnvelopeIn, EnvelopeOut } from "./envelope";

export interface BusTransport {
  /** This page's id, as tugcast registered it: a replica's name in a store's acknowledgements. */
  readonly pageId: string;
  /** Put one envelope on the wire. Returns the bytes it took. A closed wire drops it. */
  send(envelope: EnvelopeOut): number;
  /** Every delivered frame, parsed once. */
  onFrame(listener: (delivered: EnvelopeIn) => void): () => void;
  /** A target tugcast answered `bus_undeliverable` for. */
  onUndeliverable(listener: (to: BusTarget) => void): () => void;
  /** This page's connection closed. */
  onDisconnect(listener: () => void): () => void;
  /** This page's connection opened: its first open, and every one after a close. */
  onOpen(listener: () => void): () => void;
}

type BusConnection = Pick<TugConnection, "send" | "onFrame" | "getPageId">;
type BusLifecycle = Pick<ConnectionLifecycle, "observeConnectionDidOpen" | "observeConnectionDidClose">;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function connectionTransport(connection: BusConnection, lifecycle: BusLifecycle): BusTransport {
  return {
    pageId: connection.getPageId(),
    send(envelope) {
      const bytes = encoder.encode(JSON.stringify(envelope));
      connection.send(FeedId.DECK_BUS, bytes);
      return bytes.byteLength;
    },
    onFrame(listener) {
      return connection.onFrame(FeedId.DECK_BUS, (payload) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(decoder.decode(payload));
        } catch {
          tugDevLogStore.warn("bus", "a DECK_BUS frame was not JSON; skipped");
          return;
        }
        if (typeof parsed !== "object" || parsed === null) {
          tugDevLogStore.warn("bus", "a DECK_BUS frame was not an envelope; skipped");
          return;
        }
        listener(parsed as EnvelopeIn);
      });
    },
    onUndeliverable(listener) {
      return connection.onFrame(FeedId.CONTROL, (payload) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(decoder.decode(payload));
        } catch {
          return;
        }
        if (typeof parsed !== "object" || parsed === null) return;
        const control = parsed as { type?: unknown; detail?: unknown; to?: unknown };
        if (control.type !== "error" || control.detail !== "bus_undeliverable") return;
        listener(control.to as BusTarget);
      });
    },
    onDisconnect(listener) {
      return lifecycle.observeConnectionDidClose(listener);
    },
    onOpen(listener) {
      return lifecycle.observeConnectionDidOpen(listener);
    },
  };
}
