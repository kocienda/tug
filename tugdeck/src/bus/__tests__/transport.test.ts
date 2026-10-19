/**
 * The real transport over a connection: frames are encoded as JSON on the
 * bus feed, parsed once on the way in, and a CONTROL `bus_undeliverable`
 * error is read as its target.
 */

import { describe, expect, test } from "bun:test";
import { FeedId } from "../../protocol";
import type { EnvelopeIn } from "../envelope";
import { connectionTransport } from "../transport";

function fakeConnection() {
  const feeds = new Map<number, Array<(payload: Uint8Array) => void>>();
  const out: Array<{ feedId: number; text: string }> = [];
  return {
    out,
    push(feedId: number, value: unknown) {
      const bytes = new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
      for (const l of feeds.get(feedId) ?? []) l(bytes);
    },
    connection: {
      getPageId: () => "page-1",
      send(feedId: number, payload: Uint8Array) {
        out.push({ feedId, text: new TextDecoder().decode(payload) });
      },
      onFrame(feedId: number, callback: (payload: Uint8Array) => void) {
        const list = feeds.get(feedId) ?? [];
        list.push(callback);
        feeds.set(feedId, list);
        return () => list.splice(list.indexOf(callback), 1);
      },
    },
  };
}

const lifecycle = {
  observeConnectionDidOpen: () => () => {},
  observeConnectionDidClose: () => () => {},
};

describe("connectionTransport", () => {
  test("sends one JSON envelope on DECK_BUS and reports its bytes", () => {
    const fake = fakeConnection();
    const transport = connectionTransport(fake.connection as never, lifecycle as never);
    const bytes = transport.send({ to: "shell", kind: "hello", payload: { role: "body", cardId: "c1" } });
    expect(fake.out).toHaveLength(1);
    expect(fake.out[0].feedId).toBe(FeedId.DECK_BUS);
    expect(JSON.parse(fake.out[0].text)).toEqual({ to: "shell", kind: "hello", payload: { role: "body", cardId: "c1" } });
    expect(bytes).toBe(fake.out[0].text.length);
  });

  test("hands on each delivered frame parsed, and skips one that is not an envelope", () => {
    const fake = fakeConnection();
    const transport = connectionTransport(fake.connection as never, lifecycle as never);
    const got: EnvelopeIn[] = [];
    transport.onFrame((d) => got.push(d));
    const delivered = { from: { pageId: "p", role: "shell", cardId: null }, to: { card: "c1" }, kind: "state", key: "k" };
    fake.push(FeedId.DECK_BUS, delivered);
    fake.push(FeedId.DECK_BUS, "not json");
    fake.push(FeedId.DECK_BUS, 7);
    expect(got).toEqual([delivered as EnvelopeIn]);
  });

  test("reads a CONTROL bus_undeliverable as its target and ignores every other control", () => {
    const fake = fakeConnection();
    const transport = connectionTransport(fake.connection as never, lifecycle as never);
    const targets: unknown[] = [];
    transport.onUndeliverable((to) => targets.push(to));
    fake.push(FeedId.CONTROL, { type: "error", detail: "bus_malformed" });
    fake.push(FeedId.CONTROL, { type: "page_bound", card_id: "c1" });
    fake.push(FeedId.CONTROL, { type: "error", detail: "bus_undeliverable", to: { card: "nobody" } });
    expect(targets).toEqual([{ card: "nobody" }]);
  });
});
