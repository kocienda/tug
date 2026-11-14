/**
 * chord-format.ts — the only place either key alphabet is spelled.
 *
 * Tug spells a chord as a US-layout `KeyboardEvent.code` name plus the exact
 * state of the four modifier flags ([P09]), and matches an event against it
 * by the event's *effective* code ({@link effectiveCode}): a letter chord
 * names the key that types that letter on the user's layout, and every other
 * chord names a physical key. AppKit identifies a chord by an `NSMenuItem`
 * key-equivalent *character* plus a modifier mask. They are different
 * alphabets — `"ArrowUp"` is `NSUpArrowFunctionKey`, `"Escape"` is `\u{1b}`,
 * and shifted punctuation is genuinely ambiguous — and every place that
 * spells one of them by hand is a place the two can drift apart.
 *
 * So all four jobs live here: the lookup identity a chord index is keyed by,
 * the match rule the key pipeline runs, the conversion the host consumes, and
 * the display string every surface renders. A chord that reads one way in the
 * menu bar, another in the keymap pane, and fires on a third is the failure
 * this module exists to make impossible.
 */

import type { Chord } from "./command-registry";

/* ---------------------------------------------------------------------------
 * Identity and matching
 * ------------------------------------------------------------------------- */

/**
 * A chord's lookup identity: its key name plus all four modifier flags, in a
 * fixed order. This is the key an O(1) chord index is built on, and it is
 * exactly the identity {@link chordMatchesEvent} tests pairwise — one
 * definition, so an index lookup and a scan can never disagree.
 */
export function chordKey(chord: Chord): string {
  return `${chord.key}|${chord.ctrl === true ? 1 : 0}${chord.meta === true ? 1 : 0}${
    chord.shift === true ? 1 : 0
  }${chord.alt === true ? 1 : 0}`;
}

/**
 * The code an event is matched by: the key that types a letter on the user's
 * layout for a letter or a punctuation character, the physical key for a digit
 * and for everything else.
 *
 * The layout is read from the event's legacy `keyCode`, which WebKit resolves
 * per event against the current input source: from the typed character first,
 * then the character without modifiers, then the physical key. So A–Z arrive
 * as 65–90 on the key that types them on AZERTY, QWERTZ and Dvorak, on the
 * QWERTY position while ⌘ is held on "Dvorak – QWERTY ⌘" (alone, with ⌥ or
 * with ⇧ — with ⌃ that layout types Dvorak again), and on the US position on
 * a layout with no Roman letters, which is where a Russian keyboard's user
 * expects ⌘C. Neither `code` nor `key` can say this: `code` is the position
 * alone, and `key` is the composed character once ⌥ is held (⌥C arrives as
 * "ç").
 *
 * Punctuation follows the character too, where the character confirms it.
 * WebKit gives a punctuation key the `keyCode` of the US key that carries its
 * character, shifted or not — AZERTY's key labelled "-" reports 189, the US
 * Minus key — and AppKit's localized menu fires the punctuation chord on that
 * same key. Because the code is shared by both characters on a US key, it is
 * taken only when `key` is the one this chord's shift state types there
 * ("-" without ⇧, "_" with it), or when ⌥ is held and `key` is composed;
 * otherwise the key stays positional. Without that check AZERTY's "<" key,
 * which reports the US comma key's 188, would answer to ⌘,.
 *
 * Digits stay positional. A digit chord fires on the number-row key whatever
 * the layout types there unshifted, since some layouts reach a digit only
 * through Shift — AZERTY's 4 key types "'" and reports 222, and ⌘4 must still
 * be ⌘4.
 *
 * An absent or zero `keyCode` — an event synthesized without one — falls
 * back to `code`.
 */
export function effectiveCode(
  event: Pick<KeyboardEvent, "code" | "keyCode"> & Partial<Pick<KeyboardEvent, "key" | "shiftKey" | "altKey">>,
): string {
  const keyCode = event.keyCode;
  if (keyCode >= 65 && keyCode <= 90) return `Key${String.fromCharCode(keyCode)}`;
  if (event.code.startsWith("Digit")) return event.code;
  const punctuation = PUNCTUATION_KEY_CODES.get(keyCode);
  if (punctuation === undefined || punctuation === event.code) return event.code;
  const characters = SHIFTED_PAIRS.get(punctuation);
  const typed = event.shiftKey === true ? characters?.[1] : characters?.[0];
  if (event.altKey === true || (typed !== undefined && event.key === typed)) return punctuation;
  return event.code;
}

/**
 * The Windows virtual-key codes WebKit reports for the US punctuation keys,
 * by the `KeyboardEvent.code` of the key that carries each character.
 */
const PUNCTUATION_KEY_CODES: ReadonlyMap<number, string> = new Map([
  [186, "Semicolon"],
  [187, "Equal"],
  [188, "Comma"],
  [189, "Minus"],
  [190, "Period"],
  [191, "Slash"],
  [192, "Backquote"],
  [219, "BracketLeft"],
  [220, "Backslash"],
  [221, "BracketRight"],
  [222, "Quote"],
]);

/** The same identity, read off a live event. */
export function eventChordKey(event: ChordEventFields): string {
  return `${effectiveCode(event)}|${event.ctrlKey ? 1 : 0}${event.metaKey ? 1 : 0}${
    event.shiftKey ? 1 : 0
  }${event.altKey ? 1 : 0}`;
}

/**
 * The fields chord matching reads off an event: the six it always reads, and
 * `key`, which confirms a punctuation key's character ({@link effectiveCode})
 * and is optional so an event that lacks it matches by position.
 *
 * Declared as a structural type rather than `KeyboardEvent` so one predicate
 * serves native listeners and React synthetic events alike — both satisfy it,
 * and a `KeyboardEvent` satisfies it too, so existing callers are unaffected.
 */
export type ChordEventFields = Pick<
  KeyboardEvent,
  "code" | "keyCode" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"
> &
  Partial<Pick<KeyboardEvent, "key">>;

/**
 * Whether an event is this chord: its {@link effectiveCode} equal to the
 * chord's key, and the exact state of all four modifiers.
 *
 * Exactness is what keeps ⌘C and ⌥⇧⌘C distinct commands rather than one
 * command with stray modifiers, and it is why a chord can be a *superset* of
 * another without swallowing it.
 */
export function chordMatchesEvent(event: ChordEventFields, chord: Chord): boolean {
  return (
    effectiveCode(event) === chord.key &&
    event.ctrlKey === (chord.ctrl === true) &&
    event.metaKey === (chord.meta === true) &&
    event.shiftKey === (chord.shift === true) &&
    event.altKey === (chord.alt === true)
  );
}

/**
 * The chord a user just pressed.
 *
 * `key` is the event's {@link effectiveCode}, so a chord recorded on a
 * layout matches the same key it was recorded from.
 *
 * `label` is captured from `event.key` — the character the key produced on
 * *their* layout — because that is the only trustworthy source of a display
 * string for a key the tables do not name. It never participates in matching
 * ([P09]).
 */
export function chordFromEvent(event: KeyboardEvent): Chord {
  return {
    key: effectiveCode(event),
    ...(event.ctrlKey ? { ctrl: true } : {}),
    ...(event.metaKey ? { meta: true } : {}),
    ...(event.shiftKey ? { shift: true } : {}),
    ...(event.altKey ? { alt: true } : {}),
    label: event.key,
  };
}

/* ---------------------------------------------------------------------------
 * The code → keyEquivalent conversion (#chord-conversion)
 * ------------------------------------------------------------------------- */

/**
 * A chord in the host's alphabet: the key-equivalent character plus the four
 * modifier booleans. The host applies the character verbatim and assembles
 * the modifier mask from the booleans, so no `NSEvent.ModifierFlags` raw
 * value ever crosses the boundary and the wire stays readable.
 */
export interface ChordSpec {
  readonly keyEquivalent: string;
  readonly command?: boolean;
  readonly shift?: boolean;
  readonly option?: boolean;
  readonly control?: boolean;
}

/**
 * AppKit's function-key private-use characters (`NSUpArrowFunctionKey` and
 * friends), written as escapes rather than literals: they are unprintable,
 * so a literal here would be a byte nobody could review.
 */
const NS_UP_ARROW = "\u{F700}";
const NS_DOWN_ARROW = "\u{F701}";
const NS_LEFT_ARROW = "\u{F702}";
const NS_RIGHT_ARROW = "\u{F703}";
const NS_DELETE = "\u{F728}";
const NS_HOME = "\u{F729}";
const NS_END = "\u{F72B}";
const NS_PAGE_UP = "\u{F72C}";
const NS_PAGE_DOWN = "\u{F72D}";
/** `NSF1FunctionKey` … `NSF12FunctionKey` are contiguous from `\u{F704}`. */
const NS_F1 = 0xf704;

/** Codes whose character does not depend on the shift flag. */
const FIXED_KEY_EQUIVALENTS: ReadonlyMap<string, string> = new Map([
  ["ArrowUp", NS_UP_ARROW],
  ["ArrowDown", NS_DOWN_ARROW],
  ["ArrowLeft", NS_LEFT_ARROW],
  ["ArrowRight", NS_RIGHT_ARROW],
  ["Escape", "\u{1B}"],
  ["Tab", "\t"],
  ["Enter", "\r"],
  ["NumpadEnter", "\u{3}"],
  ["Delete", NS_DELETE],
  ["Backspace", "\b"],
  ["Space", " "],
  ["Home", NS_HOME],
  ["End", NS_END],
  ["PageUp", NS_PAGE_UP],
  ["PageDown", NS_PAGE_DOWN],
]);

/**
 * The US-layout punctuation and digit rows, unshifted → shifted.
 *
 * Shift is not a modifier on these keys, it is a *different character*, and
 * AppKit renders the character it is given. The shipped Zoom In item is
 * `NSMenuItem(keyEquivalent: "+")` with a bare `.command` mask, so a naive
 * `"="` plus ⇧⌘ would still match at runtime but would render the menu as
 * ⇧⌘= instead of ⌘+. The character carries the shift; the mask must not
 * carry it twice.
 */
const SHIFTED_PAIRS: ReadonlyMap<string, readonly [string, string]> = new Map([
  ["Backquote", ["`", "~"]],
  ["Minus", ["-", "_"]],
  ["Equal", ["=", "+"]],
  ["BracketLeft", ["[", "{"]],
  ["BracketRight", ["]", "}"]],
  ["Backslash", ["\\", "|"]],
  ["Semicolon", [";", ":"]],
  ["Quote", ["'", '"']],
  ["Comma", [",", "<"]],
  ["Period", [".", ">"]],
  ["Slash", ["/", "?"]],
  ["Digit1", ["1", "!"]],
  ["Digit2", ["2", "@"]],
  ["Digit3", ["3", "#"]],
  ["Digit4", ["4", "$"]],
  ["Digit5", ["5", "%"]],
  ["Digit6", ["6", "^"]],
  ["Digit7", ["7", "&"]],
  ["Digit8", ["8", "*"]],
  ["Digit9", ["9", "("]],
  ["Digit0", ["0", ")"]],
]);

/** The character a code produces, or null when the code is untabled. */
function keyEquivalentCharacter(code: string, shifted: boolean): string | null {
  const fixed = FIXED_KEY_EQUIVALENTS.get(code);
  if (fixed !== undefined) return fixed;

  if (code.length === 4 && code.startsWith("Key")) {
    // AppKit renders ⇧ from the modifier mask, not from the case of the
    // character, so a letter is always lowercase here.
    return code[3].toLowerCase();
  }

  const pair = SHIFTED_PAIRS.get(code);
  if (pair !== undefined) return shifted ? pair[1] : pair[0];

  const fn = /^F(\d{1,2})$/.exec(code);
  if (fn !== null) {
    const n = Number(fn[1]);
    if (n >= 1 && n <= 12) return String.fromCharCode(NS_F1 + n - 1);
  }

  return null;
}

/**
 * Convert a chord into what an `NSMenuItem` needs.
 *
 * Returns the character and the mask **together**, never independently:
 * shifted punctuation resolves to the shifted character *with `shift`
 * dropped from the mask*, and computing the two apart is exactly how ⌘+
 * turns into ⇧⌘=.
 *
 * An untabled code throws in dev — a binding nothing can render is a
 * mistake to see immediately, not one to discover as a chord that never
 * fires — and answers `null` in production, which detaches the key
 * equivalent rather than silently mis-assigning one.
 */
export function codeToKeyEquivalent(chord: Chord): ChordSpec | null {
  const shifted = chord.shift === true;
  const character = keyEquivalentCharacter(chord.key, shifted);
  if (character === null) {
    const message = `chord-format: no key equivalent for code "${chord.key}"`;
    // Anything but a production bundle throws: dev, and the test runner,
    // which has no `import.meta.env` at all. Guarding on `PROD !== true`
    // rather than on `DEV` is what keeps the throw reachable from a test
    // instead of being a promise nothing can check.
    if (import.meta.env?.PROD !== true) throw new Error(message);
    console.warn(message);
    return null;
  }

  // The shift is spent on the character for the keys that have a shifted
  // form; every other key still needs it in the mask.
  const shiftInCharacter = shifted && SHIFTED_PAIRS.has(chord.key);

  return {
    keyEquivalent: character,
    ...(chord.meta === true ? { command: true } : {}),
    ...(shifted && !shiftInCharacter ? { shift: true } : {}),
    ...(chord.alt === true ? { option: true } : {}),
    ...(chord.ctrl === true ? { control: true } : {}),
  };
}

/**
 * Whether a chord's code has a menu-bar representation at all.
 *
 * The question `codeToKeyEquivalent` answers destructively — its throw is
 * for authored defaults, where an untabled code is a table mistake. A chord
 * the *user* just pressed is not a mistake (`IntlBackslash` is a real key on
 * every ISO keyboard), so the capture surface asks this first and the
 * registry publishes such a binding without a menu chord instead of dying
 * on it.
 */
export function chordHasKeyEquivalent(chord: Chord): boolean {
  return keyEquivalentCharacter(chord.key, chord.shift === true) !== null;
}

/**
 * Whether a chord is one a keyboard surface may record at all.
 *
 * A recordable chord carries a real modifier or is a function key. Bare `K`
 * would fire on every keystroke everywhere; shift alone is a capital letter.
 * Both the pane's capture strip and its chord probe ask this before anything
 * else, because a chord that cannot be bound has neither a conflict worth
 * reporting nor a binding worth writing.
 */
export function isRecordableChord(chord: Chord): boolean {
  if (chord.meta === true || chord.ctrl === true || chord.alt === true)
    return true;
  return /^F\d{1,2}$/.test(chord.key);
}

/* ---------------------------------------------------------------------------
 * Display
 * ------------------------------------------------------------------------- */

/**
 * Glyphs for codes whose `label` would otherwise be a word — a captured
 * `event.key` reads `"ArrowUp"`, and no menu has ever said that.
 */
const DISPLAY_GLYPHS: ReadonlyMap<string, string> = new Map([
  ["ArrowUp", "↑"],
  ["ArrowDown", "↓"],
  ["ArrowLeft", "←"],
  ["ArrowRight", "→"],
  ["Escape", "⎋"],
  ["Tab", "⇥"],
  ["Enter", "↩"],
  ["NumpadEnter", "⌤"],
  ["Delete", "⌦"],
  ["Backspace", "⌫"],
  ["Space", "␣"],
  ["Home", "↖"],
  ["End", "↘"],
  ["PageUp", "⇞"],
  ["PageDown", "⇟"],
]);

/** The character a chord's key is shown as. */
function displayKey(chord: Chord): string {
  const glyph = DISPLAY_GLYPHS.get(chord.key);
  if (glyph !== undefined) return glyph;

  if (chord.key.length === 4 && chord.key.startsWith("Key")) return chord.key[3];

  const pair = SHIFTED_PAIRS.get(chord.key);
  if (pair !== undefined) return chord.shift === true ? pair[1] : pair[0];

  if (/^F\d{1,2}$/.test(chord.key)) return chord.key;

  // A captured chord on a key with no table entry: the observed label is
  // the best answer available, and it came from the user's own layout.
  const label = chord.label;
  if (label !== undefined && label.length === 1) return label.toUpperCase();
  return label ?? chord.key;
}

/**
 * The display string for a chord, in macOS modifier order (⌃⌥⇧⌘).
 *
 * The single renderer for every displayed chord ([P11]). No surface authors
 * a shortcut string of its own: once chords are user-editable, an authored
 * string is guaranteed wrong for anyone who rebinds, and it was already
 * wrong for anyone reading Copy as Plain Text's hint.
 *
 * ⇧ is dropped when the key's shifted *character* is what gets shown — the
 * menu bar renders Zoom In as ⌘+, not ⇧⌘+, and this is the same rule
 * {@link codeToKeyEquivalent} applies to the mask, so the string and the
 * key equivalent describe the same gesture.
 */
export function formatChord(chord: Chord): string {
  const shiftInCharacter = chord.shift === true && SHIFTED_PAIRS.has(chord.key);
  let out = "";
  if (chord.ctrl === true) out += "⌃";
  if (chord.alt === true) out += "⌥";
  if (chord.shift === true && !shiftInCharacter) out += "⇧";
  if (chord.meta === true) out += "⌘";
  return out + displayKey(chord);
}
