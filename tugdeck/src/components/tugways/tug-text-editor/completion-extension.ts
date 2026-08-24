/**
 * tug-text-editor/completion-extension.ts — typeahead completion engine.
 *
 * Detects a registered trigger character (`@`, `/`, etc. — supplied by
 * the host via `completionProviders`), opens a popup of matching
 * items, tracks the query string across the whole trigger *token*
 * (trigger through the end of the word the caret sits in — see
 * "Word-savvy" below), navigates with arrow keys / Page / Home / End,
 * and on Enter or Tab inserts the chosen item as a tug atom —
 * replacing the trigger + query range with U+FFFC and a matching
 * `AtomWidget` decoration in a single transaction. One asymmetry:
 * Tab on a highlighted *directory* descends into it
 * ({@link descendIntoDirectory}) instead of accepting, keeping the
 * session alive to continue below that directory.
 *
 * Architecture:
 *
 *   - **State**: a `StateField` (`completionField`) holds the current
 *     typeahead snapshot — active flag, trigger char, anchor offset,
 *     query, filtered items, selected index, and the live provider.
 *     The field's `update` is pure — every side effect (subscribing
 *     to async providers, painting the popup) runs downstream of
 *     state changes.
 *
 *   - **Detection**: a `ViewPlugin` (`completionPlugin`) watches every
 *     transaction. On a trigger insertion (matching a registered
 *     provider key) it dispatches `activateEffect`. While active, it
 *     re-derives the query from the doc-text between the anchor and
 *     the caret and dispatches `updateEffect` when the query changed.
 *     Cursor moves outside the trigger zone or selection becoming a
 *     non-empty range dispatch `cancelEffect`. The plugin also owns
 *     the per-view subscriber set that powers the `useSyncExternalStore`
 *     adapter and manages the active provider's async-result
 *     subscription.
 *
 *   - **Word-savvy queries**: the query is the text from the trigger
 *     through the end of the token the caret sits in
 *     ({@link scanForwardForTokenEnd} — stops at whitespace, U+FFFC,
 *     doc end, or the trigger's {@link queryStopChar}), NOT
 *     trigger-to-caret. The caret's position inside
 *     the token is an editing detail, never a filter boundary: editing
 *     mid-token filters on (and accepting replaces) the whole token,
 *     so an accept can never strand a tail fragment after the atom.
 *     The token's trailing punctuation run is trimmed off the query
 *     ({@link trimTrailingPunctuation}) and left in the document, so a
 *     mention written mid-sentence (`@dash/plan.md; Phase F`) both
 *     matches and keeps its punctuation. Openers on the other side
 *     (`(@plan.md)`) don't break the trigger's claim to the token — see
 *     {@link beginsTokenAt}.
 *
 *   - **Rejoin**: when inactive, an edit (`docChanged`) or a
 *     user-originated caret move (`isUserEvent("select")` — click,
 *     arrow) that lands the caret inside — or immediately before, at a
 *     token boundary — a literal trigger…run reopens the popup with
 *     the whole token as the query. The backward scan stops at
 *     whitespace, U+FFFC, or doc start, so accepted atoms cannot
 *     rejoin. Programmatic transactions (history recall, restore)
 *     carry no `select` userEvent and are additionally stamped with
 *     {@link suppressCompletionDetection}, so they never reopen the
 *     popup.
 *
 *   - **Keys**: a `Prec.highest` `domEventHandlers` keymap intercepts
 *     Tab / Enter / Arrows / Page / Home / End / Escape only when the
 *     popup is on screen — active AND non-empty (see
 *     {@link completionPopupIsInteractive}; an empty list is hidden, so
 *     it must not eat keys). Otherwise every branch returns `false` and
 *     the keystroke falls through to the Step 4 keymap (Enter →
 *     submit/newline, Cmd-Up → history) and beyond. One further carve-
 *     out even with a visible popup: a modifier-bearing Enter (Shift /
 *     Cmd / Ctrl / Alt) is a submit-class gesture, not a completion
 *     accept, so it too falls through — guaranteeing Shift+Return always
 *     submits (see {@link completionConsumesEnter}).
 *
 *   - **Accept**: `acceptCompletionAt(view, index?)` deletes the
 *     trigger + query range, inserts U+FFFC followed by a separating
 *     space, attaches an `AtomWidget` decoration via `addAtomsEffect`,
 *     sets the caret past the space, and dispatches `cancelEffect` — all in one
 *     transaction so the editor never observes a partially-applied
 *     accept. The function is exposed so the popup's clickable items
 *     can call it directly without round-tripping through a
 *     keystroke.
 *
 * React shell integration: `subscribeCompletionState` and
 * `getCompletionState` are the `useSyncExternalStore` pair. The shell
 * reads the snapshot to render the popup; CM6's `coordsAtPos`
 * provides the anchor rect for absolute positioning.
 *
 * Provider lookup: the extension factory accepts a `getProviders`
 * thunk so the React shell can swap providers across renders without
 * rebuilding the editor [L07].
 *
 * Trigger normalization: full-width punctuation (e.g. `＠` / `／`
 * U+FF01–U+FF5E) maps to its ASCII counterpart so CJK keyboard layouts
 * activate the same providers. Mirrors `tug-prompt-input`'s
 * `lookupTrigger`.
 *
 * Laws: [L02] popup-state observed by React via `useSyncExternalStore`
 *        over the per-view subscriber set — never copied into
 *        `useState`, [L03] the React shell registers its subscriber
 *        in `useLayoutEffect` so the first paint observes the right
 *        snapshot, [L06] popup position is set via DOM style
 *        assignment, [L07] handlers and the `getProviders` thunk read
 *        the latest provider table at call time, [L11] tug-text-editor is
 *        the responder for typeahead-accept; popup items dispatch
 *        directly into `acceptCompletionAt` because the popup is a
 *        substrate-internal UI, [L19] file structure, [L20] atom
 *        insertion uses the same `addAtomsEffect` other tug-text-editor
 *        modules use — no token-slot violations or composed-child
 *        overrides, [L22] async provider results stream into the
 *        field via a direct subscribe-and-dispatch path, never
 *        through React state.
 */

import {
  Annotation,
  EditorState,
  Prec,
  StateEffect,
  StateField,
} from "@codemirror/state";
import type { Extension, Transaction } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import {
  addAtomsEffect,
  type PositionedAtom,
} from "./atom-decoration";
import { TUG_ATOM_CHAR } from "@/lib/tug-atom-img";
import { isCancelChordEvent } from "@/components/tugways/keymap-registry";
import type {
  CompletionItem,
  CompletionProvider,
} from "@/lib/tug-text-types";

// ---------------------------------------------------------------------------
// Public state shape
// ---------------------------------------------------------------------------

/**
 * Snapshot of the typeahead state. Held in `completionField`; the
 * React shell observes via `useSyncExternalStore` against
 * `subscribeCompletionState`.
 *
 * The `provider` reference is included for the `ViewPlugin`'s
 * subscription / refresh path. It is intentionally non-serializable;
 * typeahead state is transient and is not preserved across reloads
 * (Step 7 snapshot drops typeahead).
 */
export interface TugCompletionState {
  /** True when a typeahead session is in progress. */
  active: boolean;
  /** The trigger character (e.g. "@", "/") that opened the session. */
  trigger: string;
  /** Document offset of the trigger character. */
  anchorOffset: number;
  /** Query string typed after the trigger. */
  query: string;
  /** Items returned by the active provider for the current query. */
  filtered: readonly CompletionItem[];
  /** Index of the keyboard-selected item in `filtered`. */
  selectedIndex: number;
  /** Live provider — used for async refresh. `null` when inactive. */
  provider: CompletionProvider | null;
}

const inactiveState: TugCompletionState = {
  active: false,
  trigger: "",
  anchorOffset: 0,
  query: "",
  filtered: [],
  selectedIndex: 0,
  provider: null,
};

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

/**
 * Marks a transaction as a programmatic whole-document replacement
 * (history navigation, state-preservation restore) rather than user
 * editing. The completion extender skips BOTH trigger-insertion and
 * rejoin detection on an annotated transaction, and cancels any active
 * session.
 *
 * Why this is needed: `buildEditStateTransaction` swaps a whole
 * document into the editor in one transaction. When the restored text
 * happens to begin with a trigger character (`/command`, `@file`),
 * `detectRejoin` would otherwise scan back from the caret, find the
 * leading trigger, and reopen the typeahead popup. The now-active
 * popup's `Prec.highest` keymap then swallows the next Enter /
 * Shift+Return as an accept instead of letting it reach the submit
 * path — so recalling a `/command` from history silently breaks
 * submit. A programmatic restore is not the user clicking into a
 * trigger run, so it must not reopen the popup.
 */
export const suppressCompletionDetection = Annotation.define<boolean>();

// ---------------------------------------------------------------------------
// State effects
// ---------------------------------------------------------------------------

/** Open a typeahead session. */
const activateEffect = StateEffect.define<{
  trigger: string;
  anchorOffset: number;
  provider: CompletionProvider;
  query: string;
  filtered: readonly CompletionItem[];
}>();

/** Refresh the active session's query / filtered / selectedIndex. */
const updateEffect = StateEffect.define<{
  query: string;
  filtered: readonly CompletionItem[];
  selectedIndex: number;
}>();

/** Move the keyboard selection within the active session's list. */
const navigateEffect = StateEffect.define<number>();

/** Cancel the active session. */
const cancelEffect = StateEffect.define<null>();

// ---------------------------------------------------------------------------
// State field
// ---------------------------------------------------------------------------

/** Single source of truth for typeahead state. */
export const completionField = StateField.define<TugCompletionState>({
  create(): TugCompletionState {
    return inactiveState;
  },

  update(value: TugCompletionState, tr: Transaction): TugCompletionState {
    let next = value;
    // Map the anchor through document changes so passive edits
    // elsewhere keep typeahead glued to the original trigger
    // character. The `activateEffect` carries an absolute offset and
    // overrides this by re-assigning the whole state.
    if (tr.docChanged && next.active) {
      next = {
        ...next,
        anchorOffset: tr.changes.mapPos(next.anchorOffset, 1),
      };
    }
    for (const effect of tr.effects) {
      if (effect.is(activateEffect)) {
        next = {
          active: true,
          trigger: effect.value.trigger,
          anchorOffset: effect.value.anchorOffset,
          query: effect.value.query,
          filtered: effect.value.filtered,
          selectedIndex: 0,
          provider: effect.value.provider,
        };
      } else if (effect.is(updateEffect)) {
        if (!next.active) continue;
        next = {
          ...next,
          query: effect.value.query,
          filtered: effect.value.filtered,
          selectedIndex: effect.value.selectedIndex,
        };
      } else if (effect.is(navigateEffect)) {
        if (!next.active) continue;
        const max = Math.max(0, next.filtered.length - 1);
        const clamped = Math.max(0, Math.min(effect.value, max));
        if (clamped !== next.selectedIndex) {
          next = { ...next, selectedIndex: clamped };
        }
      } else if (effect.is(cancelEffect)) {
        next = inactiveState;
      }
    }
    return next;
  },
});

// ---------------------------------------------------------------------------
// Trigger detection (pure helpers — testable in isolation)
// ---------------------------------------------------------------------------

/**
 * Map a typed character to a registered provider, normalizing
 * full-width Unicode punctuation (U+FF01–U+FF5E) to its ASCII
 * counterpart so CJK keyboard layouts activate the same providers.
 * Mirrors `tug-prompt-input`'s `lookupTrigger`.
 */
export function lookupCompletionProvider(
  providers: Record<string, CompletionProvider>,
  ch: string,
): CompletionProvider | undefined {
  const direct = providers[ch];
  if (direct) return direct;
  if (ch.length === 0) return undefined;
  const code = ch.charCodeAt(0);
  if (code >= 0xFF01 && code <= 0xFF5E) {
    const ascii = String.fromCharCode(code - 0xFEE0);
    return providers[ascii];
  }
  return undefined;
}

/**
 * Inspect a transaction to decide whether a trigger character was
 * just inserted at the caret. Returns the trigger position (the
 * inserted character's offset in the new doc) and the matching
 * provider, or `null` if no trigger fired.
 *
 * The detection rule is deliberately narrow — only a single-step
 * insertion that lands the caret immediately after a trigger char
 * activates typeahead. Programmatic doc replacements (history
 * navigation, paste, accept-completion) replace large ranges and
 * do not match this rule.
 */
export function detectTriggerInsertion(
  tr: Transaction,
  providers: Record<string, CompletionProvider>,
):
  | { provider: CompletionProvider; trigger: string; anchorOffset: number }
  | null {
  if (!tr.docChanged) return null;
  const head = tr.state.selection.main.head;
  if (head === 0) return null;
  let firedAt: number | null = null;
  let firedChar = "";
  tr.changes.iterChanges((_fromA, _toA, _fromB, toB, inserted) => {
    if (firedAt !== null) return;
    if (toB !== head) return;
    if (inserted.length === 0) return;
    // Only single-character insertions count as trigger activations.
    // Multi-char inserts (paste, history) might happen to contain a
    // trigger but we don't want to activate from those.
    const text = inserted.toString();
    if (text.length !== 1) return;
    const ch = text;
    if (lookupCompletionProvider(providers, ch) !== undefined) {
      firedAt = toB - 1;
      firedChar = ch;
    }
  });
  if (firedAt === null) return null;
  const provider = lookupCompletionProvider(providers, firedChar);
  if (!provider) return null;
  return { provider, trigger: firedChar, anchorOffset: firedAt };
}

/**
 * Walk backward from `pos` to the head of the unbroken token the caret
 * sits in (stopping at whitespace, the atom character U+FFFC, or doc
 * start), then report a trigger only if that head character is a
 * registered trigger. Returns the trigger char and its offset, or null.
 *
 * Only the token's FIRST character counts — a trigger glued mid-token
 * ({@link beginsTokenAt} calls out `foo@bar`, `x/cmd`) is part of the
 * word, not a trigger. This matters for pasted file paths like
 * `@tuglaws/tuglaws.m`: the inner `/` must NOT shadow the leading `@`,
 * or backspacing into the paste would fire slash-command completion
 * (position-gated → empty) instead of file completion on the `@`.
 *
 * The atom char is a stop because accepted completions occupy a
 * single U+FFFC code point — once accepted, an `@…` is no longer a
 * literal trigger run and must not rejoin.
 *
 * A leading run of {@link LEADING_TOKEN_PUNCTUATION} is skipped, so
 * clicking back into `(@file.md)` finds the `@` rather than the `(`.
 */
export function scanBackForTrigger(
  doc: { sliceString: (from: number, to: number) => string },
  pos: number,
  providers: Record<string, CompletionProvider>,
): { trigger: string; anchorOffset: number } | null {
  let head = -1;
  for (let i = pos - 1; i >= 0; i--) {
    const ch = doc.sliceString(i, i + 1);
    if (ch === TUG_ATOM_CHAR || /\s/.test(ch)) break;
    head = i;
  }
  if (head === -1) return null;
  while (
    head < pos &&
    LEADING_TOKEN_PUNCTUATION.includes(doc.sliceString(head, head + 1))
  ) {
    head++;
  }
  if (head >= pos) return null;
  const ch = doc.sliceString(head, head + 1);
  if (lookupCompletionProvider(providers, ch) !== undefined) {
    return { trigger: ch, anchorOffset: head };
  }
  return null;
}

/**
 * The extra character — beyond whitespace, U+FFFC, and doc end — that ends a
 * given trigger's query, or `null` when the trigger has none.
 *
 * A slash-command name never contains a `/`, so a second slash inside the
 * token starts a *different* command rather than continuing this one. That
 * makes prepending work: with `/tugplug:implement …` already in the composer,
 * typing `/compact` at offset 0 produces the single token
 * `/compact/tugplug:implement`, and without this stop the query would be the
 * whole unmatchable run — no popup, and the following space would be plain
 * text instead of the accept that atomizes `/compact`.
 *
 * The rule is per-trigger, not global, because the same character is ordinary
 * query text elsewhere: a `@` file path is full of slashes
 * (`@tuglaws/tuglaws.md`) and can even repeat its own trigger
 * (`@node_modules/@types/bun`).
 */
export function queryStopChar(trigger: string): string | null {
  return trigger === "/" ? "/" : null;
}

/**
 * Punctuation that a trigger token sheds from its tail before the query
 * is filtered or accepted: sentence and clause marks, quotes, and closing
 * brackets.
 *
 * `/` is absent because it is path structure a `@` query needs
 * (`@src/` is a directory descent, not a mention followed by a slash),
 * and `-`, `_`, `~`, `+` are absent because they are ordinary filename
 * characters.
 */
const TRAILING_TOKEN_PUNCTUATION = ",;:!?.'\"`)]}>";

/**
 * Punctuation that may sit between a token boundary and a trigger
 * without breaking the trigger's claim to the token: opening brackets
 * and quotes, so `(@file.md)` and `"@file.md"` are mentions wearing
 * delimiters rather than words beginning with `(`.
 */
const LEADING_TOKEN_PUNCTUATION = "([{<'\"`";

/**
 * Strip the token's trailing punctuation run from a typeahead query.
 *
 * `@` tokens end at whitespace, so a mention written mid-sentence carries
 * the punctuation that follows it into the query — `@dash/plan.md;`
 * queries for a path no file has. Trimming the tail leaves the query the
 * user meant, and {@link acceptCompletionAt} replaces only up to the trim
 * point, so the punctuation survives as the prose it was.
 *
 * The trim is re-derived on every transaction from document text that is
 * never modified: typing past the punctuation makes it interior and the
 * next derivation includes it again. Only the tail is affected, so
 * `@my,file.md` still queries in full.
 *
 * Pure; exported for the test suite.
 */
export function trimTrailingPunctuation(query: string): string {
  let end = query.length;
  while (end > 0 && TRAILING_TOKEN_PUNCTUATION.includes(query[end - 1]!)) {
    end--;
  }
  return query.slice(0, end);
}

/**
 * Walk forward from `pos` to the end of the token containing it:
 * the first whitespace, atom character (U+FFFC), or doc end — or the
 * trigger's {@link queryStopChar} when one is supplied. Returns the
 * offset one past the token's last character (== `pos` when `pos`
 * already sits at a token boundary).
 *
 * This is the forward complement of {@link scanBackForTrigger} and the
 * heart of word-savvy completion: queries and accepts span the whole
 * token, never just the trigger-to-caret prefix.
 */
export function scanForwardForTokenEnd(
  doc: { sliceString: (from: number, to: number) => string; length: number },
  pos: number,
  stopChar?: string | null,
): number {
  let i = pos;
  while (i < doc.length) {
    const ch = doc.sliceString(i, i + 1);
    if (ch === TUG_ATOM_CHAR || /\s/.test(ch)) break;
    if (stopChar !== undefined && stopChar !== null && ch === stopChar) break;
    i++;
  }
  return i;
}

/**
 * Whether `pos` is a token start: doc start, or preceded by whitespace,
 * an atom character, or a run of {@link LEADING_TOKEN_PUNCTUATION} that
 * itself begins a token. Gates the caret-parked-on-trigger cases — a
 * trigger char glued to preceding text (`x/cmd`, `foo@bar`) does not
 * begin a token when approached from its own offset, while a bracketed
 * or quoted one (`(@file.md`, `"@file.md`) does.
 */
export function beginsTokenAt(
  doc: { sliceString: (from: number, to: number) => string },
  pos: number,
): boolean {
  let i = pos;
  while (i > 0) {
    const prev = doc.sliceString(i - 1, i);
    if (prev === TUG_ATOM_CHAR || /\s/.test(prev)) return true;
    if (!LEADING_TOKEN_PUNCTUATION.includes(prev)) return false;
    i--;
  }
  return true;
}

/**
 * Compute the typeahead query from the active session and current
 * doc/caret state, returning either the new query string, `"cancel"`
 * if the session should end, or `"unchanged"` if nothing changed.
 *
 * The query spans the trigger through the end of the token the caret
 * sits in ({@link scanForwardForTokenEnd}) — word-savvy, not
 * caret-bounded. The caret is valid anywhere in `[anchor, tokenEnd]`;
 * sitting exactly ON the trigger is allowed only while the trigger
 * begins a token (the promotion case: deleting leading text so a
 * `/command` now heads the doc parks the caret at offset 0).
 *
 * Cancel conditions:
 *   - Selection is non-empty (user dragged a range).
 *   - The trigger character is no longer at the anchor (deleted).
 *   - Caret is before the trigger anchor (user backspaced past it).
 *   - Caret is on the trigger but the trigger no longer begins a token
 *     (user typed text immediately before it).
 *   - Caret has moved past the trigger's own token (crossed whitespace
 *     into a new word) — an abandoned run must not swallow later text or
 *     shadow a fresh trigger typed after it.
 *   - The query text would contain a newline.
 */
export function deriveQueryUpdate(
  state: TugCompletionState,
  doc: { sliceString: (from: number, to: number) => string; length: number },
  selection: { from: number; to: number; head: number },
): { kind: "unchanged" } | { kind: "cancel" } | { kind: "query"; value: string } {
  if (!state.active) return { kind: "unchanged" };
  if (selection.from !== selection.to) return { kind: "cancel" };
  if (selection.head > doc.length) return { kind: "cancel" };
  if (
    doc.sliceString(state.anchorOffset, state.anchorOffset + 1) !==
    state.trigger
  ) {
    return { kind: "cancel" };
  }
  if (selection.head < state.anchorOffset) return { kind: "cancel" };
  if (
    selection.head === state.anchorOffset &&
    !beginsTokenAt(doc, state.anchorOffset)
  ) {
    return { kind: "cancel" };
  }
  const queryStart = state.anchorOffset + 1;
  const tokenEnd = scanForwardForTokenEnd(
    doc,
    queryStart,
    queryStopChar(state.trigger),
  );
  if (selection.head > tokenEnd) return { kind: "cancel" };
  const raw = doc.sliceString(queryStart, tokenEnd);
  if (raw.includes("\n")) return { kind: "cancel" };
  // Liveness is judged against the raw token end (above), the query against
  // the trimmed one: a caret resting after the `;` in `@plan.md;` is still
  // inside its token, so the session stays open on a query of "plan.md".
  const query = trimTrailingPunctuation(raw);
  if (query === state.query) return { kind: "unchanged" };
  return { kind: "query", value: query };
}

/**
 * Inspect a transaction in the inactive state to decide whether the
 * user just moved into (or edited inside) a literal trigger…run that
 * was never accepted as an atom — rejoining typeahead with the whole
 * token as the query.
 *
 * Fires on doc changes AND on user-originated selection moves
 * (`isUserEvent("select")` — pointer clicks arrive as
 * `select.pointer`, arrow motion as `select`). Picking up an edit
 * anywhere in an unaccepted `@foo` — backspacing into it, clicking
 * into it, arrowing into it — must reopen the popup. Programmatic
 * selection or doc changes (history recall, restore) carry no `select`
 * userEvent and stamp {@link suppressCompletionDetection}, so they
 * never reopen it; the Enter-swallowing hazard that once justified an
 * edits-only gate is handled where it belongs, by that annotation and
 * by {@link completionConsumesEnter}.
 *
 * Two anchor discoveries:
 *   1. Backward scan from the caret ({@link scanBackForTrigger}) —
 *      the caret is inside or at the end of the token.
 *   2. Caret parked exactly ON a trigger that begins a token — the
 *      promotion case: deleting the leading text of `x/cmd` leaves
 *      the caret at offset 0 before `/cmd`, which must engage slash
 *      completion.
 */
export function detectRejoin(
  tr: Transaction,
  providers: Record<string, CompletionProvider>,
):
  | {
      provider: CompletionProvider;
      trigger: string;
      anchorOffset: number;
      query: string;
    }
  | null {
  for (const eff of tr.effects) {
    if (eff.is(cancelEffect)) return null;
  }
  if (!tr.docChanged && !tr.isUserEvent("select")) return null;
  const sel = tr.state.selection.main;
  if (sel.from !== sel.to) return null;
  let found = scanBackForTrigger(tr.state.doc, sel.head, providers);
  if (!found) {
    const at = tr.state.doc.sliceString(sel.head, sel.head + 1);
    if (
      lookupCompletionProvider(providers, at) !== undefined &&
      beginsTokenAt(tr.state.doc, sel.head)
    ) {
      found = { trigger: at, anchorOffset: sel.head };
    }
  }
  if (!found) return null;
  const provider = lookupCompletionProvider(providers, found.trigger);
  if (!provider) return null;
  const queryEnd = scanForwardForTokenEnd(
    tr.state.doc,
    found.anchorOffset + 1,
    queryStopChar(found.trigger),
  );
  // The caret must sit inside the run we found. A `queryStopChar` can end the
  // query before the caret (`/compact/tugplug…` clicked inside the second
  // command), and reopening there would activate a session that
  // `deriveQueryUpdate` cancels on the very next transaction — a popup that
  // flashes on every keystroke. Leading-trigger-wins means that run simply
  // gets no popup.
  if (sel.head > queryEnd) return null;
  const query = trimTrailingPunctuation(
    tr.state.doc.sliceString(found.anchorOffset + 1, queryEnd),
  );
  return {
    provider,
    trigger: found.trigger,
    anchorOffset: found.anchorOffset,
    query,
  };
}

// ---------------------------------------------------------------------------
// View plugin (detection + per-view subscribers + async refresh)
// ---------------------------------------------------------------------------

interface CompletionPluginValue {
  subscribe(listener: () => void): () => void;
  destroy?(): void;
}

/**
 * Shallow item-list equality by label, used to skip a redundant
 * sync-refresh dispatch when the re-derived results match what is already
 * shown (the common case where detection wasn't stale).
 */
function sameCompletionItems(
  a: readonly CompletionItem[],
  b: readonly CompletionItem[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].label !== b[i].label) return false;
  }
  return true;
}

const completionPlugin = ViewPlugin.fromClass(
  class implements CompletionPluginValue {
    private listeners = new Set<() => void>();
    private lastState: TugCompletionState;
    private providerUnsubscribe: (() => void) | null = null;

    constructor(
      private readonly view: EditorView,
      private readonly getProviders: () => Record<string, CompletionProvider>,
    ) {
      this.lastState = view.state.field(completionField);
      this.installProviderSubscription(this.lastState);
    }

    update(update: ViewUpdate): void {
      // Detection runs in a `transactionExtender` (registered below)
      // because dispatching from inside `ViewPlugin.update` throws —
      // CM6 prohibits nested updates. The extender appends
      // activate / update / cancel effects to the in-flight
      // transaction so they apply atomically with the user's
      // keystroke. This `update` method only reacts to the resulting
      // state changes: it manages the active provider's async-result
      // subscription and notifies React subscribers.
      const newState = update.state.field(completionField);
      if (newState !== this.lastState) {
        const providerChanged = newState.provider !== this.lastState.provider;
        const becameActive =
          newState.active && (!this.lastState.active || providerChanged);
        if (providerChanged) {
          this.installProviderSubscription(newState);
        }
        this.lastState = newState;
        for (const listener of this.listeners) listener();
        // A synchronous provider has no `subscribe` refresh, so the
        // `filtered` computed during detection (in the transaction
        // extender, before the document change is reflected) can be stale.
        // A position-gated provider, for instance, reads the not-yet-current
        // text and yields nothing. While typing, the next keystroke
        // re-derives and fixes it — but a one-shot insertion like a paste
        // has no follow-up keystroke, so the popup stays empty. Re-run the
        // provider once on a microtask (after the transaction has applied
        // and the document is current) and patch the results.
        if (becameActive && newState.provider && !newState.provider.subscribe) {
          this.scheduleSyncRefresh(newState.provider);
        }
      }
    }

    /**
     * Re-derive results for a freshly-activated synchronous provider on a
     * microtask, dispatching `updateEffect` only when they actually change.
     * The microtask runs after the activating transaction has fully applied,
     * so a provider that reads the live document (e.g. the position-gated
     * slash provider) now sees the current text. Dispatching here is safe —
     * we are outside the update cycle, the same way the async `subscribe`
     * path dispatches from its callback.
     */
    private scheduleSyncRefresh(provider: CompletionProvider): void {
      queueMicrotask(() => {
        const live = this.view.state.field(completionField);
        if (!live.active || live.provider !== provider) return;
        const filtered = provider(live.query);
        if (sameCompletionItems(filtered, live.filtered)) return;
        const selectedIndex = Math.min(
          live.selectedIndex,
          Math.max(0, filtered.length - 1),
        );
        this.view.dispatch({
          effects: updateEffect.of({
            query: live.query,
            filtered,
            selectedIndex,
          }),
        });
      });
    }

    /**
     * If the active provider exposes `subscribe`, register a refresh
     * listener that re-reads results for the current query and
     * dispatches `updateEffect`. Used by async completion sources
     * (file-tree, slash-command index) per [L22].
     */
    private installProviderSubscription(state: TugCompletionState): void {
      this.providerUnsubscribe?.();
      this.providerUnsubscribe = null;
      if (!state.active || !state.provider?.subscribe) return;
      const subscribedProvider = state.provider;
      this.providerUnsubscribe = subscribedProvider.subscribe!(() => {
        const live = this.view.state.field(completionField);
        if (!live.active || live.provider !== subscribedProvider) return;
        const filtered = subscribedProvider(live.query);
        const selectedIndex = Math.min(
          live.selectedIndex,
          Math.max(0, filtered.length - 1),
        );
        this.view.dispatch({
          effects: updateEffect.of({
            query: live.query,
            filtered,
            selectedIndex,
          }),
        });
      });
    }

    /**
     * Register a React subscriber. The listener fires after every
     * transaction in which the typeahead state changed identity (the
     * field's `update` returns a fresh object only on real changes).
     */
    subscribe(listener: () => void): () => void {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    }

    destroy(): void {
      this.providerUnsubscribe?.();
      this.providerUnsubscribe = null;
      this.listeners.clear();
    }
  },
);

// ---------------------------------------------------------------------------
// Transaction extender — detection + query refresh
// ---------------------------------------------------------------------------

/**
 * The detection-and-refresh half of the typeahead extension. Runs
 * once per transaction via `EditorState.transactionExtender` and
 * returns extra effects to merge into the in-flight transaction.
 *
 * Why a transaction extender (and not a `ViewPlugin.update`
 * dispatch): `EditorView.update` throws when called from inside
 * itself, and `ViewPlugin.update` runs inside the update cycle.
 * The extender runs as part of building the transaction's final
 * state, so it can append our effects synchronously without nesting.
 */
function completionExtender(
  tr: Transaction,
  getProviders: () => Record<string, CompletionProvider>,
): { effects: StateEffect<unknown>[] } | null {
  const fieldState = tr.state.field(completionField);

  // Programmatic whole-document replacement (history nav / restore):
  // never open a popup from one, and cancel any session that was
  // somehow still active. See `suppressCompletionDetection`.
  if (tr.annotation(suppressCompletionDetection) === true) {
    return fieldState.active ? { effects: [cancelEffect.of(null)] } : null;
  }

  // Activation: typeahead is currently inactive. Two paths:
  //   1. Trigger insertion — the user just typed `@` / `/` / etc.
  //   2. Rejoin — the caret moved into (or typed within) an existing
  //      literal trigger…run that was never accepted as an atom.
  if (!fieldState.active) {
    const providers = getProviders();
    const detected = detectTriggerInsertion(tr, providers);
    if (detected !== null) {
      // Word-savvy activation: a trigger typed immediately before an
      // existing word adopts that word as the query (`@` in front of
      // `index.ts` opens filtering on "index.ts"). At a token boundary
      // the scan returns the anchor itself and the query is "".
      const queryEnd = scanForwardForTokenEnd(
        tr.state.doc,
        detected.anchorOffset + 1,
        queryStopChar(detected.trigger),
      );
      const query = trimTrailingPunctuation(
        tr.state.doc.sliceString(detected.anchorOffset + 1, queryEnd),
      );
      const filtered = detected.provider(query);
      return {
        effects: [
          activateEffect.of({
            trigger: detected.trigger,
            anchorOffset: detected.anchorOffset,
            provider: detected.provider,
            query,
            filtered,
          }),
        ],
      };
    }
    const rejoin = detectRejoin(tr, providers);
    if (rejoin !== null) {
      const filtered = rejoin.provider(rejoin.query);
      return {
        effects: [
          activateEffect.of({
            trigger: rejoin.trigger,
            anchorOffset: rejoin.anchorOffset,
            provider: rejoin.provider,
            query: rejoin.query,
            filtered,
          }),
        ],
      };
    }
    return null;
  }

  // Active path: re-derive query from the post-transaction state.
  // `tr.state.field(completionField)` already maps the anchor through
  // any doc changes via the field's own update reducer.
  const sel = tr.state.selection.main;
  const verdict = deriveQueryUpdate(fieldState, tr.state.doc, {
    from: sel.from,
    to: sel.to,
    head: sel.head,
  });
  if (verdict.kind === "cancel") {
    return { effects: [cancelEffect.of(null)] };
  }
  if (verdict.kind === "query") {
    const provider = fieldState.provider!;
    const filtered = provider(verdict.value);
    // Typing re-filters and resets the selection to the best (top) match.
    // The list is ordered by match quality, so index 0 is the best option.
    // The selection responds only to the user's actions — a keystroke resets
    // it; arrow keys move it — never carrying a stale highlight from before
    // the query changed.
    return {
      effects: [
        updateEffect.of({
          query: verdict.value,
          filtered,
          selectedIndex: 0,
        }),
      ],
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API for the React shell
// ---------------------------------------------------------------------------

/**
 * Read the current typeahead snapshot. Used by the React shell as
 * the `getSnapshot` half of `useSyncExternalStore`.
 */
export function getCompletionState(view: EditorView): TugCompletionState {
  return view.state.field(completionField);
}

/**
 * Subscribe to typeahead state changes. The listener fires after
 * every transaction in which the field's identity changed. Returns
 * an unsubscribe function. Used by the React shell as the
 * `subscribe` half of `useSyncExternalStore`. Returns a no-op
 * unsubscribe if the plugin is not present (e.g. an editor that
 * was built without `tugCompletionExt`).
 */
export function subscribeCompletionState(
  view: EditorView,
  listener: () => void,
): () => void {
  const plugin = view.plugin(completionPlugin);
  if (plugin === null) return () => {};
  return plugin.subscribe(listener);
}

// ---------------------------------------------------------------------------
// Action helpers
// ---------------------------------------------------------------------------

/**
 * Insert the chosen completion as a tug atom. Replaces the trigger
 * character + query range — the WHOLE token, since the query spans
 * trigger-to-token-end ({@link deriveQueryUpdate}); accepting from a
 * mid-token caret consumes the full word and can never strand a tail
 * fragment after the atom — with U+FFFC plus a separating space (unless
 * one already follows), attaches the matching `AtomWidget` decoration
 * via `addAtomsEffect`, sets the caret past the space so the next
 * keystroke doesn't glue onto the atom, and cancels the typeahead
 * session — all in one transaction so the editor never observes a
 * partially-applied accept.
 *
 * `index` defaults to the currently-selected item. No-op if
 * typeahead is not active or `filtered` is empty.
 */
export function acceptCompletionAt(view: EditorView, index?: number): void {
  const state = view.state.field(completionField);
  if (!state.active || state.filtered.length === 0) return;
  const idx = index ?? state.selectedIndex;
  if (idx < 0 || idx >= state.filtered.length) return;
  const item = state.filtered[idx]!;
  const doc = view.state.doc;
  const start = state.anchorOffset;
  // `state.query` is already shorn of the token's trailing punctuation
  // ({@link trimTrailingPunctuation}), so the replaced range stops before it
  // and `@plan.md;` accepts to `<atom>;` — the semicolon was prose, not part
  // of the path. Scanning forward from there recovers the run.
  const end = start + 1 + state.query.length;
  const tokenEnd = scanForwardForTokenEnd(
    doc,
    end,
    queryStopChar(state.trigger),
  );
  const trailing = doc.sliceString(end, tokenEnd);
  // Follow the token with a separating space so text the user types next
  // doesn't glue onto it (e.g. accepting "/tugplug:commit" then typing
  // "just" must not yield the non-existent command "/tugplug:commitjust").
  // Skip it when a space already follows — accepting in front of existing
  // text shouldn't leave a double space. The space goes after any surviving
  // punctuation, never between it and the atom.
  const needsSpace = doc.sliceString(tokenEnd, tokenEnd + 1) !== " ";
  const changes =
    trailing.length === 0
      ? [
          {
            from: start,
            to: end,
            insert: needsSpace ? TUG_ATOM_CHAR + " " : TUG_ATOM_CHAR,
          },
        ]
      : [
          { from: start, to: end, insert: TUG_ATOM_CHAR },
          ...(needsSpace
            ? [{ from: tokenEnd, to: tokenEnd, insert: " " }]
            : []),
        ];
  const positioned: PositionedAtom = {
    position: start,
    segment: item.atom,
  };
  view.dispatch({
    changes,
    effects: [
      addAtomsEffect.of([positioned]),
      cancelEffect.of(null),
    ],
    // Past the separator either way — the atom, the surviving punctuation,
    // and the space — ready for the next keystroke.
    selection: { anchor: start + 2 + trailing.length },
    scrollIntoView: true,
    userEvent: "input.tug-completion",
  });
}

/**
 * Descend into the highlighted directory completion instead of
 * accepting it: rewrite the trigger token's query to the directory's
 * full path (`@src` → `@src/`) and keep the session alive, so the
 * next keystroke — or the refreshed result list — continues below
 * that directory. Every fuzzy file picker teaches Tab-as-descend for
 * directories; Enter (and click) still atomize.
 *
 * Returns `false` — leaving the keystroke to the accept path — when
 * typeahead is inactive, the highlighted item is not a directory, or
 * the query already equals the directory path (a second Tab on an
 * already-descended token would otherwise be a no-op loop; falling
 * through to accept gives the "I really mean this directory" reading).
 */
export function descendIntoDirectory(view: EditorView, index?: number): boolean {
  const state = view.state.field(completionField);
  if (!state.active || state.filtered.length === 0) return false;
  const idx = index ?? state.selectedIndex;
  if (idx < 0 || idx >= state.filtered.length) return false;
  const item = state.filtered[idx]!;
  if (item.atom.type !== "directory") return false;
  if (state.query === item.atom.value) return false;
  const from = state.anchorOffset + 1;
  const to = from + state.query.length;
  view.dispatch({
    changes: { from, to, insert: item.atom.value },
    selection: { anchor: from + item.atom.value.length },
    scrollIntoView: true,
    userEvent: "input.tug-completion",
  });
  return true;
}

/**
 * Move the keyboard selection within the active typeahead's filtered
 * list. Accepts `"up"` / `"down"` / `"first"` / `"last"` or an
 * absolute index. No-op when typeahead is inactive.
 */
export function navigateCompletion(
  view: EditorView,
  direction: "up" | "down" | "first" | "last" | { delta: number } | { to: number },
): void {
  const state = view.state.field(completionField);
  if (!state.active || state.filtered.length === 0) return;
  let target = state.selectedIndex;
  if (direction === "up") target -= 1;
  else if (direction === "down") target += 1;
  else if (direction === "first") target = 0;
  else if (direction === "last") target = state.filtered.length - 1;
  else if ("delta" in direction) target += direction.delta;
  else target = direction.to;
  view.dispatch({ effects: navigateEffect.of(target) });
}

/** Cancel the active typeahead session. No-op when inactive. */
export function cancelCompletion(view: EditorView): void {
  const state = view.state.field(completionField);
  if (!state.active) return;
  view.dispatch({ effects: cancelEffect.of(null) });
}

// ---------------------------------------------------------------------------
// Keymap (active-only)
// ---------------------------------------------------------------------------

/** Page jump magnitude — matches `tug-prompt-input`'s 10-row page. */
const PAGE_STEP = 10;

/**
 * Whether the active-typeahead keymap should claim an Enter-family
 * keystroke as a completion *accept*. Only a modifier-free Enter does:
 * any modifier-bearing Enter is a submit-class gesture — Shift+Enter is
 * the explicit submit override, Cmd+Enter is forced submit — and must
 * be yielded to the lower submit keymap, never swallowed as an accept.
 *
 * This is the load-bearing guarantee behind the invariant "while the
 * caret is in a prompt-entry, Shift+Return submits": it must hold even
 * when the popup is open (history recall, paste into a trigger run,
 * live `/command` composition). Earlier fixes tried to stop the popup
 * from *opening* in specific cases; gating the accept here enforces the
 * invariant for every case at once.
 *
 * Pure; exported for the test suite.
 */
export function completionConsumesEnter(mods: {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): boolean {
  return !(mods.shiftKey || mods.metaKey || mods.ctrlKey || mods.altKey);
}

/**
 * Whether the typed query is an exact match for the currently-highlighted
 * completion item's label. This is the gate for Space-to-accept: Tab and
 * Enter complete the highlighted item from any prefix, but a space is a
 * normal text character, so it may only "accept" when the user has already
 * typed the full command name and the popup is merely confirming it. A
 * non-matching space is yielded and inserts literally, keeping the query
 * alive.
 *
 * A plugin command's label is namespaced (`tugplug:devise`), but the user can
 * type just its unqualified leaf (`devise`). An exact match against that leaf
 * counts the same as an exact full-name match, so `/devise ` accepts the
 * `tugplug:devise` chip — the leaf is what the user typed in full.
 *
 * Pure; exported for the test suite.
 */
export function completionQueryMatchesSelection(state: {
  query: string;
  filtered: readonly { label: string }[];
  selectedIndex: number;
}): boolean {
  const item = state.filtered[state.selectedIndex];
  if (item === undefined) return false;
  if (item.label === state.query) return true;
  const colon = item.label.lastIndexOf(":");
  return colon >= 0 && item.label.slice(colon + 1) === state.query;
}

/**
 * Whether the typeahead popup currently owns the navigation / accept
 * keys. True only when a session is active AND has at least one item —
 * i.e. the popup is actually on screen. `paintCompletionPopup` hides an
 * empty list with `display:none`, so an active-but-empty session (a `/`
 * pasted mid-text, gated to zero items by the position-0 rule; or an
 * async source mid-load) is invisible and owns nothing. When it owns
 * nothing the keymap yields every key, so submit / newline / caret
 * motion are never swallowed by a popup the user cannot see — the
 * other half of why a pasted file path used to kill Shift+Return.
 *
 * Pure; exported for the test suite.
 */
export function completionPopupIsInteractive(snapshot: {
  active: boolean;
  itemCount: number;
}): boolean {
  return snapshot.active && snapshot.itemCount > 0;
}

const tugCompletionKeymap = Prec.highest(
  EditorView.domEventHandlers({
    keydown(event, view) {
      const state = view.state.field(completionField);
      // Only a visible popup (active + non-empty) owns keys. An inactive
      // or active-but-empty (invisible) session yields everything.
      if (
        !completionPopupIsInteractive({
          active: state.active,
          itemCount: state.filtered.length,
        })
      ) {
        return false;
      }
      // IME composition: leave keys alone — the IME owns commit.
      if (event.isComposing) return false;
      // Submit-class Enter overrides (Shift / Cmd / Ctrl / Alt + Enter)
      // are never a completion accept. Yield them untouched — no
      // preventDefault, no stopPropagation — so they fall through to the
      // submit keymap. Returning before the `consumes` block below is
      // deliberate: we must NOT stop propagation, or the document
      // keyboard pipeline and the editor's own submit handler would be
      // starved of the very keystroke that has to submit.
      if (event.key === "Enter" && !completionConsumesEnter(event)) {
        return false;
      }
      // Space accepts only when the typed query is an exact match for the
      // highlighted command — unlike Tab/Enter, which complete the
      // highlighted item from any prefix. A space that doesn't exactly match
      // is yielded untouched so it inserts as a literal character and keeps
      // the query going (e.g. "/tug " stays text, never auto-accepts).
      if (event.key === " ") {
        if (
          event.shiftKey ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          !completionQueryMatchesSelection({
            query: state.query,
            filtered: state.filtered,
            selectedIndex: state.selectedIndex,
          })
        ) {
          return false;
        }
        event.preventDefault();
        event.stopPropagation();
        acceptCompletionAt(view);
        return true;
      }
      // A key the active typeahead consumes is fully owned by it: stop it
      // bubbling to the document keyboard pipeline so it can't ALSO drive a
      // chain action. Without this, an Enter that accepts a completion
      // continues to the bubble-phase Stage 2 (Enter → default-button
      // activation); if the accept opened a sheet, that stray Enter clicks
      // the sheet's primary button and dismisses it on the spot. The
      // typeahead's keys are navigation/accept/cancel — none should leak.
      // ⌘. is a term here and a branch below rather than a `case`: the switch
      // reads `event.key`, and matching a "." label is exactly the
      // label-vs-`code` mis-match the registry matcher exists to end.
      const cancelChord = isCancelChordEvent(event);
      const consumes =
        cancelChord ||
        event.key === "Enter" ||
        event.key === "Tab" ||
        event.key === "Escape" ||
        event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "PageDown" ||
        event.key === "PageUp" ||
        event.key === "Home" ||
        event.key === "End";
      if (consumes) event.stopPropagation();
      if (cancelChord) {
        event.preventDefault();
        cancelCompletion(view);
        return true;
      }
      switch (event.key) {
        case "Enter": {
          event.preventDefault();
          acceptCompletionAt(view);
          return true;
        }
        case "Tab": {
          event.preventDefault();
          // Tab descends into a highlighted directory (keeps the
          // session alive, query becomes `dir/`); on anything else —
          // or a second Tab on an already-descended directory — it
          // accepts like Enter.
          if (!descendIntoDirectory(view)) {
            acceptCompletionAt(view);
          }
          return true;
        }
        case "Escape": {
          event.preventDefault();
          cancelCompletion(view);
          return true;
        }
        case "ArrowDown": {
          event.preventDefault();
          if (event.metaKey && !event.shiftKey && !event.altKey && !event.ctrlKey) {
            navigateCompletion(view, "last");
          } else {
            navigateCompletion(view, "down");
          }
          return true;
        }
        case "ArrowUp": {
          event.preventDefault();
          if (event.metaKey && !event.shiftKey && !event.altKey && !event.ctrlKey) {
            navigateCompletion(view, "first");
          } else {
            navigateCompletion(view, "up");
          }
          return true;
        }
        case "PageDown": {
          event.preventDefault();
          navigateCompletion(view, { delta: PAGE_STEP });
          return true;
        }
        case "PageUp": {
          event.preventDefault();
          navigateCompletion(view, { delta: -PAGE_STEP });
          return true;
        }
        case "Home": {
          event.preventDefault();
          navigateCompletion(view, "first");
          return true;
        }
        case "End": {
          event.preventDefault();
          navigateCompletion(view, "last");
          return true;
        }
        default:
          return false;
      }
    },
  }),
);

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

/**
 * Build the typeahead extension bundle. The `getProviders` thunk is
 * read at every transaction so callers can swap providers across
 * renders without rebuilding the editor.
 *
 * Returns:
 *   - the typeahead `StateField`
 *   - a `transactionExtender` that detects trigger insertions and
 *     refreshes the query on every transaction (the only path that
 *     can dispatch effects without nesting inside `update`)
 *   - the `ViewPlugin` that manages the per-view subscriber set and
 *     the async-provider subscription lifecycle
 *   - the active-only keymap
 */
export function tugCompletionExt(
  getProviders: () => Record<string, CompletionProvider>,
): Extension {
  return [
    completionField,
    EditorState.transactionExtender.of((tr) =>
      completionExtender(tr, getProviders),
    ),
    completionPlugin.of(getProviders),
    tugCompletionKeymap,
  ];
}
