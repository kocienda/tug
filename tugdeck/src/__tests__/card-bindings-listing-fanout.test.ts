/**
 * The boot listing fan-out: one `list_sessions` per distinct project the deck
 * spans, kicked off the `list_card_bindings_ok` frame ([B09]).
 *
 * The session ledger's per-project listing is what a session row's rest line
 * is built from — turn count, size, last-used stamp — and the fetch has always
 * been real and already per-project. What it was not is eager: the hook that
 * kicks it runs when a ROW MOUNTS ([F08]), so with the Workspaces card closed
 * nothing was fetched at all, and the first open paid the latency on every
 * project at once.
 *
 * The frame this hangs off already knows every project the deck spans — it
 * lists every card id the ledger knows, not only the active deck's — so the
 * fan-out costs one pass over rows the handler was already walking. What is
 * pinned here is that it is bounded the way the decision claims: bounded by
 * DISTINCT projects rather than by sessions, and idempotent, so a row mounting
 * afterwards finds the listing settled and kicks nothing.
 *
 * The harness is the real `initActionDispatch` over a mock connection, so the
 * frame arrives the way tugcast sends it, and a real `SessionLedgerStore` over
 * a test channel, so the requests counted are the ones that would go on the
 * wire. Nothing mounts: there is no Workspaces card and no row in this file,
 * which is the state the whole decision is about.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  _resetForTest,
  dispatchAction,
  initActionDispatch,
} from "../action-dispatch";
import type { TugConnection } from "../connection";
import { FeedId } from "../protocol";
import { TestFrameChannel } from "../lib/code-session-store/testing/mock-feed-store";
import {
  _resetSessionLedgerStoreForTest,
  attachSessionLedgerStore,
  getSessionLedgerStore,
} from "../lib/session-ledger-store";

function createMockConnection() {
  const frameCallbacks = new Map<number, (payload: Uint8Array) => void>();
  return {
    onFrame(feedId: number, cb: (payload: Uint8Array) => void): () => void {
      frameCallbacks.set(feedId, cb);
      return () => frameCallbacks.delete(feedId);
    },
    sendControlFrame(): void {},
  };
}

function createMockDeckManager() {
  return {
    addCard: (): string | null => null,
    showSingletonCard: (): string | null => null,
    prepareForReload: (): Promise<void> => Promise.resolve(),
    getFocusedCardId: (): string | null => null,
  };
}

/** One binding row, with only the fields this file's question turns on. */
function row(
  cardId: string,
  sessionId: string,
  projectDir: string,
): Record<string, unknown> {
  return {
    card_id: cardId,
    session_id: sessionId,
    line_id: sessionId,
    project_dir: projectDir,
    state: "live",
    turn_count: 0,
  };
}

/** The project directories the store asked the server to list, in order. */
function listedProjects(channel: TestFrameChannel): string[] {
  const decoder = new TextDecoder();
  return channel.recordedFrames
    .filter((f) => f.feedId === FeedId.CONTROL)
    .map((f) => JSON.parse(decoder.decode(f.decoded as Uint8Array)))
    .filter((p) => p.action === "list_sessions")
    .map((p) => p.project_dir as string);
}

let teardown: (() => void) | null = null;
let channel: TestFrameChannel;

beforeEach(() => {
  _resetForTest();
  _resetSessionLedgerStoreForTest();
  channel = new TestFrameChannel();
  attachSessionLedgerStore(channel as unknown as TugConnection);
  teardown = initActionDispatch(
    createMockConnection() as never,
    createMockDeckManager() as never,
  );
});

afterEach(() => {
  teardown?.();
  teardown = null;
  // The ledger store's own dispose drops every bus subscription it took, so
  // nothing here resets `session-ledger-events` itself. That reset is
  // process-wide and `spaceBindingsLedgerStore.installOnce` is a one-shot
  // guard — clearing the bus under it leaves that store permanently deaf to
  // every later `list_card_bindings_ok`, in whatever file runs next.
  _resetSessionLedgerStoreForTest();
  _resetForTest();
});

describe("list_card_bindings_ok — the eager listing fan-out", () => {
  it("lists every distinct project, with nothing mounted", () => {
    dispatchAction({
      action: "list_card_bindings_ok",
      bindings: [
        row("c1", "s1", "/work/alpha"),
        row("c2", "s2", "/work/beta"),
      ],
    });

    expect(listedProjects(channel).sort()).toEqual([
      "/work/alpha",
      "/work/beta",
    ]);
  });

  it("lists each project exactly once, however many sessions it holds", () => {
    // The cost is bounded by projects, not by sessions — which is the whole
    // argument for doing it at boot rather than on demand.
    dispatchAction({
      action: "list_card_bindings_ok",
      bindings: [
        row("c1", "s1", "/work/alpha"),
        row("c2", "s2", "/work/alpha"),
        row("c3", "s3", "/work/alpha"),
        row("c4", "s4", "/work/beta"),
      ],
    });

    expect(listedProjects(channel).sort()).toEqual([
      "/work/alpha",
      "/work/beta",
    ]);
  });

  it("a later reader finds the listing already kicked and kicks nothing", () => {
    dispatchAction({
      action: "list_card_bindings_ok",
      bindings: [row("c1", "s1", "/work/alpha")],
    });
    expect(listedProjects(channel)).toEqual(["/work/alpha"]);

    // What a row does when it mounts — the on-demand path, arriving second.
    getSessionLedgerStore()?.getSnapshot("/work/alpha");
    expect(
      listedProjects(channel),
      "the store is keyed by project directory, so the second ask is free",
    ).toEqual(["/work/alpha"]);
  });

  it("a row carrying no project asks for nothing", () => {
    dispatchAction({
      action: "list_card_bindings_ok",
      bindings: [row("c1", "s1", ""), row("c2", "s2", "/work/alpha")],
    });

    expect(listedProjects(channel)).toEqual(["/work/alpha"]);
  });

  it("an empty frame asks for nothing at all", () => {
    dispatchAction({ action: "list_card_bindings_ok", bindings: [] });
    expect(listedProjects(channel)).toEqual([]);
  });
});
