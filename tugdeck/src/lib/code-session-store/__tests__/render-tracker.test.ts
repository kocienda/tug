/**
 * `RenderTracker` driven directly: the facts of the display rule for
 * tugcast's renders ([P06]) with no engine, socket, or reducer behind them —
 * the dispatch views, text writes and render batches an engine would hand
 * it, a hand-advanced clock, and the entries and asks it answers with.
 *
 * The host-level tests (`ingest-host.rendered.test.ts`) hold the same rule
 * end to end; these reach the cases a reducer makes awkward to stage: a
 * pruned turn, a close with waits armed, a non-text last Message, a replay.
 */

import { describe, expect, test } from "bun:test";
import type { RenderedMessageWire } from "@tugproto/rendered";
import type { RenderedState } from "@tugproto/ingest";
import { ManualClock } from "@/lib/ingest/testing/manual-clock";
import { textHash } from "@/lib/ingest/text-hash";
import {
  RENDER_FINISHER_MS,
  RENDER_RESYNC_ASKS,
  RENDER_RESYNC_BACKOFF_MS,
  RENDER_RESYNC_MAX_MS,
  RenderTracker,
  type RenderDispatchView,
  type RenderedEntry,
} from "../render-tracker";

const KEY = "msg-1-b1";
const TURN = "t-1";
const NO_TURNS: ReadonlyArray<{ turnKey: string }> = [];

function harness({ renders = true }: { renders?: boolean } = {}) {
  const clock = new ManualClock();
  const posts: RenderedEntry[][] = [];
  const asks: string[] = [];
  const tracker = new RenderTracker({
    timerSource: clock,
    post: (entries) => posts.push(entries),
    askWhole: (messageKey) => asks.push(messageKey),
    tugcastRenders: () => renders,
  });
  /** Every state posted for `key`, in order. */
  const states = (key = KEY): RenderedState[] =>
    posts.flat().filter((e) => e.messageKey === key).map((e) => e.state);
  /** The last state posted for `key`. */
  const latest = (key = KEY): RenderedState | undefined => {
    const all = states(key);
    return all[all.length - 1];
  };
  return { clock, tracker, posts, asks, states, latest };
}

/** A dispatch whose pending turn's last Message is the text Message `key`. */
function live(text: string, key = KEY, transcript = NO_TURNS): RenderDispatchView {
  return { pendingTurnKey: TURN, last: { messageKey: key, text }, replaying: false, transcript };
}

/** A dispatch with no turn pending. */
function idle(transcript = NO_TURNS): RenderDispatchView {
  return { pendingTurnKey: null, last: undefined, replaying: false, transcript };
}

/** A whole render of `text`, one block per hash, carrying HTML for `withHtml`. */
function render(text: string, blocks: string[], withHtml: string[] = blocks, key = KEY): RenderedMessageWire {
  return {
    messageKey: key,
    channel: "text",
    seq: 1,
    baseSeq: 0,
    blocksFrom: 0,
    blocks: blocks.map((hash, i) => ({
      hash,
      kind: "paragraph",
      startChar: i,
      endChar: i + 1,
      depth: 0,
      itemCount: 0,
      rowCount: 0,
    })),
    html: Object.fromEntries(withHtml.map((h) => [h, `<p>${h}</p>`])),
    textLength: text.length,
    textHash: textHash(text),
  };
}

const NOT_FOUND = () => null;

describe("minting", () => {
  test("a live text Message mints pending, and its finisher tells the row to parse once", () => {
    const { clock, tracker, states } = harness();
    tracker.afterDispatch(live("Hello"));
    expect(states()).toEqual([{ pending: true }]);
    clock.advance(RENDER_FINISHER_MS);
    expect(states()).toEqual([{ pending: true }, null]);
    clock.advance(10 * RENDER_FINISHER_MS);
    expect(states()).toHaveLength(2);
  });

  test("a non-text last Message, a replay, or a tugcast that does not render mints nothing", () => {
    const tool = harness();
    tool.tracker.afterDispatch({ pendingTurnKey: TURN, last: { messageKey: KEY, text: null }, replaying: false, transcript: NO_TURNS });
    const replay = harness();
    replay.tracker.afterDispatch({ ...live("Hello"), replaying: true });
    const silent = harness({ renders: false });
    silent.tracker.afterDispatch(live("Hello"));
    for (const h of [tool, replay, silent]) {
      h.clock.advance(10 * RENDER_FINISHER_MS);
      expect(h.posts).toEqual([]);
      expect(h.tracker.track(KEY)?.finisher ?? null).toBeNull();
    }
  });

  test("a render that beats its mint is applied at the mint; one still waiting at turn end is dropped", () => {
    const { tracker, states } = harness();
    tracker.rendered([render("Hi", ["a"])], NOT_FOUND, true);
    expect(states()).toEqual([]);
    tracker.afterDispatch(live("Hi"));
    expect(states()).toEqual([{ streaming: true, current: false, message: render("Hi", ["a"]) }]);

    const late = harness();
    late.tracker.rendered([render("Hi", ["a"])], NOT_FOUND, true);
    late.tracker.afterDispatch(idle());
    late.tracker.afterDispatch(live("Hi"));
    expect(late.states()).toEqual([{ pending: true }]);
  });
});

describe("finalizing", () => {
  test("a Message stops streaming when another becomes the turn's last, current only on a matching record", () => {
    const { clock, tracker, latest } = harness();
    tracker.afterDispatch(live("Hi"));
    tracker.rendered([render("Hi", ["a"])], NOT_FOUND, true);
    tracker.afterDispatch(live("next", "msg-2-b1"));
    const last = latest() as { streaming: boolean; current: boolean };
    expect(last.streaming).toBe(false);
    expect(last.current).toBe(true);
    clock.advance(10 * RENDER_FINISHER_MS);
    expect(latest()).not.toBeNull();
  });

  test("a finalized Message whose text moves is re-read at the next dispatch's end", () => {
    const { clock, tracker, latest } = harness();
    tracker.afterDispatch(live("Hi"));
    tracker.rendered([render("Hi", ["a"])], NOT_FOUND, true);
    tracker.afterDispatch(idle());
    expect((latest() as { current: boolean }).current).toBe(true);
    tracker.textWritten(KEY, "Hi there");
    tracker.afterDispatch(idle());
    expect((latest() as { current: boolean }).current).toBe(false);
    clock.advance(RENDER_FINISHER_MS);
    expect(latest()).toBeNull();
  });

  test("a Message minted empty starts its finisher with its first text", () => {
    const { clock, tracker, states } = harness();
    tracker.afterDispatch(live(""));
    clock.advance(10 * RENDER_FINISHER_MS);
    expect(states()).toEqual([{ pending: true }]);
    tracker.textWritten(KEY, "H");
    clock.advance(RENDER_FINISHER_MS);
    expect(states()).toEqual([{ pending: true }, null]);
  });

  test("a committed Message a resync renders starts finalized, through the engine's lookup", () => {
    const { tracker, states } = harness();
    tracker.rendered([render("Done", ["a"])], () => ({ turnKey: "t-0", text: "Done" }), false);
    const [state] = states() as { streaming: boolean; current: boolean }[];
    expect(state.streaming).toBe(false);
    expect(state.current).toBe(true);
  });
});

describe("asking for the whole render", () => {
  test("a missing hash asks, backs off doubling to the cap, and stops at the bound", () => {
    const { clock, tracker, asks } = harness();
    tracker.afterDispatch(live("Hi"));
    tracker.rendered([render("Hi", ["a", "b"], ["a"])], NOT_FOUND, true);
    expect(asks).toEqual([KEY]);
    clock.advance(RENDER_RESYNC_BACKOFF_MS - 1);
    expect(asks).toHaveLength(1);
    clock.advance(1);
    expect(asks).toHaveLength(2);
    clock.advance(RENDER_RESYNC_MAX_MS * (RENDER_RESYNC_ASKS + 2));
    expect(asks).toHaveLength(RENDER_RESYNC_ASKS);
    expect(tracker.track(KEY)?.resyncTimer ?? null).toBeNull();
  });

  test("a complete emission ends the asking and resets the count", () => {
    const { clock, tracker, asks } = harness();
    tracker.afterDispatch(live("Hi"));
    tracker.rendered([render("Hi", ["a", "b"], ["a"])], NOT_FOUND, true);
    tracker.rendered([render("Hi", ["a", "b"], ["b"])], NOT_FOUND, true);
    const track = tracker.track(KEY)!;
    expect(track.incomplete).toBe(false);
    expect(track.resyncAsks).toBe(0);
    expect(track.resyncTimer).toBeNull();
    clock.advance(RENDER_RESYNC_MAX_MS * 4);
    expect(asks).toEqual([KEY]);
  });

  test("a diff off a base not held is not posted, and asks", () => {
    const { tracker, asks, states } = harness();
    tracker.afterDispatch(live("Hi"));
    tracker.rendered([{ ...render("Hi", ["a"]), seq: 3, baseSeq: 2, blocksFrom: 1 }], NOT_FOUND, true);
    expect(states()).toEqual([{ pending: true }]);
    expect(asks).toEqual([KEY]);
  });
});

describe("lifetime", () => {
  test("a turn the transcript drops is forgotten, and its waits disarmed", () => {
    const { clock, tracker, posts } = harness();
    tracker.afterDispatch(live("Hi"));
    tracker.rendered([render("Hi", ["a", "b"], ["a"])], NOT_FOUND, true);
    tracker.afterDispatch(idle([{ turnKey: "t-other" }]));
    expect(tracker.track(KEY)).toBeUndefined();
    expect(clock.armed).toBe(0);
    const before = posts.length;
    clock.advance(RENDER_RESYNC_MAX_MS * 4);
    expect(posts).toHaveLength(before);
  });

  test("close disarms every wait and takes no more renders", () => {
    const { clock, tracker, posts, asks } = harness();
    tracker.afterDispatch(live("Hi"));
    tracker.afterDispatch(live("x", "msg-2-b1"));
    tracker.rendered([render("x", ["a", "b"], ["a"], "msg-2-b1")], NOT_FOUND, true);
    tracker.close();
    expect(clock.armed).toBe(0);
    const before = { posts: posts.length, asks: asks.length };
    tracker.rendered([render("x", ["a"], ["a"], "msg-2-b1")], NOT_FOUND, true);
    clock.advance(RENDER_RESYNC_MAX_MS * 4);
    expect({ posts: posts.length, asks: asks.length }).toEqual(before);
  });
});
