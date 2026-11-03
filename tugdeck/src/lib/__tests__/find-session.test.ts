/**
 * find-session.test — the shared find controller's engine-independent
 * semantics, exercised against a stub {@link FindEngineDelegate}: query /
 * option propagation, count publication, the ordinal-movement wrap
 * accounting that drives the shared wrap overlay identically for every
 * engine, and replace's capability gate and its own wrap rule.
 */

import { describe, expect, test } from "bun:test";
import {
  FindSession,
  type FindEngineDelegate,
  type FindMatchInfo,
} from "../find-session";
import type { FindOptions } from "../transcript-search";

/** A stub engine over a fixed match count with wrap-around navigation. */
function stubEngine(count: number) {
  let active: number | null = null;
  const calls: string[] = [];
  const engine: FindEngineDelegate & { setCount: (n: number) => void } = {
    searchDidChange: (query: string, _options: FindOptions) => {
      calls.push(`search:${query}`);
      active = count > 0 && query !== "" ? 0 : null;
    },
    findNext: () => {
      if (count === 0) return;
      active = active === null ? 0 : (active + 1) % count;
    },
    findPrevious: () => {
      if (count === 0) return;
      active = active === null ? 0 : (active - 1 + count) % count;
    },
    matchInfo: (): FindMatchInfo => ({
      count,
      activeOrdinal: active,
      capped: false,
    }),
    clear: () => {
      calls.push("clear");
      active = null;
    },
    setCount: (n: number) => {
      count = n;
    },
  };
  return { engine, calls };
}

describe("FindSession", () => {
  test("query propagates to the engine and publishes its count", () => {
    const { engine, calls } = stubEngine(3);
    const session = new FindSession();
    session.setDelegate(engine);
    session.setQuery("alpha");
    expect(calls).toEqual(["search:alpha"]);
    const snap = session.getSnapshot();
    expect(snap.count).toBe(3);
    expect(snap.activeOrdinal).toBe(0);
    expect(snap.hasQuery).toBe(true);
  });

  test("setDelegate replays a standing query into a SYNCHRONOUS late-attaching engine", () => {
    // The stub resolves `matchInfo` synchronously, so the count lands on the
    // `refresh()` inside `setDelegate`. This is the CM6 `documentFindEngine`
    // shape (its search is synchronous); the debounced transcript engine is
    // covered by the async test below.
    const { engine, calls } = stubEngine(2);
    const session = new FindSession();
    session.setQuery("beta");
    expect(session.getSnapshot().count).toBe(0);
    session.setDelegate(engine);
    expect(calls).toEqual(["search:beta"]);
    expect(session.getSnapshot().count).toBe(2);
  });

  test("setDelegate replays a standing query into an ASYNC (debounced) engine", () => {
    // Faithful model of `TranscriptFindEngine`: `searchDidChange` only
    // SCHEDULES; `matchInfo` reads 0 until the debounce settles, at which
    // point the engine calls `session.refresh()` itself. So the synchronous
    // `refresh()` inside `setDelegate` must NOT invent a count — it publishes
    // 0 — and the real count only lands when the engine settles.
    let sessionRef: FindSession | null = null;
    let settledCount = 0;
    const asyncEngine: FindEngineDelegate & { settle: (n: number) => void } = {
      didAttach: (s) => {
        sessionRef = s;
      },
      searchDidChange: () => {
        // Debounced: no result yet.
      },
      matchInfo: (): FindMatchInfo => ({
        count: settledCount,
        activeOrdinal: settledCount > 0 ? 0 : null,
        capped: false,
      }),
      settle: (n: number) => {
        settledCount = n;
        sessionRef?.refresh();
      },
    };
    const session = new FindSession();
    session.setQuery("beta");
    session.setDelegate(asyncEngine);
    // Synchronous replay: the debounce has not fired, so the count is still 0.
    expect(session.getSnapshot().count).toBe(0);
    // The debounce settles and re-publishes via `refresh()`.
    asyncEngine.settle(2);
    expect(session.getSnapshot().count).toBe(2);
    expect(session.getSnapshot().activeOrdinal).toBe(0);
  });

  test("options changes re-search and fire the persistence hook", () => {
    const { engine } = stubEngine(1);
    const persisted: FindOptions[] = [];
    const session = new FindSession(undefined, {
      onOptionsChanged: (o) => persisted.push(o),
    });
    session.setDelegate(engine);
    session.setQuery("q");
    session.setOptions({ caseSensitive: true, wholeWord: false, grep: false });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.caseSensitive).toBe(true);
  });

  test("forward wrap: advancing past the last match bumps wrapSeq with direction 1", () => {
    const { engine } = stubEngine(2);
    const session = new FindSession();
    session.setDelegate(engine);
    session.setQuery("q"); // active 0
    session.next(); // 0 → 1, no wrap
    expect(session.getSnapshot().wrapped).toBe(false);
    expect(session.getSnapshot().wrapSeq).toBe(0);
    session.next(); // 1 → 0, wrap
    const snap = session.getSnapshot();
    expect(snap.wrapped).toBe(true);
    expect(snap.wrapDirection).toBe(1);
    expect(snap.wrapSeq).toBe(1);
  });

  test("backward wrap: retreating past the first match bumps wrapSeq with direction -1", () => {
    const { engine } = stubEngine(3);
    const session = new FindSession();
    session.setDelegate(engine);
    session.setQuery("q"); // active 0
    session.previous(); // 0 → 2, wrap
    const snap = session.getSnapshot();
    expect(snap.wrapped).toBe(true);
    expect(snap.wrapDirection).toBe(-1);
    expect(snap.wrapSeq).toBe(1);
  });

  test("a one-match set wraps on every navigation (consecutive wraps keep counting)", () => {
    const { engine } = stubEngine(1);
    const session = new FindSession();
    session.setDelegate(engine);
    session.setQuery("q");
    session.next();
    session.next();
    expect(session.getSnapshot().wrapSeq).toBe(2);
    expect(session.getSnapshot().wrapDirection).toBe(1);
  });

  test("query edits clear the transient wrap flag but never wrapSeq", () => {
    const { engine } = stubEngine(2);
    const session = new FindSession();
    session.setDelegate(engine);
    session.setQuery("q");
    session.next();
    session.next(); // wrap
    expect(session.getSnapshot().wrapSeq).toBe(1);
    session.setQuery("qr");
    const snap = session.getSnapshot();
    expect(snap.wrapped).toBe(false);
    expect(snap.wrapDirection).toBe(0);
    expect(snap.wrapSeq).toBe(1);
  });

  test("clear tears down the engine search and zeroes the published face", () => {
    const { engine, calls } = stubEngine(2);
    const session = new FindSession();
    session.setDelegate(engine);
    session.setQuery("q");
    session.clear();
    expect(calls).toContain("clear");
    const snap = session.getSnapshot();
    expect(snap.count).toBe(0);
    expect(snap.hasQuery).toBe(false);
    expect(snap.query).toBe("");
  });

  test("refresh preserves wrap state while re-reading the engine (async settle)", () => {
    const { engine } = stubEngine(2);
    const session = new FindSession();
    session.setDelegate(engine);
    session.setQuery("q");
    session.next();
    session.next(); // wrap; wrapSeq 1
    engine.setCount(5);
    session.refresh();
    const snap = session.getSnapshot();
    expect(snap.count).toBe(5);
    expect(snap.wrapSeq).toBe(1);
  });
});

/**
 * The failed-reveal flag ([P09]). It is the one piece of the published face
 * the ENGINE does not own: the host says whether it could put the active
 * match on screen, and every gesture takes the claim back, because a stale
 * "not in view" over a match the user has since stepped to is exactly the
 * confident-but-wrong chip this arc exists to retire.
 */
describe("FindSession reveal-failed flag", () => {
  const failed = (): FindSession => {
    const { engine } = stubEngine(3);
    const session = new FindSession();
    session.setDelegate(engine);
    session.setQuery("q");
    session.setRevealFailed(true);
    return session;
  };

  test("setRevealFailed publishes to subscribers", () => {
    const { engine } = stubEngine(3);
    const session = new FindSession();
    session.setDelegate(engine);
    session.setQuery("q");
    let notifications = 0;
    session.subscribe(() => {
      notifications += 1;
    });
    expect(session.getSnapshot().revealFailed).toBe(false);
    session.setRevealFailed(true);
    expect(session.getSnapshot().revealFailed).toBe(true);
    expect(notifications).toBe(1);
    // Idempotent: a reveal that fails twice does not re-publish.
    session.setRevealFailed(true);
    expect(notifications).toBe(1);
    session.setRevealFailed(false);
    expect(session.getSnapshot().revealFailed).toBe(false);
    expect(notifications).toBe(2);
  });

  test("every gesture resets it", () => {
    const query = failed();
    query.setQuery("qq");
    expect(query.getSnapshot().revealFailed).toBe(false);

    const options = failed();
    options.setOptions({ caseSensitive: true, wholeWord: false, grep: false });
    expect(options.getSnapshot().revealFailed).toBe(false);

    const next = failed();
    next.next();
    expect(next.getSnapshot().revealFailed).toBe(false);

    const previous = failed();
    previous.previous();
    expect(previous.getSnapshot().revealFailed).toBe(false);

    const cleared = failed();
    cleared.clear();
    expect(cleared.getSnapshot().revealFailed).toBe(false);

    // The sixth gesture: a surface taking the session over replays the
    // standing query into the new engine, which owes its own reveal.
    const replayed = failed();
    replayed.setDelegate(stubEngine(3).engine);
    expect(replayed.getSnapshot().revealFailed).toBe(false);
  });

  test("a background refresh does NOT reset it", () => {
    const session = failed();
    // A streaming transcript re-projecting is not the user asking again:
    // the match is still off screen and the chip must keep saying so.
    session.refresh();
    expect(session.getSnapshot().revealFailed).toBe(true);
  });
});

/**
 * A stub writable engine over `count` matches. Replacing the active match
 * removes it, so the match after it takes its ordinal — the shape that makes
 * replace need a wrap rule of its own. The last match's replacement hands the
 * active slot to the first.
 */
function replaceEngine(count: number) {
  let active: number | null = null;
  let writable = true;
  const replaced: string[] = [];
  const engine: FindEngineDelegate & { setWritable: (w: boolean) => void } = {
    searchDidChange: (query: string) => {
      active = count > 0 && query !== "" ? 0 : null;
    },
    findNext: () => {
      if (count === 0) return;
      active = active === null ? 0 : (active + 1) % count;
    },
    matchInfo: (): FindMatchInfo => ({ count, activeOrdinal: active, capped: false }),
    replaceNext: (replacement: string) => {
      replaced.push(replacement);
      if (count === 0) return;
      if (active === null) {
        active = 0;
        return;
      }
      count -= 1;
      active = count === 0 ? null : active % count;
    },
    replaceAll: (replacement: string) => {
      replaced.push(`all:${replacement}`);
      count = 0;
    },
    isWritable: () => writable,
    setWritable: (w: boolean) => {
      writable = w;
    },
  };
  return { engine, replaced };
}

describe("FindSession replace", () => {
  test("canReplace follows the engine's capability and writability", () => {
    const readOnlySurface = new FindSession();
    readOnlySurface.setDelegate(stubEngine(3).engine);
    expect(readOnlySurface.getSnapshot().canReplace).toBe(false);

    const { engine } = replaceEngine(3);
    const session = new FindSession();
    let notifications = 0;
    session.subscribe(() => {
      notifications += 1;
    });
    session.setDelegate(engine);
    expect(session.getSnapshot().canReplace).toBe(true);
    expect(notifications).toBe(1);

    // Read-only is pushed state: the host refreshes and the bit follows.
    engine.setWritable(false);
    session.refresh();
    expect(session.getSnapshot().canReplace).toBe(false);

    session.setDelegate(null);
    expect(session.getSnapshot().canReplace).toBe(false);
  });

  test("replace is a no-op when the engine cannot replace", () => {
    const { engine, replaced } = replaceEngine(3);
    engine.setWritable(false);
    const session = new FindSession();
    session.setDelegate(engine);
    session.setQuery("q");
    session.replaceNext();
    session.replaceAll();
    expect(replaced).toEqual([]);
    expect(session.getSnapshot().count).toBe(3);
  });

  test("replace is a no-op with no query", () => {
    const { engine, replaced } = replaceEngine(3);
    const session = new FindSession();
    session.setDelegate(engine);
    session.replaceNext();
    expect(replaced).toEqual([]);
  });

  test("replacing a middle match does not read as a wrap", () => {
    const { engine } = replaceEngine(3);
    const session = new FindSession();
    session.setDelegate(engine);
    session.setQuery("q");
    session.next();
    expect(session.getSnapshot().activeOrdinal).toBe(1);
    const wrapSeq = session.getSnapshot().wrapSeq;
    // The following match inherits ordinal 1. `next()`'s rule would call
    // that a wrap; replace's does not.
    session.replaceNext();
    const snap = session.getSnapshot();
    expect(snap.count).toBe(2);
    expect(snap.activeOrdinal).toBe(1);
    expect(snap.wrapped).toBe(false);
    expect(snap.wrapSeq).toBe(wrapSeq);
  });

  test("replacing the last match wraps to the first", () => {
    const { engine } = replaceEngine(3);
    const session = new FindSession();
    session.setDelegate(engine);
    session.setQuery("q");
    session.next();
    session.next();
    expect(session.getSnapshot().activeOrdinal).toBe(2);
    const wrapSeq = session.getSnapshot().wrapSeq;
    session.replaceNext();
    const snap = session.getSnapshot();
    expect(snap.activeOrdinal).toBe(0);
    expect(snap.wrapped).toBe(true);
    expect(snap.wrapDirection).toBe(1);
    expect(snap.wrapSeq).toBe(wrapSeq + 1);
  });

  test("replacing the only match leaves no results and no wrap", () => {
    const { engine } = replaceEngine(1);
    const session = new FindSession();
    session.setDelegate(engine);
    session.setQuery("q");
    session.replaceNext();
    const snap = session.getSnapshot();
    expect(snap.count).toBe(0);
    expect(snap.activeOrdinal).toBe(null);
    expect(snap.wrapped).toBe(false);
    expect(snap.hasQuery).toBe(true);
  });

  test("replace all clears the active match and republishes the count", () => {
    const { engine, replaced } = replaceEngine(4);
    const session = new FindSession();
    session.setDelegate(engine);
    session.setQuery("q");
    session.setReplacement("r");
    session.replaceAll();
    const snap = session.getSnapshot();
    expect(replaced).toEqual(["all:r"]);
    expect(snap.count).toBe(0);
    expect(snap.activeOrdinal).toBe(null);
    expect(snap.wrapped).toBe(false);
  });

  test("the replacement seeds, reaches the engine, and persists through the hook", () => {
    const { engine, replaced } = replaceEngine(2);
    const persisted: string[] = [];
    const session = new FindSession(
      undefined,
      { onReplacementChanged: (r) => persisted.push(r) },
      "seed",
    );
    session.setDelegate(engine);
    session.setQuery("q");
    expect(session.getSnapshot().replacement).toBe("seed");
    session.replaceNext();
    session.setReplacement("next");
    session.setReplacement("next");
    session.replaceNext();
    expect(replaced).toEqual(["seed", "next"]);
    expect(persisted).toEqual(["next"]);
  });
});
