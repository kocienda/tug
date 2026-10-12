/**
 * streaming-stub-fixture.ts — session cards that stream at a token cadence,
 * through the real feed, without a `claude` turn.
 *
 * ## Why
 *
 * The judder users report happens with three or four sessions streaming, and
 * every motion reading before this one was taken on a deck where nothing
 * was. A streaming reading needs a deck whose streams are controlled: the
 * same cadence, the same text, every run.
 *
 * ## How a card streams
 *
 * tugcast spawns every session's tugcode itself, so a test cannot hand it
 * `--stub-transcript`. Instead the app is launched with
 * `TUGCODE_STUB_TRANSCRIPT_DIR` pointing at a directory this fixture owns
 * ({@link stubDirectory}), and for each card the fixture writes
 * `<dir>/<session id>.json` — a paced transcript — before sending the real
 * `spawn_session(mode=new)` frame. The tugcode tugcast spawns for that
 * session finds its transcript and replays it (`tugcode/src/stub-replay.ts`);
 * every other session on the deck runs as it always does. A prompt sent into
 * the card then streams the transcript's one long turn through tugcast's
 * `CODE_OUTPUT` feed, the WebSocket, the session store and the markdown
 * block — the path a live turn takes, from tugcode on.
 *
 * ## The cadence
 *
 * One delta per {@link STREAM_PACE_MS} ms, a word or two each: 40 deltas a
 * second per session, the order the one streaming reading on record saw
 * (`briefs/real-transcript-motion-readings.md`, The streaming floor: 41
 * updates/s with one session mid-turn). The text is markdown of the shape
 * an assistant writes — headings, prose, lists, inline code and a fenced
 * block — in messages of a bounded length, so a streaming block's parse
 * costs what a real one does rather than growing without end.
 *
 * Not a test: no `describe` here.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TUGCODE_TRANSCRIPT_SCHEMA_VERSION, type App, type TugcodeTranscript } from "./_harness";
import { onTestRunEnd } from "./_harness/test-cleanup";

/** The variable tugcode reads (`STUB_TRANSCRIPT_DIR_ENV` in `stub-replay.ts`). */
export const STUB_TRANSCRIPT_DIR_ENV = "TUGCODE_STUB_TRANSCRIPT_DIR";

/** Milliseconds between one streamed delta and the next. */
export const STREAM_PACE_MS = 25;

/** The IPC version every outbound frame carries (`tugproto/src/outbound.ts`). */
const IPC_VERSION = 2;

/** How long a binding may take: a stub session has nothing to replay. */
const BOUND_MS = 30_000;

/** How long a sent prompt may take to start streaming. */
const STREAMING_MS = 15_000;

/** One card bound to a stubbed session. */
export interface StubCard {
  readonly cardId: string;
  readonly tugSessionId: string;
}

/**
 * A directory for this launch's stub transcripts, removed when the run ends.
 * Pass it to the app as `env[STUB_TRANSCRIPT_DIR_ENV]`; tugcode looks there
 * for every session it is spawned for.
 */
export function stubDirectory(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tug-stub-transcripts-")));
  onTestRunEnd(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** One assistant message's markdown, varied by its index. */
function messageText(index: number): string {
  const n = index + 1;
  return [
    `## Pass ${n}: what the reader found`,
    "",
    `The reader walked the module from its entry point and found that pass ${n} ` +
      "holds the state it needs for exactly one frame, then hands it back. " +
      "Nothing it keeps outlives the frame, which is what lets the caller " +
      "retry the whole pass without unwinding anything first.",
    "",
    "- The first branch reads the cached value and returns early when it is fresh.",
    `- The second branch recomputes it, writes \`cache.entries[${n}]\`, and marks the row dirty.`,
    "- The third branch is the fallback, and it has never been reached in the recorded runs.",
    "",
    "```ts",
    `function pass${n}(state: State): Result {`,
    "  const cached = state.cache.get(state.key);",
    "  if (cached !== undefined && !cached.stale) return cached.value;",
    "  const value = recompute(state);",
    "  state.cache.set(state.key, { value, stale: false });",
    "  return value;",
    "}",
    "```",
    "",
    `So the change for pass ${n} is small: keep the early return, move the write ` +
      "behind the comparison, and let the fallback stand until a run reaches it.",
    "",
  ].join("\n");
}

/** A message's text as the deltas a model would stream it in: a word apiece. */
function deltasOf(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [text];
}

/**
 * A transcript of one long turn, `messages` assistant messages long, paced at
 * {@link STREAM_PACE_MS}. At the default length a turn streams for several
 * minutes — longer than a reading takes — so the streams are still running
 * when the last drive is made.
 */
export function streamingTranscript(messages = 40): TugcodeTranscript {
  const outputs: unknown[] = [];
  let seq = 0;
  let lastMsgId = "";
  for (let m = 0; m < messages; m++) {
    const msgId = `stub-msg-${m}`;
    const text = messageText(m);
    outputs.push({
      type: "content_block_start",
      msg_id: msgId,
      block_index: 0,
      kind: "text",
      ipc_version: IPC_VERSION,
    });
    let rev = 0;
    for (const delta of deltasOf(text)) {
      outputs.push({
        type: "assistant_text",
        msg_id: msgId,
        block_index: 0,
        seq,
        rev: rev++,
        text: delta,
        is_partial: true,
        status: "partial",
        ipc_version: IPC_VERSION,
      });
    }
    outputs.push({
      type: "assistant_text",
      msg_id: msgId,
      block_index: 0,
      seq,
      rev,
      text,
      is_partial: false,
      status: "complete",
      ipc_version: IPC_VERSION,
    });
    seq++;
    lastMsgId = msgId;
  }
  outputs.push({
    type: "turn_complete",
    msg_id: lastMsgId,
    seq,
    result: "success",
    ipc_version: IPC_VERSION,
  });
  return {
    schemaVersion: TUGCODE_TRANSCRIPT_SCHEMA_VERSION,
    tugcodeVersion: "stub",
    paceMs: STREAM_PACE_MS,
    turns: [{ index: 0, description: "a long streamed turn", outputs }],
  };
}

/**
 * Bind each of `cardIds` to a fresh session whose tugcode replays
 * {@link streamingTranscript}, one card at a time, each waiting for its
 * binding — its picker gone and its transcript mounted.
 */
export async function bindStreamingStubs(
  app: App,
  cardIds: readonly string[],
  stubDir: string,
): Promise<StubCard[]> {
  const transcript = JSON.stringify(streamingTranscript());
  const cards: StubCard[] = [];
  for (const cardId of cardIds) {
    const tugSessionId = randomUUID();
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), `tug-stub-project-${cardId}-`)));
    onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
    writeFileSync(join(stubDir, `${tugSessionId}.json`), transcript);
    await app.spawnSessionNew(cardId, { tugSessionId, projectDir });
    await withState(app, cardId, `binding ${cardId} to stub session ${tugSessionId}`, () =>
      app.waitForCondition<boolean>(
        `document.querySelector('[data-card-id="${cardId}"] [data-testid="session-card-transcript"]') !== null && ` +
          `document.querySelector('[data-card-id="${cardId}"] .session-card-picker-form') === null`,
        { timeoutMs: BOUND_MS },
      ),
    );
    cards.push({ cardId, tugSessionId });
  }
  return cards;
}

/**
 * Send a prompt into each stub card and wait until every one is streaming
 * text, read off its prompt entry's `data-phase` — the same reading the
 * settle verb's `--streaming` check takes.
 */
export async function startStreams(app: App, cards: readonly StubCard[]): Promise<void> {
  for (const { cardId } of cards) {
    await app.driveSession(cardId, { op: "send", text: "Walk the module and report each pass." });
  }
  for (const { cardId } of cards) {
    await withState(app, cardId, `waiting for ${cardId} to stream`, () =>
      app.waitForCondition<boolean>(
        `(function(){
          var entry = document.querySelector('[data-card-id="${cardId}"] [data-slot="tug-prompt-entry"]');
          return entry !== null && entry.getAttribute("data-phase") === "streaming";
        })()`,
        { timeoutMs: STREAMING_MS },
      ),
    );
  }
}

/**
 * Run a wait, and when it fails, fail with what the card shows: its picker,
 * its transcript, its prompt entry's phase and error, and its first text.
 */
async function withState(app: App, cardId: string, what: string, wait: () => Promise<unknown>): Promise<void> {
  try {
    await wait();
  } catch (error) {
    const state = await app
      .evalJS<unknown>(
        `(function(){
          var card = '[data-card-id="${cardId}"]';
          var entry = document.querySelector(card + ' [data-slot="tug-prompt-entry"]');
          return {
            picker: document.querySelector(card + ' .session-card-picker-form') !== null,
            transcript: document.querySelector(card + ' [data-testid="session-card-transcript"]') !== null,
            phase: entry ? entry.getAttribute("data-phase") : null,
            errored: entry ? entry.hasAttribute("data-errored") : null,
            text: (document.querySelector(card) || { textContent: "" }).textContent.slice(0, 400),
          };
        })()`,
      )
      .catch((e: unknown) => `state unreadable: ${String(e)}`);
    throw new Error(`${what}: ${String(error)} — card state ${JSON.stringify(state)}`);
  }
}
