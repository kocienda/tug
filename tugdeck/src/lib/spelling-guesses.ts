/**
 * spelling-guesses.ts — ask the system spell checker about one word.
 *
 * The Tug.app host answers `spellingGuesses` from `NSSpellChecker`, the same
 * checker and the same learned words every native text view consults, so
 * the guesses a context menu offers here are the ones TextEdit would offer
 * for the same word. The reply comes back as `onSpellingGuesses` under the
 * request's id, the request/response shape `clipboardRead` established.
 * Learn Spelling and Ignore Spelling go the other way with no reply:
 * `rememberSpelling` tells the same checker to stop flagging a word.
 *
 * A context menu waits on the answer before it opens, so the wait is
 * bounded: past {@link SPELLING_TIMEOUT_MS}, or outside the host (browser
 * dev, tests), the answer is `null` and the menu opens without a spelling
 * block rather than not at all.
 *
 * @module lib/spelling-guesses
 */

import { hostAvailable, onHostMessage, postToHost } from "@/host/channel";
import {
  rememberSpellingToHost,
  spellingGuessesToHost,
  spellingGuessesToPage,
} from "@/host/declarations/services";

/** What the checker said about a word. */
export interface SpellingGuesses {
  /** True when the checker flags the word as misspelled. */
  misspelled: boolean;
  /** Its guesses, best first; `[]` when it has none. */
  guesses: string[];
}

/**
 * The value a spelling correction row carries: the word the menu was opened
 * over, and the guess that replaces it. The word rides along so a handler
 * can refuse to act on a selection that has since moved off it.
 */
export interface SpellingCorrection {
  word: string;
  replacement: string;
}

/**
 * How long a menu waits for the checker. `NSSpellChecker` answers a single
 * word in well under a frame; the bound is for a host that never answers.
 */
export const SPELLING_TIMEOUT_MS = 150;

/** The most guesses a menu shows, as AppKit's own text views do. */
export const MAX_SPELLING_GUESSES = 5;

/** The longest word worth sending; anything longer is not a word. */
const MAX_WORD_LENGTH = 64;

const pending = new Map<string, (answer: SpellingGuesses) => void>();
let installed = false;
let nextId = 0;

/** Take `__tugBridge.onSpellingGuesses` in this page. Idempotent. */
function install(): void {
  if (installed) return;
  installed = true;
  onHostMessage(spellingGuessesToPage, ({ requestId, misspelled, guesses }) => {
    const resolve = pending.get(requestId);
    if (resolve === undefined) return;
    pending.delete(requestId);
    resolve({ misspelled, guesses });
  });
}

/**
 * The single word `text` names once its surrounding whitespace is set
 * aside, or `null` when it is blank, several words, or too long to be one.
 * A bare secondary click selects one word, and that is the only selection
 * a spelling block is about.
 */
export function spellableWord(text: string): string | null {
  const word = text.trim();
  if (word === "" || word.length > MAX_WORD_LENGTH) return null;
  if (/\s/.test(word)) return null;
  // A word has a letter in it; a number, a path separator run or a lone
  // punctuation mark has nothing to correct.
  if (!/\p{L}/u.test(word)) return null;
  return word;
}

/** True when `value` is a well-formed {@link SpellingCorrection}. */
export function isSpellingCorrection(value: unknown): value is SpellingCorrection {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.word === "string" &&
    typeof candidate.replacement === "string"
  );
}

/**
 * `text` with its non-whitespace core swapped for `correction.replacement`,
 * keeping whatever whitespace the selection carried around the word — a
 * word-select can reach past the word into the space beside it. `null` when
 * the core is not the word the menu was opened over.
 */
export function correctedText(
  text: string,
  correction: SpellingCorrection,
): string | null {
  const core = text.trim();
  if (core !== correction.word) return null;
  const lead = text.slice(0, text.length - text.trimStart().length);
  const trail = text.slice(text.trimEnd().length);
  return `${lead}${correction.replacement}${trail}`;
}

/**
 * Ask the host about `word`. Resolves `null` outside the host or when the
 * host does not answer within {@link SPELLING_TIMEOUT_MS}.
 */
export function requestSpellingGuesses(
  word: string,
): Promise<SpellingGuesses | null> {
  if (!hostAvailable(spellingGuessesToHost)) return Promise.resolve(null);
  install();
  const requestId = `tug-spell-${++nextId}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve(null);
    }, SPELLING_TIMEOUT_MS);
    pending.set(requestId, (answer) => {
      clearTimeout(timer);
      resolve({
        misspelled: answer.misspelled,
        guesses: answer.guesses.slice(0, MAX_SPELLING_GUESSES),
      });
    });
    postToHost(spellingGuessesToHost, { requestId, word });
  });
}

/**
 * Tell the system spell checker to stop flagging `word`: `learn` adds it to
 * the user's dictionary, shared with every app; `ignore` accepts it in Tug
 * until the app quits. Outside the host this is a no-op.
 */
export function rememberSpelling(word: string, kind: "learn" | "ignore"): void {
  const spelled = spellableWord(word);
  if (spelled === null || !hostAvailable(rememberSpellingToHost)) return;
  postToHost(rememberSpellingToHost, { word: spelled, kind });
}
