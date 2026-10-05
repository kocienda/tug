/**
 * real-transcript-fixture.ts — bind a deck's session cards to REAL resumed
 * transcripts, so a settle is read over the content a user's cards carry.
 *
 * ## Why
 *
 * The settle tests were read on unbound session cards: each showed its picker,
 * held no session, and had an empty transcript. A card with a transcript
 * reacts to its own height change — its list view pins to the bottom,
 * applies its restore target, rebases its extent floor, and CodeMirror runs
 * its measure cycle — and an empty transcript pays none of that. So a bar
 * read on an empty card says nothing about the card a user has.
 *
 * ## How a card is bound
 *
 * Through the production resume, one card at a time. A copy of the
 * transcript is seeded under a fresh UUID — two cards cannot resume one id,
 * and `claude --resume` refuses an id that is not a UUID — and
 * `app.spawnSessionResume` sends the genuine `spawn_session(mode=resume)`
 * frame. tugcast acks with `spawn_session_ok`, which binds the card, and
 * spawns a real tugcode `--resume`, whose replay is the translator a user's
 * resume runs. Nothing is synthesized. Each card waits for its binding — its
 * picker gone and its transcript mounted — before the next spawns, so eight
 * resumes never contend for one launch. The binding is read from the DOM the
 * binding produces rather than from the deck trace's `engine-ready` row,
 * which lives in a ring other events can evict.
 *
 * ## The two sizes
 *
 * - `slice`: the committed `session-transcript-basic` fixture. It runs
 *   everywhere, and is small.
 * - `whale`: the local corpus's selected whale snapshot (`whaleSnapshot`),
 *   gitignored and present only on a machine that ran
 *   `corpus/harvest.ts`. It rides the cards a gesture resizes or moves; the
 *   rest of the deck takes the slice, because a deck of eight whales
 *   is a deck no user has.
 *
 * Every card's element count is censused and noted, so a slow run can be
 * told from a broken one and a slice that understates a user's card is
 * visible as a number.
 *
 * Not a test: no `describe` here.
 */

import { randomUUID } from "node:crypto";

import { note, type App } from "./_harness";
import { loadManifest, seedSnapshot, type SelectedSnapshot } from "./corpus/resolve";
import { seedFixtureSession } from "./fixtures/resolve";

/** Which transcript a fixture's session cards carry. */
export type TranscriptSize = "slice" | "whale";

/** The committed fixture every slice card resumes. */
export const SLICE_FIXTURE = "session-transcript-basic";

/** The whale the harvest pins, preferred when the corpus holds it. */
export const PINNED_WHALE_PREFIX = "763cd1d8";

/** One arm a test runs on: which transcript, and whether this machine can. */
export interface TranscriptArm {
  readonly size: TranscriptSize;
  /** The whale arm skips on a machine with no harvested whale. */
  readonly skip: boolean;
}

/** How long the transcript's height must hold still to count as settled. */
const SETTLED_HEIGHT_HOLD_MS = 500;

/** A slice resumes in seconds; a whale's replay is minutes of translating. */
const BOUND_MS = { slice: 60_000, whale: 240_000 } as const;
const SETTLED_MS = { slice: 60_000, whale: 300_000 } as const;

/**
 * The corpus's selected whale, preferring the pinned id, or `null` when this
 * machine has no harvested corpus or the corpus holds no whale.
 */
export function whaleSnapshot(): SelectedSnapshot | null {
  const manifest = loadManifest();
  if (manifest === null) return null;
  const whales = manifest.selected.filter((s) => s.class === "whale");
  return (
    whales.find((s) => s.id.startsWith(PINNED_WHALE_PREFIX)) ?? whales[0] ?? null
  );
}

/**
 * The two arms a test runs on: the slice, which runs everywhere, and the
 * whale, which runs where `corpus/harvest.ts` has materialized one.
 */
export function transcriptArms(): readonly TranscriptArm[] {
  return [
    { size: "slice", skip: false },
    { size: "whale", skip: whaleSnapshot() === null },
  ];
}

/** One card bound to a resumed transcript. */
export interface BoundCard {
  readonly cardId: string;
  readonly size: TranscriptSize;
  readonly tugSessionId: string;
}

export interface BoundTranscripts {
  readonly cards: readonly BoundCard[];
  /** Remove every seeded copy and its temp project dir. */
  cleanup(): void;
}

/**
 * Resume a real transcript into each of `cardIds`, one card at a time.
 *
 * Under `size: "whale"`, the cards named in `whaleCards` resume the whale and
 * every other card the slice; with no whale on this machine it throws, since
 * a whale arm that quietly ran the slice would read as a whale reading.
 */
export async function bindRealTranscripts(
  app: App,
  cardIds: readonly string[],
  opts: { size: TranscriptSize; whaleCards?: readonly string[] },
): Promise<BoundTranscripts> {
  const whale = opts.size === "whale" ? whaleSnapshot() : null;
  if (opts.size === "whale" && whale === null) {
    throw new Error("bindRealTranscripts: a whale arm on a machine with no whale in the corpus");
  }
  const whaleCards = new Set(opts.whaleCards ?? []);
  const cleanups: (() => void)[] = [];
  const cards: BoundCard[] = [];
  try {
    for (const cardId of cardIds) {
      const size: TranscriptSize = whale !== null && whaleCards.has(cardId) ? "whale" : "slice";
      const tugSessionId = randomUUID();
      const label = `rt-${cardId}`;
      const seeded =
        size === "whale"
          ? await seedSnapshot(whale!, label, { sessionId: tugSessionId })
          : await seedFixtureSession(SLICE_FIXTURE, label, { sessionId: tugSessionId });
      cleanups.push(() => seeded.cleanup());
      await app.spawnSessionResume(cardId, {
        tugSessionId,
        projectDir: seeded.projectDir,
      });
      await app.waitForCondition<boolean>(
        `document.querySelector('[data-card-id="${cardId}"] [data-testid="session-card-transcript"]') !== null && ` +
          `document.querySelector('[data-card-id="${cardId}"] .session-card-picker-form') === null`,
        { timeoutMs: BOUND_MS[size] },
      );
      cards.push({ cardId, size, tugSessionId });
    }
  } catch (error) {
    for (const cleanup of cleanups) cleanup();
    throw error;
  }
  return {
    cards,
    cleanup() {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}

/**
 * Wait until every bound card's transcript has finished replaying and its
 * scroll height has held still for {@link SETTLED_HEIGHT_HOLD_MS}.
 *
 * The card-scoped form of `fixtures/runner.ts`'s `waitForTranscriptSettled`,
 * which reads card `A` alone. One wait per card, in order; the height each
 * card last showed is kept per card id, so two cards never read each other's.
 */
export async function awaitTranscriptsSettled(
  app: App,
  cards: readonly BoundCard[],
): Promise<void> {
  for (const { cardId, size } of cards) {
    const host = `[data-card-id="${cardId}"] [data-testid="session-card-transcript"]`;
    const scroller = `[data-card-id="${cardId}"] [data-tug-scroll-key="session-card-transcript"]`;
    await app.waitForCondition<boolean>(
      `(function(){
        var host = document.querySelector(${JSON.stringify(host)});
        if (host === null || host.hasAttribute("data-replaying")) return false;
        var el = document.querySelector(${JSON.stringify(scroller)});
        if (el === null) return false;
        if (el.scrollHeight <= el.clientHeight) return false;
        var now = performance.now();
        var seenAll = window.__tugTranscriptsSeen || (window.__tugTranscriptsSeen = {});
        var seen = seenAll[${JSON.stringify(cardId)}];
        if (seen === undefined || seen.el !== el || seen.height !== el.scrollHeight) {
          seenAll[${JSON.stringify(cardId)}] = { el: el, height: el.scrollHeight, at: now };
          return false;
        }
        return now - seen.at >= ${SETTLED_HEIGHT_HOLD_MS};
      })()`,
      { timeoutMs: SETTLED_MS[size] },
    );
  }
}

export interface TranscriptCensus {
  /** Elements under each bound card's root. */
  readonly cards: readonly {
    cardId: string;
    size: TranscriptSize;
    elements: number;
    /** A bound card must not still show its picker. */
    picker: boolean;
  }[];
  /** The whole document's element and stacking-context counts. */
  readonly document: { elements: number; stackingContexts: number };
}

/**
 * Count each bound card's elements, and the whole document's.
 *
 * A card's root is the nearest `[data-card-id]` above its transcript, so the
 * count is the card's content and not a tab or a badge that shares the id.
 */
export async function transcriptCensus(
  app: App,
  cards: readonly BoundCard[],
): Promise<TranscriptCensus> {
  const ids = cards.map((c) => c.cardId);
  const counts = await app.evalJS<{
    cards: Record<string, number>;
    pickers: Record<string, boolean>;
    elements: number;
    stackingContexts: number;
  }>(
    `(function(){
      var out = {};
      var pickers = {};
      ${JSON.stringify(ids)}.forEach(function (id) {
        var t = document.querySelector('[data-card-id="' + id + '"] [data-testid="session-card-transcript"]');
        var root = t === null ? null : t.closest('[data-card-id="' + id + '"]');
        out[id] = root === null ? 0 : root.querySelectorAll("*").length;
        pickers[id] = document.querySelector('[data-card-id="' + id + '"] .session-card-picker-form') !== null;
      });
      var layers = window.__tugMotion.layers();
      return { cards: out, pickers: pickers, elements: layers.elements, stackingContexts: layers.stackingContexts };
    })()`,
  );
  return {
    cards: cards.map((c) => ({
      cardId: c.cardId,
      size: c.size,
      elements: counts.cards[c.cardId] ?? 0,
      picker: counts.pickers[c.cardId] ?? false,
    })),
    document: { elements: counts.elements, stackingContexts: counts.stackingContexts },
  };
}

/**
 * Bind, settle and census in one call, noting the census under `label` —
 * what a fixture's `launch` runs once its deck stands.
 */
export async function bindAndSettle(
  app: App,
  cardIds: readonly string[],
  opts: { size: TranscriptSize; whaleCards?: readonly string[]; label: string },
): Promise<BoundTranscripts> {
  const bound = await bindRealTranscripts(app, cardIds, opts);
  try {
    await awaitTranscriptsSettled(app, bound.cards);
    const census = await transcriptCensus(app, bound.cards);
    note(
      `${opts.label} transcripts (${opts.size}): ` +
        census.cards
          .map((c) => `${c.cardId}=${c.size}:${c.elements}${c.picker ? " (PICKER)" : ""}`)
          .join(" ") +
        ` · document ${census.document.elements} elements, ` +
        `${census.document.stackingContexts} stacking contexts`,
    );
    const unbound = census.cards.filter((c) => c.picker || c.elements === 0);
    if (unbound.length > 0) {
      throw new Error(
        `${opts.label}: ${unbound.map((c) => c.cardId).join(", ")} still show a picker or no transcript after binding`,
      );
    }
  } catch (error) {
    bound.cleanup();
    throw error;
  }
  return bound;
}

/** The card the deck's active pane shows, or `null` on an empty deck. */
async function activeCardOf(app: App): Promise<string | null> {
  return app.evalJS<string | null>(
    `(function(){
      var deck = window.tugdeck.diag.getDeckState();
      var pane = deck.panes.find(function (p) { return p.id === deck.activePaneId; });
      return pane ? pane.activeCardId : null;
    })()`,
  );
}

/**
 * Bind a test's session cards for the life of its process — what a test that
 * seeds its own deck runs where it once called the synthetic
 * `app.bindSession`.
 *
 * A binding activates the card it binds, so the deck can end on the last card
 * bound. Every test was written against the deck as it stood before binding,
 * so the card focused then is focused again. The seeded copies are removed
 * when the test process exits, whichever way it ends.
 */
export async function bindForTest(
  app: App,
  cardIds: readonly string[],
  opts: { size: TranscriptSize; whaleCards?: readonly string[]; label: string },
): Promise<BoundTranscripts> {
  const before = await activeCardOf(app);
  const bound = await bindAndSettle(app, cardIds, opts);
  process.on("exit", () => bound.cleanup());
  if (before !== null && (await activeCardOf(app)) !== before) {
    await app.evalJS<null>(
      `(window.__tug.dispatchControlAction("focus-session-card", ` +
        `{ cardId: ${JSON.stringify(before)} }), null)`,
    );
    await app.waitForCondition<boolean>(
      `(function(){
        var deck = window.tugdeck.diag.getDeckState();
        var pane = deck.panes.find(function (p) { return p.id === deck.activePaneId; });
        return pane !== undefined && pane.activeCardId === ${JSON.stringify(before)};
      })()`,
      { timeoutMs: 8_000 },
    );
  }
  return bound;
}
