/**
 * atom-mention-marker — wire-text marker syntax for non-image atom
 * mentions.
 *
 * ## Why this exists
 *
 * Non-image atoms (file paths, doc references, URLs, commands the
 * user inserted via `@`-completion in the editor) are flattened
 * into a `text` content block at submit time per [Spec S03] /
 * [D01]. The substrate `U+FFFC` placeholder doesn't survive — the
 * model sees real text, not a placeholder.
 *
 * The original choice was to substitute the atom's bare `value`
 * (`"ga.txt"`) into the text. That made the prompt read naturally
 * to the model but lost the atom's structural identity: the JSONL
 * has no way to know "this token was a mention." On replay the
 * transcript shows `ga.txt` as plain prose, not a chip — visible
 * regression vs. what the user typed.
 *
 * The current marker wraps the value in backticks with a leading
 * `@`: `` `@ga.txt` ``. Two properties matter:
 *
 *   1. **Round-trippable.** The marker survives in JSONL verbatim
 *      and can be parsed back to recover atom positions and
 *      values. On replay the substrate synthesis re-mints chips at
 *      the original positions.
 *   2. **Model-friendly.** Backticked tokens are how Claude already
 *      reads "code-like reference" in prompts; the `@` prefix adds
 *      "user-mentioned this." The combination is unambiguous to the
 *      model and matches conventions in Markdown / `@`-mention UX
 *      elsewhere.
 *
 * Markdown's code-span syntax doesn't disambiguate against literal
 * backticks in user prose either — a user who types
 * `` `@foo` `` in their text literally would get a chip on replay
 * even if no atom was inserted. Acceptable false positive (visible
 * regression, never data loss); raising the bar with escape
 * sequences would complicate the model's reading.
 *
 * ## The typed marker
 *
 * One kind carries its type on the wire: a session, as
 * `` `@session:<project>/<callsign>` ``. Every other kind is recovered on
 * replay from the shape of its own value — a trailing `/` is a directory, a
 * run of sha-shaped hex is a commit — and a session has no such shape:
 * `<project>/<callsign>` is spelled exactly like a relative file path. The
 * discriminator used to be the tag store, which made replay depend on what
 * THIS client happened to have seen, so the same JSONL read back on a
 * different instance gave a file chip where the user had put a session. The
 * prefix moves that fact onto the wire, where the JSONL already keeps
 * everything else a replay needs.
 *
 * The grammar is therefore:
 *
 * ```text
 * marker  := "`@" [ type ":" ] value "`"
 * type    := "session"
 * value   := one-or-more non-backtick characters
 * ```
 *
 * A parsed mention reports the type it found in {@link AtomMentionSegment}'s
 * `atomType`, with the prefix stripped from `value`, so a reader gets the
 * same value either way. An untyped marker is untouched and still parses:
 * every marker written before this prefix existed reads back exactly as it
 * did, and a prefix Tug does not know is part of the value rather than an
 * error — an unknown type is a file chip, which is the fallback the module
 * has always taken.
 *
 * ## Backtick-in-value fallback
 *
 * If an atom's `value` contains a backtick (rare — file paths,
 * URLs, commands don't normally have them), the wrap would produce
 * a broken marker. {@link wrapAtomMention} falls back to
 * plain-text substitution in that case — the round-trip is lossy
 * for that one atom, matching the original pre-marker behaviour.
 *
 * @module lib/atom-mention-marker
 */


// ---------------------------------------------------------------------------
// Marker bracketing
// ---------------------------------------------------------------------------

/**
 * Marker prefix used inside the backticks. The `@` is the
 * convention-borne signal "the user mentioned this" — matches the
 * editor's `@`-completion UX even though the literal `@` character
 * never lives in the substrate.
 */
const MENTION_PREFIX = "@";

/**
 * Wrap a non-image atom's `value` as a backtick-`@` mention marker
 * for submit-time text substitution. Pure — no module state, no
 * DOM access.
 *
 * Returns the bare value (no marker) when the value contains a
 * backtick — the marker syntax can't escape backticks, and a value
 * containing one would produce a broken span that fails to parse on
 * replay. Falling back to plain substitution preserves the original
 * pre-marker behaviour for that one atom: lossy round-trip (no chip
 * on replay) but no data loss in the model's reading.
 */
export function wrapAtomMention(value: string): string {
  if (value.includes("`")) return value;
  return "`" + MENTION_PREFIX + value + "`";
}

/** The one atom type the marker names on the wire. */
const SESSION_MARKER_TYPE = "session";

/** The `type:` separator inside a marker. */
const MARKER_TYPE_SEP = ":";

/**
 * Wrap a session atom's `value` as a TYPED mention marker —
 * `` `@session:<project>/<callsign>` ``.
 *
 * The same backtick fallback as {@link wrapAtomMention}, for the same reason:
 * a value carrying a backtick cannot be bracketed by them, and the lossy
 * round trip is better than a span that fails to parse. A session value is
 * a project leaf and a callsign, neither of which can hold one, so the
 * fallback is defensive rather than expected.
 */
export function wrapSessionMention(value: string): string {
  if (value.includes("`")) return value;
  return "`" + MENTION_PREFIX + SESSION_MARKER_TYPE + MARKER_TYPE_SEP + value + "`";
}

// ---------------------------------------------------------------------------
// Marker parsing
// ---------------------------------------------------------------------------

/**
 * One segment in the parsed output of {@link parseAtomMentionSegments}.
 * Either a plain-text run or an atom-mention span. The synthesizer
 * walks segments in order, appending text to its buffer and inserting
 * a `U+FFFC` + atom for each mention.
 */
export type AtomMentionSegment =
  | { kind: "text"; text: string }
  | {
      kind: "mention";
      value: string;
      /**
       * The type the marker named, where it named one. Present only for
       * `` `@session:…` ``; `value` has the prefix stripped, so a reader that
       * ignores this field still sees the same value an untyped marker
       * carries. Absent means the wire said nothing, and the synthesizer
       * recovers the type from the value's own shape as it always has.
       */
      atomType?: "session";
    };

/**
 * Regex matching one mention span. The opening sequence is
 * backtick + `@`; the value is one-or-more non-backtick characters
 * (matching markdown code-span's "anything up to the closing
 * backtick" rule); the closing is one backtick. Greedy `+` is fine
 * because `[^`]+` can never cross a backtick.
 *
 * Global so {@link parseAtomMentionSegments} can iterate all matches
 * in one walk via `exec`.
 */
const MENTION_SPAN_RE = /`@([^`]+)`/g;

/**
 * Parse a wire text block into alternating text + mention segments.
 * Used by the substrate synthesizer ([Step 5c](arc/dev-atoms.md#step-5c))
 * to recover atom positions from a JSONL-honest wire text.
 *
 * Empty input returns an empty array. Text with no marker matches
 * returns a single text segment. The output preserves the input's
 * character order exactly — concatenating all segments' text +
 * marker reconstructs the original text.
 *
 * Pure — no module state, no DOM.
 */
export function parseAtomMentionSegments(text: string): AtomMentionSegment[] {
  if (text.length === 0) return [];
  const segments: AtomMentionSegment[] = [];
  let lastEnd = 0;
  // Fresh regex per call so `lastIndex` doesn't leak across invocations.
  const re = new RegExp(MENTION_SPAN_RE.source, MENTION_SPAN_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastEnd) {
      segments.push({ kind: "text", text: text.slice(lastEnd, match.index) });
    }
    const inner = match[1];
    const typed = inner.startsWith(SESSION_MARKER_TYPE + MARKER_TYPE_SEP);
    segments.push(
      typed
        ? {
            kind: "mention",
            value: inner.slice(SESSION_MARKER_TYPE.length + MARKER_TYPE_SEP.length),
            atomType: SESSION_MARKER_TYPE,
          }
        : { kind: "mention", value: inner },
    );
    lastEnd = match.index + match[0].length;
  }
  if (lastEnd < text.length) {
    segments.push({ kind: "text", text: text.slice(lastEnd) });
  }
  return segments;
}

