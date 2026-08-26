/**
 * TugPromptEntry — Compound composition: TugTextEditor + the Z4A leading
 * slot (the command picker) + submit/stop button, driven by a
 * CodeSessionStore snapshot.
 *
 * Composes TugTextEditor (CM6-backed editor + atom + completion + drop),
 * the Z4A command-picker slot, and TugPushButton (submit/stop). Each
 * composed child keeps its own tokens [L20]; the entry reuses existing
 * base-tier global / field / badge tokens per [D11].
 *
 * Input model ([P01] route demotion): Code is the only resting mode. The
 * prompt entry always targets Claude on the record; every other
 * destination (shell, btw, find, changes, history) is reached
 * per-submission via a slash command, a chord, or a chrome affordance.
 * Return inserts a newline; Shift+Return (or the Z5 button) submits. One
 * draft per entry, persisted across reloads via the existing tugbank
 * pipeline; the persisted `route` field is pinned to Code so the Code
 * history provider recalls it ([P11]).
 *
 * Laws: [L02] useSyncExternalStore for store state, [L06] appearance
 *       via CSS/DOM, [L07] handlers read state via refs, [L11]
 *       controls emit actions, [L15] token-driven states, [L16]
 *       pairings declared, [L19] component authoring guide, [L20]
 *       token sovereignty, [L22] direct DOM writes for high-frequency
 *       updates, [L23] [L24] state preservation lives on the entry,
 *       not the substrate.
 * Decisions: [D-T3-06] submit is interrupt, [D-T3-07] queue during turn,
 *            [D-T3-09] 1:1 card↔store.
 */

import "./tug-prompt-entry.css";

import { TugEntryShell } from "./tug-entry-shell";

import React, {
  useCallback,
  useContext,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  ArrowUp,
  GitCommitHorizontal,
  MessageSquareText,
  Plus,
  Square,
} from "lucide-react";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

import { cn } from "@/lib/utils";
import type {
  AtomSegment,
  CompletionProvider,
  DropHandler,
  HistoryProvider,
  TugTextEditingState,
} from "@/lib/tug-text-types";
import { TUG_ATOM_CHAR } from "@/lib/tug-atom-img";
import { mintLeadingCommandAtom } from "@/lib/command-atom";
import type {
  CardSessionMode,
  CodeSessionPhase,
  CodeSessionStore,
} from "@/lib/code-session-store";
import { useLifecycleState } from "@/lib/code-session-store/hooks/use-lifecycle-state";
import type { SessionMetadataStore } from "@/lib/session-metadata-store";
import type { PromptHistoryStore } from "@/lib/prompt-history-store";

import {
  TugTextEditor,
  type TugTextEditorDelegate,
} from "./tug-text-editor";
import type {
  ArgumentHintRefreshSource,
  ArgumentHintResolver,
} from "./tug-text-editor/argument-hint-extension";
import type { PastedCommandResolver } from "./tug-text-editor/clipboard-filters";
import {
  clearDropCaret,
  dropOffsetAtCoords,
  markEditorDropActive,
  paintDropCaret,
  processAttachmentFiles,
} from "./tug-text-editor/drop-extension";
import type { InlineCommandMatcher } from "@/lib/inline-command-ghost";
import {
  addAtomsEffect,
  getAtomsInState,
  regenerateAtomsEffect,
  removeAtomById,
  replaceAtomsEffect,
  type PositionedAtom,
} from "./tug-text-editor/atom-decoration";
import {
  setWaveCaretActive,
  waveCaretExtension,
} from "./tug-text-editor/wave-caret";
import { TugAttachmentPreview } from "./cards/tug-attachment-preview";
import { TugChoiceGroup } from "./tug-choice-group";
import { TugProgressIndicator } from "./tug-progress-indicator";
// Tug-authored, not lucide's: the sparkles have to be addressable to twinkle.
import { PencilSparkles } from "./tug-icons";
import { TugPushButton } from "./tug-push-button";
import { TugTooltip } from "./tug-tooltip";
import { TugActionTooltip } from "./tug-action-tooltip";
import { TugConfirmPopover } from "./tug-confirm-popover";
import { resolveSubmitButtonView } from "./tug-prompt-entry-submit-button";
import type { SessionSubmitButtonMode } from "@/lib/code-session-store/lifecycle-state";
import type { ShellSessionStore } from "@/lib/shell-session-store";
import { useResponder } from "./use-responder";
import { useKeybindings } from "./use-keybindings";
import type { KeyBinding } from "./keybinding-map";
import { commandShortcut, keymapRegistry } from "./keymap-registry";
import type { ActionEvent } from "./responder-chain";
import { TUG_ACTIONS } from "./action-vocabulary";
import { useResponderChain } from "./responder-chain-provider";
import {
  buildSlashCommandLine,
  type CommandLineAtom,
  matchLocalSlashCommand,
  slashCommandName,
} from "@/lib/slash-commands";
import {
  isHiddenSlashCommand,
  isUnknownRemoteCommand,
  resolveRemoteCommand,
  canonicalizeBareCommandLine,
} from "@/lib/slash-supported";
import { useCardStatePreservation, useCardId } from "./use-card-state-preservation";
import { useCardDirty } from "../chrome/tug-pane";
import { DeckManagerContext } from "@/deck-manager-context";
import { selectionGuard } from "./selection-guard";
import { deckTrace } from "@/deck-trace";
import { getDeckStore } from "@/lib/deck-store-registry";
import { logSessionLifecycle } from "@/lib/session-lifecycle-log";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";
import type { HistoryEntry } from "@/lib/prompt-history-store";
import { subscribeAppendFailures } from "@/lib/prompt-history-api";
import { DEFAULT_ROUTE } from "@/lib/route-constants";
import type { PathCommandsStore } from "@/lib/path-commands-store";
import {
  GRADE_SUBMIT_WAIT_MS,
  type ShellGrammarStore,
  UNKNOWN_GRADE,
} from "@/lib/shell-grammar-store";
import {
  isShellCandidate,
  modelCallForBand,
  resolveSubmitDestination,
  ShellVerdictCache,
  spliceContinuations,
} from "@/lib/shell-line-classifier";
import { useSharedAgentReady } from "@/lib/shared-agent-store";
import type { ShellClassifyStore } from "@/lib/shell-classify-store";
import type { FindSession } from "@/lib/find-session";
import type { LandingKind, LandingMode } from "@/lib/landing-mode";
import { hasJotDrag, readJotDrag } from "@/lib/jot-drag";
import { resolveAtomFilePath } from "@/lib/atom-file-path";
import { rehydrateDraftAttachments } from "@/lib/attachment-upload";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";

// ---------------------------------------------------------------------------
// Module constants
// ---------------------------------------------------------------------------

/** Stable no-op `useSyncExternalStore` subscribe for an absent shell store. */
const NOOP_SUBSCRIBE = (): (() => void) => () => {};

/**
 * `event.sender` on every `selectValue` the Z4A route group dispatches.
 * Explicit rather than `useId`-derived so the entry's own responder can
 * recognize its group without threading the id through.
 */
const ROUTE_CHOICE_SENDER_ID = "tug-prompt-entry-route";

/**
 * The chrome's words, per landing kind ([P01]). The composer's controls are
 * identical for both landings; only what they are called moves, so the two
 * vocabularies sit here side by side rather than as branches at each use.
 *
 * `cancel` is read by the Changes shade's header X, which is where the cancel
 * gesture lives; everything else is read here.
 */
export const LANDING_WORDS: Record<
  LandingKind,
  {
    cancel: string;
    autoMessage: string;
    land: string;
    landUnavailable: string;
    routeTooltip: string;
    emptyHint: string;
  }
> = {
  commit: {
    cancel: "Cancel commit",
    autoMessage: "Generate a commit message",
    land: "Commit",
    landUnavailable: "Unavailable while a turn is running or the changeset is empty",
    routeTooltip: "Write a commit message",
    emptyHint: "Write a commit message, or use Auto-Message.",
  },
  join: {
    cancel: "Cancel join",
    autoMessage: "Generate a join message",
    land: "Join",
    landUnavailable: "Unavailable until the preview is clean",
    routeTooltip: "Write the join message",
    emptyHint: "Write the join message, or use Auto-Message.",
  },
};

/**
 * Empty editing state — the draft a freshly-cleared editor holds.
 * Passed to `HistoryProvider.resetToDraft` after a submit so the
 * history cursor returns to the end of the list. Read-only; never
 * mutated, so a single shared instance is safe.
 */
const EMPTY_EDIT_STATE: TugTextEditingState = {
  text: "",
  atoms: [],
  selection: null,
};

/**
 * Separator joining `sessionId` + `route` into the in-memory
 * history-provider cache key. U+001F (ASCII Unit Separator) — a
 * control character that cannot occur in a session id, so the two
 * fields can never collide on a different split. An escape sequence,
 * never a raw byte, so the source file stays plain text.
 */
const HISTORY_KEY_SEP = "\u001f";

/**
 * Upper bound, in milliseconds, between two Escape presses for them to
 * count as a double-Escape gesture. Sized for a deliberate double-tap,
 * not a key-repeat stream.
 */
const ESCAPE_DOUBLE_PRESS_MS = 400;

/**
 * Lower bound, in milliseconds, between two Escape keydowns. Presses
 * spaced tighter than this are auto-repeat from a held key, not a human
 * double-tap, and are ignored so holding Escape never fires the
 * double-Escape gesture.
 */
const ESCAPE_REPEAT_FLOOR_MS = 60;

/**
 * Debounce, in milliseconds, between a commit-message keystroke and the
 * durable `persistMessage` write ([P05]). Sized so ordinary typing coalesces
 * into a settled write, not one CONTROL frame per key.
 */
const COMMIT_PERSIST_DEBOUNCE_MS = 500;

/**
 * Quiet time, in milliseconds, before a candidate draft line is put to the
 * agent (Spec S07). Long enough that ordinary typing doesn't fire a
 * request per keystroke; short enough that the answer is usually back before
 * the user reaches for Return.
 */
const VERDICT_DEBOUNCE_MS = 300;

/**
 * How long a submit will wait for a verdict before giving up and sending the
 * line to Claude. A submit is a gesture, not a query — past this bound the
 * delay reads as the app hanging, and Claude is the safe direction for an
 * unanswered line anyway.
 *
 * One of **three** constants that must agree: `CLASSIFY_REQUEST_TIMEOUT_MS` in
 * `tugdeck/src/lib/shell-classify-store.ts` is how long a request stays
 * outstanding, and the `classify` JobSpec timeout in
 * `tugrust/crates/tugcast/src/shared_agent.rs` is tugcast's own ceiling on the
 * same call. All three bound the same user-visible pause between Return and
 * the line going somewhere, so they are the same number — lowering one
 * silently makes it the real deadline and the other two unreachable.
 */
const VERDICT_SUBMIT_WAIT_MS = 2000;

/**
 * How long a parked submit stays invisible before the Z5 button shows the
 * wave.
 *
 * The wait is normally nothing at all — the typing debounce has the verdict
 * cached by the time Return arrives — so a tell that armed on arrival would
 * flicker on every submit and mean nothing. This delay is the line between a
 * pause a person does not perceive and one they do; past it, silence is what
 * misleads, because the composer still holds the draft and still looks
 * untouched while its fate has already been decided.
 */
const ARBITRATION_REVEAL_DELAY_MS = 150;

// ---------------------------------------------------------------------------
// Preserved state shape + migration
// ---------------------------------------------------------------------------

/**
 * Preserved state payload via `useCardStatePreservation`.
 *
 * Simplified per [D08] / [Q07]=a: one route + one draft. Older payloads
 * carrying the legacy `perRoute: Record<route, TugTextEditingState>`
 * shape are migrated forward in `coerceRestorePayload`: the snapshot
 * for the persisted active route becomes `draft`, and the rest is
 * dropped.
 *
 * JSON-serializable (no DOM, no functions) — round-trips through
 * tugbank via the TugPane state preservation pipeline [L23].
 */
interface TugPromptEntryState {
  route: string;
  draft: TugTextEditingState | null;
  /**
   * Snapshot of the per-card `AtomBytesStore` — base64 image bytes
   * for atoms currently in the draft. Round-trips through the
   * `useCardStatePreservation` bag so a card that is deactivated,
   * cmd-tab'd away, or cold-booted from disk restores its in-flight
   * image attachments with bytes intact (no need to re-drop the
   * file). Optional so older persisted snapshots restore with no
   * attachment bytes (the corresponding atoms become unsubmittable
   * skeletons rather than crashes).
   *
   * Across a true reload or relaunch the entries arrive reduced to
   * references — an empty `content` and a `path` to the original on disk —
   * because `capDurableCardState` persists no image data. Rehydration reads
   * the bytes back after the restore.
   *
   * Per [D03](dash/dev-atoms.md#d03-atom-bytes-store) and
   * [L23](../../tuglaws/tuglaws.md#l23).
   */
  attachmentBytes?: Record<string, RestoredAttachmentEntry>;
}

/**
 * Legacy payload shape — prior to Step 15. Kept as an interpretive
 * type for the one-shot migration in `coerceRestorePayload`. New
 * payloads always write the simplified shape; reading the legacy
 * shape is best-effort.
 */
interface LegacyTugPromptEntryState {
  currentRoute?: string;
  perRoute?: Record<string, TugTextEditingState>;
}

/**
 * Coerce a restored payload (which may be the new simplified shape, an
 * older `{ currentRoute, perRoute }` shape, or arbitrary garbage) into
 * the canonical {@link TugPromptEntryState}.
 *
 * Migration rules:
 *   - New shape: passed through (with defensive shape narrowing).
 *   - Legacy `perRoute` shape: `perRoute[currentRoute]` becomes
 *     `draft`. Drafts for other routes are dropped per [Q07]=a.
 *   - Anything else: defaulted to `{ route: DEFAULT_ROUTE, draft: null }`.
 *
 * Exported for the unit-tests that exercise the migration path
 * without standing up the full component.
 */
export function coerceRestorePayload(raw: unknown): TugPromptEntryState {
  const fallback: TugPromptEntryState = {
    route: DEFAULT_ROUTE,
    draft: null,
  };
  if (raw === null || typeof raw !== "object") return fallback;
  const obj = raw as Partial<TugPromptEntryState> & LegacyTugPromptEntryState;
  const attachmentBytes = coerceAttachmentBytes(obj.attachmentBytes);

  // New shape — `route` + `draft` are both present.
  if (typeof obj.route === "string") {
    const draft = pruneOrphanedImageAtoms(
      isEditingState(obj.draft) ? obj.draft : null,
      attachmentBytes,
    );
    return { route: obj.route, draft, attachmentBytes };
  }

  // Legacy shape — `currentRoute` + `perRoute`.
  if (
    typeof obj.currentRoute === "string"
    && obj.perRoute !== undefined
    && typeof obj.perRoute === "object"
    && obj.perRoute !== null
  ) {
    const perRoute = obj.perRoute as Record<string, unknown>;
    const candidate = perRoute[obj.currentRoute];
    const draft = pruneOrphanedImageAtoms(
      isEditingState(candidate) ? candidate : null,
      attachmentBytes,
    );
    return { route: obj.currentRoute, draft, attachmentBytes };
  }

  return fallback;
}

/**
 * Drop image atoms whose bytes did not ride along in the same restore
 * payload, splicing out their `TUG_ATOM_CHAR` placeholders and shifting the
 * surviving atom positions + selection to match.
 *
 * An image atom is kept when its entry can still produce bytes — either it
 * carries them outright (the HMR path, where the in-memory cache brought
 * everything across) or it carries a `path` to the original tugcast stored at
 * drop time, which rehydration reads back. An entry with neither is the old
 * case and still the reason this function exists: `capDurableCardState`
 * persists no image data, so an attachment whose upload never landed restores
 * as a payload-less placeholder — a chip that would ship no image on resubmit.
 * Its atom is spliced out. What the user keeps regardless is their typed text
 * and every self-contained atom (text/file/command/doc, whose `value` IS the
 * payload and so are never pruned here). [L23].
 *
 * Returns the draft unchanged when nothing is orphaned, and `null` straight
 * through. Exported-via-coerce; a self-consistent payload where every
 * surviving image atom has bytes or a route to them is the postcondition.
 */
function pruneOrphanedImageAtoms(
  draft: TugTextEditingState | null,
  attachmentBytes: Record<string, RestoredAttachmentEntry> | undefined,
): TugTextEditingState | null {
  if (draft === null) return null;
  const hasBytes = (id: string | undefined): boolean => {
    if (id === undefined || attachmentBytes === undefined) return false;
    const entry = attachmentBytes[id];
    if (entry === undefined) return false;
    return entry.content.length > 0 || typeof entry.path === "string";
  };
  const dropPositions = draft.atoms
    .filter((a) => a.type === "image" && !hasBytes(a.id))
    .map((a) => a.position)
    .sort((x, y) => x - y);
  if (dropPositions.length === 0) return draft;

  const dropSet = new Set(dropPositions);
  let text = "";
  for (let i = 0; i < draft.text.length; i += 1) {
    if (!dropSet.has(i)) text += draft.text.charAt(i);
  }
  // Shift a surviving offset left by the count of dropped chars before it.
  const shift = (offset: number): number => {
    let n = 0;
    for (const p of dropPositions) {
      if (p < offset) n += 1;
      else break;
    }
    return offset - n;
  };
  const atoms = draft.atoms
    .filter((a) => !dropSet.has(a.position))
    .map((a) => ({ ...a, position: shift(a.position) }));
  const selection =
    draft.selection === null
      ? null
      : {
          start: shift(draft.selection.start),
          end: shift(draft.selection.end),
        };
  return { ...draft, text, atoms, selection };
}

/**
 * Defensive coercion for the persisted `attachmentBytes` map. Filters
 * out non-object payloads (corrupt persistence, schema drift) and
 * entries missing the required `content` / `mediaType` shape. Returns
 * `undefined` when the input contains zero valid entries — that
 * value round-trips through the snapshot pipeline cleanly and gates
 * `restore` from being called with an empty object.
 *
 * `path` is forwarded when present. It has to be: a durably-restored entry
 * carries nothing else — the bytes were left on disk and the path is the
 * only way back to them — so dropping it here (this function reconstructs
 * the entry field by field) would make the whole restore a silent no-op.
 */
function coerceAttachmentBytes(
  value: unknown,
): Record<string, RestoredAttachmentEntry> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const out: Record<string, RestoredAttachmentEntry> = {};
  let any = false;
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as { content?: unknown; mediaType?: unknown; path?: unknown };
    if (typeof e.content !== "string" || typeof e.mediaType !== "string") {
      continue;
    }
    out[id] =
      typeof e.path === "string" && e.path.length > 0
        ? { content: e.content, mediaType: e.mediaType, path: e.path }
        : { content: e.content, mediaType: e.mediaType };
    any = true;
  }
  return any ? out : undefined;
}

/**
 * One entry as it comes back off the durable bag: either real bytes (the HMR
 * path, where the in-memory cache carried everything) or a reference to the
 * original on disk with an empty `content`.
 */
interface RestoredAttachmentEntry {
  content: string;
  mediaType: string;
  path?: string;
}

/**
 * Defensive runtime check: does `value` look enough like a
 * `TugTextEditingState` to feed into `delegate.restoreState` without
 * crashing? Validates only the shape, not the content — a truly
 * malformed atom will surface inside the substrate's own restore
 * path.
 */
function isEditingState(value: unknown): value is TugTextEditingState {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { text?: unknown; atoms?: unknown };
  return typeof candidate.text === "string" && Array.isArray(candidate.atoms);
}

// ---------------------------------------------------------------------------
// Effective-empty helper
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the editor has no user content (zero-length
 * doc). Atoms in the editor occupy a single placeholder character
 * each, so a non-empty editor with only atoms is correctly reported
 * as non-empty by `doc.length > 0`.
 */
function isEffectivelyEmpty(view: EditorView | null): boolean {
  if (view === null) return true;
  return view.state.doc.length === 0;
}

/**
 * Build the side-question argument for a `?`-route ([P02]) submission from
 * the raw editor draft: expand atoms to their values (so an `@plan.md`
 * mention survives as its path — `buildSlashCommandLine`) and trim. An
 * empty result means a bare submit — the caller opens the overlay without
 * asking. Pure; exported for the unit tests.
 */
export function computeSideQuestionArg(
  draftText: string,
  draftAtoms: readonly CommandLineAtom[],
): string {
  return buildSlashCommandLine(draftText, draftAtoms).trim();
}

/** Disposition of a submit that arrives while the store can't accept it. */
export type BlockedSubmitDisposition = "drop" | "defer";

/**
 * Classify a *blocked* submit — one that reached `performSubmit` with
 * `canSubmit === false` and `canInterrupt === false`.
 *
 * `performSubmit` only reaches this branch in two store states:
 *  - `replaying` — the JSONL bracket owns the card. For a `resume`-mode
 *    card there is real prior content the user is watching replay; a
 *    deferred send that committed *after* replay finished would surprise
 *    them with a dispatch they don't remember initiating, so drop it
 *    (mirrors the reducer's own `handleSend` guard). → `"drop"`.
 *    A `new`-mode card has no prior content: it still flashes through
 *    `replaying` because the spawn fires `request_replay` against an
 *    absent JSONL (`replay_started → replay_complete{jsonl_missing}`),
 *    and on a cold first launch tugcode's boot widens that window. A
 *    first Shift+Return that lands inside it is a valid submission with
 *    nothing to surprise — defer it like the settling case below. → `"defer"`.
 *  - `idle` / `errored` but the transport is not yet `online` — the
 *    brief settling window on a freshly-created or reconnecting card.
 *    The submission is valid; it just landed a beat early. → `"defer"`,
 *    so the entry can re-fire it the instant `canSubmit` flips true
 *    and Shift+Return (or the button) never silently no-ops.
 *
 * Pure: keyed only on the snapshot phase + session mode. Exported for the
 * unit tests.
 */
export function classifyBlockedSubmit(
  phase: CodeSessionPhase,
  sessionMode: CardSessionMode,
): BlockedSubmitDisposition {
  return phase === "replaying" && sessionMode === "resume" ? "drop" : "defer";
}

/**
 * Build a {@link TugTextEditingState} from a `(text, atoms)` pair
 * carried on `CodeSessionSnapshot.pendingDraftRestore`. The snapshot
 * shape stores atoms positionally-implicit: `text` contains
 * {@link TUG_ATOM_CHAR} (`U+FFFC`) at each atom's spot, and `atoms` is
 * the parallel sequence of segments in document order. The substrate's
 * `restoreState` consumes the positional shape — `{ position, type,
 * label, value, id? }` per atom — so we walk `text` for placeholder
 * indices and zip them with `atoms`.
 *
 * Defensive against shape mismatches: if the placeholder count and
 * `atoms.length` don't agree, we trust the shorter sequence so a
 * malformed snapshot can't crash the editor's restore path. Selection
 * is omitted (`null`) — the caret will land at end-of-doc on restore,
 * which is the natural place for the user to continue editing after
 * an interrupted submission.
 *
 * Exported so the unit tests can pin the conversion without standing
 * up the full component.
 */
export function buildEditingStateFromDraftRestore(
  text: string,
  atoms: ReadonlyArray<AtomSegment>,
): TugTextEditingState {
  const positions: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text.charAt(i) === TUG_ATOM_CHAR) {
      positions.push(i);
    }
  }
  const pairCount = Math.min(positions.length, atoms.length);
  const positionedAtoms = Array.from({ length: pairCount }, (_, i) => {
    const segment = atoms[i]!;
    return {
      position: positions[i]!,
      type: segment.type,
      label: segment.label,
      value: segment.value,
      // Carry the bytes-store key so a restored image atom re-resolves
      // its bytes (thumbnail in the editor, payload on re-submit). The
      // bytes survive a queued-send cancel — only this linkage was lost.
      // Self-contained atoms have no `id`; the field stays undefined.
      id: segment.id,
    };
  });
  return {
    text,
    atoms: positionedAtoms,
    selection: null,
  };
}

/**
 * Compute the editing state after inserting or replacing the leading command
 * chip ([P07]). If the draft already leads with a command atom, its name is
 * swapped in place and the typed args are preserved; otherwise a `name`
 * command atom + a trailing space is inserted at document position 0 and the
 * whole existing draft becomes the args. The seed shape matches a typed /
 * completed command byte-for-byte (`TUG_ATOM_CHAR` + a space), so submit-time
 * recognition is identical. Pure; exported for unit tests.
 */
export function computeCommandChipInsert(
  current: TugTextEditingState,
  name: string,
): TugTextEditingState {
  const head = current.atoms[0];
  if (head !== undefined && head.position === 0 && head.type === "command") {
    // Replace the head command atom in place; args (the rest of the draft)
    // and the caret are untouched.
    return {
      ...current,
      atoms: [
        { ...head, label: name, value: name, id: undefined },
        ...current.atoms.slice(1),
      ],
    };
  }
  // Insert "<atom> " at position 0; shift every existing atom + the caret
  // right by the two inserted characters. The caret lands just after the
  // chip + space when the draft had no selection.
  const SHIFT = 2;
  const commandAtom = { position: 0, type: "command", label: name, value: name };
  return {
    text: `${TUG_ATOM_CHAR} ${current.text}`,
    atoms: [
      commandAtom,
      ...current.atoms.map((a) => ({ ...a, position: a.position + SHIFT })),
    ],
    selection:
      current.selection === null
        ? { start: SHIFT, end: SHIFT }
        : {
            start: current.selection.start + SHIFT,
            end: current.selection.end + SHIFT,
          },
  };
}

/**
 * Build the editor state for commit mode ([P03]): the message text, nothing
 * else — the mode lives in the entry's chrome (Z4A commit chip, Z5 rail),
 * never as a token inside the document. Pure; exported for unit tests.
 */
export function buildCommitModeState(message: string): TugTextEditingState {
  return buildEditingStateFromDraftRestore(message, []);
}

/**
 * An end-of-doc insertion — `insert` at offset `from`.
 */
export interface AppendInsertion {
  from: number;
  insert: string;
}

/**
 * Compute the end-of-doc insertion for text arriving from outside the
 * editor — today a jot dropped from the Lens with no resolvable drop
 * offset. An effectively empty editor takes the text as-is; a mid-compose
 * draft gets it appended on its own line, never clobbered.
 *
 * Pure over the doc facts and exported so the unit tests pin the insertion
 * without a live editor.
 */
export function applyAppendInsertion(
  text: string,
  doc: { length: number; isEffectivelyEmpty: boolean },
): AppendInsertion {
  const insert =
    doc.isEffectivelyEmpty || doc.length === 0 ? text : `\n${text}`;
  return { from: doc.length, insert };
}

// ---------------------------------------------------------------------------
// Props / delegate
// ---------------------------------------------------------------------------

/**
 * TugPromptEntry props interface.
 *
 * Data attributes written on the root element (all documented below with
 * `@selector` annotations):
 *
 * @selector [data-slot="tug-prompt-entry"]         — stable slot selector
 * @selector [data-responder-id]                    — from `id` (written by useResponder)
 * @selector [data-phase="idle" | "submitting" | "awaiting_first_token" |
 *                         "streaming" | "tool_work" | "awaiting_approval" |
 *                         "errored"]                — from snap.phase (React-rendered)
 * @selector [data-can-interrupt="true" | "false"]  — from snap.canInterrupt (React-rendered)
 * @selector [data-can-submit="true" | "false"]     — from snap.canSubmit (React-rendered)
 * @selector [data-errored]                         — presence when snap.lastError !== null
 * @selector [data-pending-approval]                — presence when snap.pendingApproval !== null
 * @selector [data-pending-question]                — presence when snap.pendingQuestion !== null
 * @selector [data-empty="true" | "false"]          — written from a substrate update listener
 */
export interface TugPromptEntryProps {
  /**
   * Stable responder id. Typically `${cardId}-entry`.
   * @selector [data-responder-id]
   */
  id: string;
  /**
   * Responder id that owns this entry's local slash commands — the
   * card's command-handling scope (typically `${cardId}-card-content`).
   * When a typed `/command` matches the local registry, the entry routes
   * `RUN_SLASH_COMMAND` here via `manager.sendToTarget` (by identity, so
   * it reaches the owning card regardless of where first responder sits —
   * the pane-modality contract [D15]). Omit for hosts with no local
   * commands (e.g. the gallery prompt entry); a matched command then
   * falls through to `send()` unchanged.
   */
  localCommandTargetId?: string;
  /** Store owning Claude Code turn state for this card. */
  codeSessionStore: CodeSessionStore;
  /**
   * The card's shell session store ([P12]/[P13]). Runs a shell exchange for a
   * `/shell` accelerator, a shared row's seed, or a classifier auto-route, and
   * drives the live cwd. Optional so hosts without a shell (the gallery) omit it.
   */
  shellSessionStore?: ShellSessionStore;
  /**
   * The login-PATH command set for the submit-time shell-line classifier
   * ([P08]/[P09]). Null-until-loaded → the classifier answers Code. Optional so
   * hosts without a shell (the gallery) omit it — the classifier is then a no-op.
   */
  pathCommandsStore?: PathCommandsStore;
  /**
   * The command-grammar grader tugcast serves, consulted between the PATH
   * precondition and the model ([P06]). Optional exactly as
   * {@link PromptEntryProps.pathCommandsStore} is — hosts without a shell (the
   * gallery) omit it, and an absent store grades every line `unknown`, which is
   * the pre-grader path.
   */
  shellGrammarStore?: ShellGrammarStore;
  /** The session's classify client, sharing the card's `SHELL_OUTPUT` feed. */
  shellClassifyStore?: ShellClassifyStore;
  /**
   * The host's find session — the live query, options, match set, and active
   * index for transcript search. The find bar owns the query; the entry uses
   * this only so ⌘G / ⇧⌘G cycle matches with the caret in the composer.
   * Optional so hosts without a transcript (the gallery) can omit it.
   */
  findSession?: FindSession;
  /**
   * The active landing mode ([P01]): when one is up, this entry becomes its
   * message editor — the editor content swaps to that landing's draft, Z5
   * shows cancel / auto-message / land, and submit lands instead of sending to
   * Claude. One slot, because the composer holds one document, so commit mode
   * and join mode cannot both be up. Optional; hosts without a changeset (the
   * gallery) omit it and the entry behaves exactly as before.
   */
  landingMode?: LandingMode;
  /**
   * Which landing the Changes room opens for this card — a function of what
   * the card is mated to, not of what is active right now. The segment's label
   * is invariant, so this is what its tooltip names; `landingMode.kind` cannot
   * answer it, because a mated card sitting in the prompt has no join
   * controller mounted yet. Defaults to `commit`.
   */
  changesLandingKind?: LandingKind;
  /**
   * A join is standing for this card's dash and the room is not open.
   *
   * The unread idiom: while it holds, the Changes segment wears a small accent
   * dot saying there is something in there to look at. It is the held signal
   * for the case the shade's own reveal must yield to — a running turn, a
   * half-typed composer — so the offer is never silent, only quiet.
   *
   * The host derives it per render from live facts and never remembers it, so
   * the dot cannot outlive the dash. The label does not change with it: the
   * group stays invariant in shape and in words.
   */
  changesHasOffer?: boolean;
  /**
   * Entering the Changes room, which the host must resolve: which landing a
   * card enters depends on what it is mated to, and only the host holds both
   * controllers. Leaving to the prompt is handled here, because it has to
   * persist the typed message first. Omit for hosts with no landing mode.
   */
  onEnterChanges?: () => void;
  /**
   * Host handler for an attachment that could not be accepted (drop or
   * paste of an unsupported / oversize / undecodable image, or a submit
   * attempted while an attachment is still processing). The message is
   * user-facing and names the file. Hosts surface it as a calm,
   * card-scoped notice — the Session card raises a pane bulletin — never the
   * session-error banner. Omit for standalone hosts (the gallery); the
   * message is then routed to the dev log.
   */
  onAttachmentError?: (message: string) => void;
  /** Session metadata (model name, version). Accepted for T3.4.c; unused in T3.4.b. */
  sessionMetadataStore: SessionMetadataStore;
  /** Prompt history (recall on arrow up/down). Forwarded to TugTextEditor. */
  historyStore: PromptHistoryStore;
  /**
   * Completion providers keyed by trigger character, forwarded to the
   * underlying `TugTextEditor`. Example: `{ "@": fileProvider, "/": commandProvider }`.
   * Leave undefined to disable all trigger completions.
   */
  completionProviders?: Record<string, CompletionProvider>;
  /**
   * Resolver for the post-acceptance argument placeholder, forwarded to
   * `TugTextEditor` ({@link TugTextEditorProps.argumentHintResolver}). Maps an
   * accepted command atom's value to its placeholder, or `null` for no-arg
   * commands.
   */
  argumentHintResolver?: ArgumentHintResolver;
  /**
   * Refresh source for the argument placeholder, forwarded to `TugTextEditor`
   * ({@link TugTextEditorProps.argumentHintRefresh}). Lets a slot upgrade from
   * the generic hint to the explicit one when the catalog lands late.
   */
  argumentHintRefresh?: ArgumentHintRefreshSource;
  /**
   * Resolver recognizing a slash command at the start of pasted text, forwarded
   * to `TugTextEditor` ({@link TugTextEditorProps.pastedCommandResolver}).
   */
  pastedCommandResolver?: PastedCommandResolver;
  /**
   * Matcher for the mid-text inline ghost completion, forwarded to
   * `TugTextEditor` ({@link TugTextEditorProps.inlineCommandMatcher}). Maps a
   * mid-text `/query` to the full command name it completes to, or `null`.
   */
  inlineCommandMatcher?: InlineCommandMatcher;
  /** Drop handler for dragging files from Finder. Forwarded to TugTextEditor. */
  dropHandler?: DropHandler;
  /**
   * Fires synchronously just before the input is cleared on a successful
   * submit. Distinguishes a genuine user submit from incidental empty
   * states (manual delete, undo-to-empty). Hosts use this hook to drive
   * effects that should happen ONLY on explicit submits.
   */
  onBeforeSubmit?: () => void;
  /**
   * Optional callback fired AFTER a successful submit has cleared the
   * input. Does NOT fire on the `canInterrupt` Stop branch, on
   * `canSubmit=false`, or on the empty-input guard.
   */
  onAfterSubmit?: () => void;
  /**
   * Fires when the user presses Escape while the editor is *empty*
   * (`doc.length === 0`). A host-effect hook: the entry owns no pane
   * geometry, so it just surfaces the gesture and lets the host decide
   * — the Session card collapses the entry pane to its minimum height.
   *
   * Only fires on the idle path. When a turn is in flight the entry's
   * conditional `CANCEL_DIALOG` handler claims Escape upstream (Stop ≡
   * Esc) and the keystroke never reaches the editor's keymap, so a
   * minimize can never race an interrupt. A non-empty editor falls
   * through to the editor's own Escape semantics (e.g. autocomplete
   * dismiss). Omit to disable the gesture (the gallery harness does).
   */
  onEscapeWhenEmpty?: () => void;
  /**
   * Fires on a double-Escape (two presses within
   * `ESCAPE_DOUBLE_PRESS_MS`) while the editor is *empty*. The entry
   * owns no rewind surface, so it just surfaces the gesture and lets the
   * host open it — the Session card raises the same sheet as `/rewind`.
   *
   * The single-press empty-Escape (`onEscapeWhenEmpty`) still fires on
   * the first press; this only adds the second-press action. Omit to
   * disable the gesture (the gallery harness does). Auto-repeat from a
   * held key never reaches here (see `ESCAPE_REPEAT_FLOOR_MS`).
   */
  onDoubleEscapeWhenEmpty?: () => void;
  /**
   * Fires when the editor's emptiness *changes* — once at mount to seed the
   * host's reading, then only on a transition between empty and non-empty.
   * Never per keystroke: the appearance path stays the root's `data-empty`
   * attribute ([L06] / [L22]); this is the behavior path, for hosts that
   * gate an act on a quiet composer.
   *
   * Landing-mode entry and exit swap the document, so a mode change fires
   * this the same as typing does. That is correct and deliberate — a host
   * that cares whether the *prompt* is quiet gates on landing state as well.
   */
  onEmptyChange?: (empty: boolean) => void;
  /**
   * Optional content rendered in the status row above the input.
   */
  statusContent?: React.ReactNode;
  /**
   * Optional caution content rendered on the trailing edge of the
   * status row, between the leading `statusContent` and the tools
   * toggle. Intended for a small caution affordance (e.g. the Dev
   * card's aggregate drift-caution chip). The wrapper slot collapses
   * to nothing when the content renders empty, so a
   * conditionally-visible chip leaves no gap when it has nothing to
   * show.
   */
  cautionContent?: React.ReactNode;
  /**
   * `Z4B` — the indicator slot. Optional content rendered in the
   * toolbar between the route popup (`Z4A`) and the submit
   * button (`Z5`), floated to the centre of the gap between them by a
   * pair of equal flex spacers ([D05]). Content-sized; `undefined`
   * renders an empty slot, leaving `Z4A` and `Z5` at the row's edges.
   */
  indicatorsContent?: React.ReactNode;
  /** Caller-supplied className merged with the root. */
  className?: string;
  /**
   * Soft-wrap long lines at the editor's width. Forwarded verbatim
   * to the substrate.
   * @default false
   */
  lineWrap?: boolean;
  /**
   * Show the line-numbers gutter in the embedded editor. Forwarded
   * verbatim to the substrate.
   * @default false
   */
  lineNumbers?: boolean;
  /**
   * Highlight the gutter cell of the line containing the cursor.
   * Forwarded verbatim to the substrate.
   * @default false
   */
  highlightActiveLineGutter?: boolean;
  /**
   * Manual Return-key override. When set, wins over the entry's
   * per-route default (which makes Return insert a newline on the
   * Prompt route and submit on Shell). When omitted, the
   * per-route default applies.
   *
   * Numpad Enter is always "submit" inside `tug-prompt-entry` — the
   * underlying `TugTextEditor` keeps both options as a separate
   * prop, but the entry pins it to the typical Dev use case.
   */
  returnAction?: "submit" | "newline";
  /**
   * Numpad-Enter key action — the policy for the separate numpad Enter
   * key, independent of the main Return key. `"submit"` (Enter submits,
   * Shift+Enter inserts a newline) or `"newline"` (the inverse).
   * Forwarded to `TugTextEditor`'s `numpadEnterAction`; when omitted the
   * editor's default (`"submit"`) applies.
   */
  numpadEnterAction?: "submit" | "newline";
  /**
   * Whether a surface above the entry has taken Return for its own ([P14]),
   * forwarded to `TugTextEditor`. The host sets it when it paints another
   * control as the deck's one default ring while leaving this entry live
   * beneath it — the Session card's History shade and its Done. A plain
   * Return then presses that control instead of writing a line here, so the
   * ring's promise holds from the composer too.
   */
  defaultButtonOwnsReturn?: boolean;
  /**
   * Placeholder text for the embedded editor, forwarded to
   * `TugTextEditor`. The session card supplies the Code prompt copy; the
   * gallery prompt-entry omits it (no placeholder).
   */
  placeholder?: string;
  /**
   * Genuinely deactivate the entry's editor — the editor goes read-only
   * (`EditorState.readOnly`) and is blurred so the caret stops blinking.
   * Used while an inline Permission/Question dialog is visible: the
   * dialog is modal for keys ([P06]), so the prompt must visibly stand
   * down rather than appear to still accept input. This is *real*
   * deactivation driven off the host's pending-dialog state, not a
   * cosmetic caret hack ([L06] appearance follows real state). The entry
   * reactivates (and the host re-focuses it) when the flag clears.
   */
  deactivated?: boolean;
  /**
   * Disable the ENTIRE entry — the root subtree goes `inert` (no
   * mouse, no keyboard, no focus for the editor, route toggle, chips,
   * and submit alike) and dims via `data-disabled`. Implies the
   * {@link deactivated} editor stand-down. Used while a session
   * restore replays history: nothing in the entry can act on a
   * session that does not exist yet. Distinct from `deactivated`,
   * which must leave the chips keyboard-reachable for the cycling
   * mode's walk.
   * @selector [data-slot="tug-prompt-entry"][data-disabled]
   */
  disabled?: boolean;
  /**
   * Authors the `Z5` submit button into a focus group ([P02]) — the
   * existing `TugPushButton.focusGroup` opt-in, surfaced on the entry so
   * the host that owns the Tab order can register the submit as a walk
   * stop without the entry knowing why. Omitted by default: the submit is
   * a plain native focus stop (the editor owns Tab) and never joins a walk.
   *
   * The Session card supplies this (under its keyboard-focus-cycling
   * `CycleScope`, so the registration lands in that mode, not the base
   * one) to make the submit the cycle's commit-home; the gallery and
   * card-host hosts omit it, so their submit behaves exactly as before.
   */
  submitFocusGroup?: string;
  /** Order of the submit within {@link submitFocusGroup}. Defaults to 0. */
  submitFocusOrder?: number;
  /**
   * Order of the FIRST of commit mode's three Z5 buttons — Cancel ✕,
   * Auto-Message ✎, Commit ↑ — within {@link submitFocusGroup}; the three take
   * consecutive orders from here. Commit mode replaces the single submit
   * button with this rail, and without a base the rail was unreachable by
   * keyboard: the walk ran off the Changes chip straight past three live
   * controls. Omitted by non-cycling hosts, exactly like
   * {@link submitFocusOrder}.
   */
  commitFocusOrderBase?: number;
  /**
   * Authors the `Z4A` route popup trigger into a focus group ([P02]) —
   * forwarded to the trigger `TugButton`'s `focusGroup`, surfaced on the
   * entry like {@link submitFocusGroup}. The trigger is one Tab stop;
   * activating it opens the route menu. Omitted by default (the route is
   * not a walk stop). Supplied by the Session card under its `CycleScope` so
   * the route joins the cycle as the stop after the commit-home.
   */
  routeFocusGroup?: string;
  /** Order of the route within {@link routeFocusGroup}. Defaults to 0. */
  routeFocusOrder?: number;
  /**
   * Authors the **editor input area** itself into a focus group ([P02]) as a
   * **text stop** — the last stop of the session card's keyboard-focus cycle
   * ([P10]/[P11]). When set, the editor substrate itself registers as the
   * focusable, under its responder id — so the stop carries the editor's focus
   * CONTRACT, the engine routes it `dom-granted`, and any traversal that lands
   * the key view here (Tab, ⌥⇥, an arrow) GRANTS the caret. The blinking caret
   * is the stop's whole focus indication; there is no blurred parked state and
   * nothing for a ring or wash to mark. Omitted by non-cycling hosts.
   */
  editorFocusGroup?: string;
  /** Order of the editor text-stop within {@link editorFocusGroup}. */
  editorFocusOrder?: number;
  /**
   * Authors the `Z4C` compose-phase attachment tiles into a focus group
   * ([P02]) — forwarded to `TugAttachmentPreview` so each image-attachment
   * tile registers as a leaf cycle stop (Return / Space opens its preview
   * sheet). Supplied by the Session card under its `CycleScope`; omitted by
   * non-cycling hosts, where the tiles stay plain native focus stops.
   */
  attachmentFocusGroup?: string;
  /**
   * Order of the FIRST attachment tile within {@link attachmentFocusGroup};
   * the tiles take consecutive orders left→right in document order. Defaults
   * to 0.
   */
  attachmentFocusOrderBase?: number;
  /**
   * Fired whenever the number of compose-phase image attachments changes,
   * surfacing the live tile count to the host. The Session card uses it to size
   * the attachment row of its keyboard-cycle spatial grid to exactly the
   * registered tiles. Omit when the host does not author the tiles into a
   * cycle.
   */
  onAttachmentCountChange?: (count: number) => void;
}

/**
 * Imperative handle exposed via `forwardRef`. Used by the Session card
 * to drive focus from global keyboard shortcuts.
 *
 * Methods are thin pass-throughs to the composed `TugTextEditor`'s
 * delegate. The entry does not own text state — keeping the
 * pass-through semantics honest avoids divergence between the entry's
 * imperative surface and the substrate's actual behavior.
 */
export interface TugPromptEntryDelegate {
  /** Move keyboard focus to the underlying editor element. */
  focus(): void;
  /** Remove keyboard focus from the underlying editor element. */
  blur(): void;
  /** Clear the input's content. */
  clear(): void;
  /** Whether the editor holds no user content (zero-length doc). */
  isEmpty(): boolean;
  /**
   * Insert (or replace) the leading `/<name>` command chip. A head command
   * atom is swapped in place, preserving typed args; otherwise a command atom +
   * trailing space is inserted at document position 0. Focuses the editor.
   */
  insertCommandChip(name: string): void;
  /**
   * Open the command picker ([P06]): focus the editor and, unless the draft
   * already leads with a `/` or a command atom, seed a leading `/` at
   * document position 0 so the standard completion popup opens.
   */
  openCommandPicker(): void;
  /**
   * Insert a picked file at the caret as a `file` atom — the chip an `@`
   * mention mints, with the basename as its label and the absolute path as
   * its value — and focus the editor. Additive: an in-progress draft
   * survives it.
   */
  insertFilePath(path: string): void;
  /**
   * The underlying editor element (CM6's `cm-content` div). Exposed for
   * callers that need to reach the live editor DOM (measurement, focus
   * diagnostics, harness assertions).
   */
  getEditorElement(): HTMLElement | null;
  /**
   * Regenerate atom widgets — needed when the editor font or theme
   * tokens change so the baked atom chips pick up the new
   * family/size. Forwards to the substrate's
   * `regenerateAtomsEffect` dispatch.
   */
  regenerateAtoms(): void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const TugPromptEntry = React.forwardRef<
  TugPromptEntryDelegate,
  TugPromptEntryProps
>(function TugPromptEntry(props, ref) {
  const {
    id,
    localCommandTargetId,
    codeSessionStore,
    shellSessionStore,
    pathCommandsStore,
    shellGrammarStore,
    shellClassifyStore,
    findSession,
    landingMode,
    changesLandingKind = "commit",
    changesHasOffer = false,
    onEnterChanges,
    onAttachmentError,
    sessionMetadataStore,
    historyStore,
    completionProviders,
    argumentHintResolver,
    argumentHintRefresh,
    pastedCommandResolver,
    inlineCommandMatcher,
    dropHandler,
    onBeforeSubmit,
    onAfterSubmit,
    onEscapeWhenEmpty,
    onDoubleEscapeWhenEmpty,
    onEmptyChange,
    statusContent,
    cautionContent,
    indicatorsContent,
    className,
    lineWrap,
    lineNumbers,
    highlightActiveLineGutter,
    returnAction: returnActionOverride,
    numpadEnterAction,
    defaultButtonOwnsReturn = false,
    placeholder,
    deactivated: deactivatedProp = false,
    disabled = false,
    submitFocusGroup,
    submitFocusOrder,
    commitFocusOrderBase,
    routeFocusGroup,
    routeFocusOrder,
    editorFocusGroup,
    editorFocusOrder,
    attachmentFocusGroup,
    attachmentFocusOrderBase,
    onAttachmentCountChange,
  } = props;

  // [L02] external store state enters React through useSyncExternalStore only.
  const snap = useSyncExternalStore(
    codeSessionStore.subscribe,
    codeSessionStore.getSnapshot,
  );
  // The keymap registry too ([L02]): the ⌃⌘M scoped binding and every
  // tooltip shortcut read it at render time, so a live rebind must repaint.
  useSyncExternalStore(keymapRegistry.subscribe, keymapRegistry.getSnapshot, () => 0);

  // Substrate delegate, root, and live snapshot mirror.
  const textEditorRef = useRef<TugTextEditorDelegate | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const snapRef = useRef(snap);
  useLayoutEffect(() => {
    snapRef.current = snap;
  }, [snap]);

  // Deactivation: when a modal inline dialog takes over the keyboard
  // ([P06]), the editor goes read-only (`disabled` above) *and* blurs so
  // the caret stops blinking — the prompt visibly stands down. The host
  // re-focuses the entry when `deactivated` clears (its single focus
  // destination), so no re-focus is needed here. [L06] real state, not a
  // caret paint-over.
  // `disabled` (whole-entry inert) implies the editor stand-down.
  const deactivated = deactivatedProp || disabled;
  useLayoutEffect(() => {
    if (deactivated) textEditorRef.current?.blur();
  }, [deactivated]);

  // Editor-as-text-stop ([P10]/[P11]): the editor substrate registers itself
  // into the host's cycle (`focusGroup`/`focusOrder` on `TugTextEditor` below),
  // under its own responder id — landing the key view here resolves the
  // editor's focus contract and grants the caret. No wrapper stop, no parked
  // blurred state: the blinking caret is the stop's focus indication.

  // Inline-attachment wiring. The per-card bytes-store and the
  // attachment-error publisher come from `codeSessionStore`; both are
  // stable across renders for a given store instance, so memoizing on
  // `[codeSessionStore]` is sufficient. The store handle and bound
  // callback flow through to `TugTextEditor` so the drop / paste
  // extensions can populate the side-table at insert time and surface
  // downsample-rejection messages via the existing banner channel.
  // Per [D03](dash/dev-atoms.md#d03-atom-bytes-store) and
  // [Table T01](dash/dev-atoms.md#t01-failure-modes).
  const attachmentBytesStore = useMemo(
    () => codeSessionStore.getAtomBytesStore(),
    [codeSessionStore],
  );
  // Attachment rejection is transient input validation, not a session
  // fault: it must never write `lastError` (that lights the entry's red
  // errored ring and routes the session-lost banner). Hand the message to
  // the host, which surfaces a calm card-scoped notice (the Session card
  // raises a pane bulletin). Standalone hosts that omit the handler get a
  // dev-log line so the message is never silently swallowed.
  const publishAttachmentError = useCallback(
    (message: string): void => {
      if (onAttachmentError !== undefined) {
        onAttachmentError(message);
      } else {
        tugDevLogStore.warn("prompt-entry", message);
      }
    },
    [onAttachmentError],
  );

  // Z4C — the compose-phase attachment-preview zone. The image atoms in
  // the editor are external state (CodeMirror's atom field); they enter
  // React here so the preview strip below the editor reflects every
  // drop / paste / delete. The `editorExtensions` updateListener
  // recomputes this on any doc change ([L02] — the bridge from CM state
  // into React is the listener; the strip itself is a pure projection).
  const [composeImageAtoms, setComposeImageAtoms] = useState<
    ReadonlyArray<AtomSegment>
  >([]);
  // Structural key of the current image-atom list (ids + labels) so the
  // listener only re-renders the strip when the set actually changes,
  // not on every keystroke. Held in a ref because the listener closes
  // over it once (the extension array is built with empty deps).
  const composeAtomsKeyRef = useRef("");
  const syncComposeImageAtoms = useCallback(
    (atoms: ReadonlyArray<AtomSegment>): void => {
      // The strip is always contiguous: derive `image-N` from the image's
      // position in document order, independent of the atom's stored label.
      // So the Z4C strip reads correct the instant an attachment is added
      // or removed, even before the editor's inline chips are relabeled by
      // the renumber pass below.
      const images = atoms
        .filter((a) => a.type === "image")
        .map((a, i) => {
          const name = `image-${i + 1}`;
          return a.label === name && a.value === name
            ? a
            : { ...a, label: name, value: name };
        });
      let key = "";
      for (const a of images) key += `${a.id ?? ""}|${a.label}|`;
      if (key === composeAtomsKeyRef.current) return;
      composeAtomsKeyRef.current = key;
      setComposeImageAtoms(images);
    },
    [],
  );
  // Surface the live attachment-tile count to the host ([L07] via ref so a
  // fresh inline callback never re-fires the effect). The Session card sizes its
  // keyboard-cycle spatial-grid attachment row from this, so the count must
  // track every drop / paste / delete — the same `composeImageAtoms` set the
  // Z4C strip renders.
  const onAttachmentCountChangeRef = useRef(onAttachmentCountChange);
  useLayoutEffect(() => {
    onAttachmentCountChangeRef.current = onAttachmentCountChange;
  }, [onAttachmentCountChange]);
  useLayoutEffect(() => {
    onAttachmentCountChangeRef.current?.(composeImageAtoms.length);
  }, [composeImageAtoms.length]);
  // Keep the editor's inline image chips numbered `image-1..N` in document
  // order. The Z4C strip derives its own contiguous numbering, but the
  // inline chips store their label in the atom field, so a delete or a
  // mid-insert can leave them stale; this corrects them in one follow-up
  // transaction. Idempotent — re-reads fresh state and dispatches only
  // when a label is actually wrong, so it never loops.
  const renumberImageChips = useCallback((view: EditorView): void => {
    if (!view.dom.isConnected) return;
    const positioned = getAtomsInState(view.state);
    let n = 0;
    let changed = false;
    const corrected: PositionedAtom[] = positioned.map((p) => {
      if (p.segment.type !== "image") return p;
      n += 1;
      const name = `image-${n}`;
      if (p.segment.label === name && p.segment.value === name) return p;
      changed = true;
      return {
        position: p.position,
        segment: { ...p.segment, label: name, value: name },
      };
    });
    if (changed) view.dispatch({ effects: replaceAtomsEffect.of(corrected) });
  }, []);
  // Remove a draft attachment by atom id: drop its atom from the editor
  // doc (the updateListener then refreshes the strip) and free its
  // bytes-store entry. The bytes `delete` is the store's documented
  // pre-submit cleanup path. This is the responder side of [L11] — the
  // prompt-entry owns the editor document and bytes store, so it handles
  // the `REMOVE_ATTACHMENT` action the preview's controls dispatch.
  const handleRemoveAttachmentById = useCallback(
    (atomId: string): void => {
      const view = textEditorRef.current?.view();
      if (view !== null && view !== undefined) {
        removeAtomById(view, atomId);
      }
      attachmentBytesStore.delete(atomId);
    },
    [attachmentBytesStore],
  );

  // The WHOLE prompt entry is ONE continuous drop surface. The editor
  // substrate claims drags over its own host (`drop-extension.ts` attaches
  // host-level listeners, so the blank band below short content accepts
  // too); these entry-level handlers catch everything else — the
  // attachment strip, the toolbar, the status row, the gaps — and route
  // the drop through the same editor pipeline, mirroring the image-paste
  // path. Events the substrate already claimed arrive here with
  // `defaultPrevented` set and are left alone, so the two layers compose
  // without double handling. The visual cues are the editor's own: the
  // drop ring on the editor host (`markEditorDropActive`) plus the drop
  // caret at the resolved position — the coordinate clamps to the nearest
  // document position, so a drop over the toolbar lands at the bottom
  // row. All DOM writes, no React state ([L06]).
  //
  // Two payloads land here: a file drag (images become atoms, other files
  // their basename) and a Lens jot drag ([P05]) — the same accept ring
  // and drop caret for both, so a jot reads exactly like an image over
  // the entry.
  const handleEntryDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      if (event.defaultPrevented) return;
      const dt = event.dataTransfer;
      if (!dt.types.includes("Files") && !hasJotDrag(dt)) return;
      const view = textEditorRef.current?.view();
      if (view === null || view === undefined) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      markEditorDropActive(view, true);
      paintDropCaret(view, event.clientX, event.clientY);
    },
    [],
  );
  const clearEntryDropState = useCallback((): void => {
    const view = textEditorRef.current?.view();
    if (view === null || view === undefined) return;
    markEditorDropActive(view, false);
    clearDropCaret(view);
  }, []);
  const handleEntryDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      // Ignore leave events that merely cross into a descendant — only
      // clear when the pointer truly exits the entry. A native
      // Escape-cancel fires dragleave with a null relatedTarget, so this
      // also tears down the caret on cancel.
      const next = event.relatedTarget as Node | null;
      if (next !== null && event.currentTarget.contains(next)) return;
      clearEntryDropState();
    },
    [clearEntryDropState],
  );
  const handleEntryDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      if (event.defaultPrevented) return;
      const jotText = readJotDrag(event.dataTransfer);
      const files = Array.from(event.dataTransfer.files);
      if (jotText === null && files.length === 0) return;
      const view = textEditorRef.current?.view();
      if (view === null || view === undefined) return;
      event.preventDefault();
      if (jotText !== null) {
        // Park the text on the store's slot; the `pendingJotInsert`
        // effect below owns the insertion (drop offset, else the
        // `applyAppendInsertion` append) for both this drag and the
        // double-click-a-jot path.
        clearEntryDropState();
        codeSessionStore.insertJot(jotText, {
          x: event.clientX,
          y: event.clientY,
        });
        return;
      }
      // Resolve the drop against the editor's measured layout, same as a
      // drop on the editor itself. The chrome sits outside the document,
      // so the coordinate clamps to the nearest position — the bottom row
      // — letting the user target it instead of dumping at a stale caret.
      const pos =
        dropOffsetAtCoords(view, event.clientX, event.clientY) ??
        view.state.doc.length;
      clearEntryDropState();
      void processAttachmentFiles(
        view,
        files,
        pos,
        attachmentBytesStore,
        publishAttachmentError,
      );
    },
    [
      attachmentBytesStore,
      publishAttachmentError,
      clearEntryDropState,
      codeSessionStore,
    ],
  );

  // Session ▸ Insert File… (⌘I). The host picked the path; this is the
  // insertion. It reads exactly like accepting an `@` mention — a `file`
  // atom plus a separating space, one transaction — except the label is
  // the basename while the value stays the absolute path the panel
  // returned, so the chip is legible and the submitted prompt is
  // unambiguous. The atom is additive: an in-progress draft survives it.
  const insertFilePath = useCallback((path: string): void => {
    const editor = textEditorRef.current;
    const view = editor?.view();
    if (view === null || view === undefined) return;
    const basename = path.split("/").pop();
    const segment: AtomSegment = {
      kind: "atom",
      type: "file",
      label: basename === undefined || basename === "" ? path : basename,
      value: path,
    };
    const { from, to } = view.state.selection.main;
    const hasTrailingSpace = view.state.doc.sliceString(to, to + 1) === " ";
    view.dispatch({
      changes: {
        from,
        to,
        insert: hasTrailingSpace ? TUG_ATOM_CHAR : `${TUG_ATOM_CHAR} `,
      },
      effects: addAtomsEffect.of([{ position: from, segment }]),
      selection: { anchor: from + 2 },
      scrollIntoView: true,
      userEvent: "input.tug-atom",
    });
    editor?.focus();
  }, []);

  // The absolute path behind a file chip, for the substrate's "Open in
  // Editor" item. An `@` mention's value is project-root-relative (that is
  // what the file index reports) while the open handler speaks absolute
  // only, so the roots the mention could have been written against are
  // read live at right-click time [L07] — the binding and the cwd both
  // arrive after mount, and a resolver frozen at mount would open nothing
  // on the first turn.
  const atomPathCardId = useCardId();
  const resolveAtomPath = useCallback(
    (value: string): string =>
      resolveAtomFilePath(value, {
        projectDir:
          atomPathCardId === null
            ? null
            : cardSessionBindingStore.getBinding(atomPathCardId)?.projectDir ??
              null,
        cwd: sessionMetadataStore.getSnapshot().cwd,
      }),
    [atomPathCardId, sessionMetadataStore],
  );

  // Z5 submit-button state machine. The button's whole view — label,
  // icon, `disabled`, `data-mode` — is a pure function of the
  // lifecycle-derived `submitButtonMode` (six kinds: submit / stop /
  // awaiting-user / stopping / reconnecting / restoring). Reading it
  // through `useLifecycleState` keeps the matrix the single source of
  // truth ([L02]); `resolveSubmitButtonView` is the pure projection.
  // The mode is mirrored to a ref so `performSubmit` — the shared
  // keyboard + pointer submit path — can gate on it without going
  // stale ([L07]).
  // Claude-lifecycle mode + shell in-flight; combined into the route-aware Z5
  // mode below, once the subscribed `route` is available ([P13]).
  const claudeSubmitButtonMode =
    useLifecycleState(codeSessionStore).submitButtonMode;
  const shellInflight = useSyncExternalStore(
    shellSessionStore?.subscribe ?? NOOP_SUBSCRIBE,
    () => shellSessionStore?.getSnapshot().inflight != null,
  );

  // Draft restore. Two store actions populate `pendingDraftRestore`:
  // a CASE A interrupt pulling a pre-content turn back to re-edit, and
  // a queued-send cancel un-sending a mid-turn submission. Either way
  // the store captures the prompt onto `snap.pendingDraftRestore`;
  // this effect observes the slot's identity, seeds the editor, and
  // dispatches `consumePendingDraftRestore` so the slot clears in the
  // next snapshot — the restore applies exactly once even if the
  // parent re-renders.
  //
  // The editor is seeded ONLY when it is empty: a cancel must never
  // clobber a draft the user is composing. A CASE A pull-down always
  // lands on an empty editor (it was cleared at submit), so the guard
  // is a no-op there; a queued-send cancel can fire while the user is
  // mid-compose, and there the slot is dropped — consumed but not
  // applied.
  //
  // [L02] state enters via the snap from useSyncExternalStore.
  // [L03] useLayoutEffect ensures the doc replacement is visible in
  // the same paint as the snapshot transition (no flash of an empty
  // editor between cancel and restore).
  // [L07] the effect reads the substrate delegate via the ref so a
  // late mount doesn't lose its restore — the slot survives until
  // consumed, so a re-mount after the slot was set still seeds the
  // editor on its first effect tick.
  const restoreSlot = snap.pendingDraftRestore;
  useLayoutEffect(() => {
    if (restoreSlot === null) return;
    const editor = textEditorRef.current;
    if (editor === null) return;
    if (isEffectivelyEmpty(editor.view() ?? null)) {
      editor.restoreState(
        buildEditingStateFromDraftRestore(restoreSlot.text, restoreSlot.atoms),
      );
    }
    codeSessionStore.consumePendingDraftRestore();
  }, [restoreSlot, codeSessionStore]);

  // Code is the only resting mode ([P01]); prompt history keys entries by
  // this scalar and the Code provider recalls only these ([P11]).
  const route = DEFAULT_ROUTE;

  // ── Commit mode ([P03]) ─────────────────────────────────────────────────
  // While active this entry is the commit-message editor — the document IS
  // the message (no routing chip; the mode lives in the chrome), Z5 shows
  // cancel / auto-message / commit, and submit lands the commit. The whole
  // mode rides one subscribable snapshot ([L02]); the live message is read on
  // demand (submit / cancel / auto-message / debounced save) rather than
  // mirrored, so no per-keystroke React state is introduced ([L22]).
  const landingSnap = useSyncExternalStore(
    landingMode?.subscribe ?? NOOP_SUBSCRIBE,
    () => landingMode?.getSnapshot() ?? null,
  );
  const landingActive = landingSnap?.active === true;
  const landingDrafting = landingActive && landingSnap?.draftPhase === "drafting";
  const inLandingModeRef = useRef(false);
  const prevLandingActiveRef = useRef(false);
  const landingModeRef = useRef(landingMode);
  landingModeRef.current = landingMode;
  const landingSnapRef = useRef(landingSnap);
  landingSnapRef.current = landingSnap;
  const commitDraftingRef = useRef(landingDrafting);
  commitDraftingRef.current = landingDrafting;
  // Mirror `active` for the CANCEL_DIALOG responder (built fresh each render,
  // but read a ref so the handler never sees a stale flag): while commit mode
  // is up, Escape / Cmd-. dismiss the mode, never a running turn.
  const landingActiveRef = useRef(landingActive);
  landingActiveRef.current = landingActive;
  // The in-progress prompt stashed on mode entry, restored verbatim on exit —
  // opening Changes over a typed draft never clobbers it ([P03]).
  const preCommitDraftRef = useRef<TugTextEditingState | null>(null);
  const [commitConfirmOpen, setCommitConfirmOpen] = useState(false);
  // The land confirm's open flag ([P05], [L22]) — local because it is a
  // transient of *this* press and nothing outside the composer has any use for
  // it. The sentence it asks comes from the landing snapshot; only whether it
  // is up lives here.

  // Read the live commit message — the document verbatim.
  const readCommitMessage = useCallback((): string => {
    const view = textEditorRef.current?.view() ?? null;
    if (view === null) return "";
    return view.state.doc.toString();
  }, []);

  // Debounced durable save of the in-progress message ([P05]): every genuine
  // user edit schedules a `persistMessage` write, so uncommitted edits survive
  // a card deactivation / reload (the write rides the changeset draft engine,
  // whose `entry.draft.message` is the source of truth). Fired from the editor
  // update listener, so it lives outside React ([L22]).
  const commitPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearCommitPersistTimer = useCallback(() => {
    if (commitPersistTimerRef.current !== null) {
      clearTimeout(commitPersistTimerRef.current);
      commitPersistTimerRef.current = null;
    }
  }, []);
  const scheduleCommitPersist = useCallback(() => {
    clearCommitPersistTimer();
    commitPersistTimerRef.current = setTimeout(() => {
      commitPersistTimerRef.current = null;
      const controller = landingModeRef.current;
      if (controller === undefined || !inLandingModeRef.current) return;
      controller.persistMessage(readCommitMessage());
    }, COMMIT_PERSIST_DEBOUNCE_MS);
  }, [clearCommitPersistTimer, readCommitMessage]);
  const commitPersistRef = useRef(scheduleCommitPersist);
  commitPersistRef.current = scheduleCommitPersist;
  useLayoutEffect(() => clearCommitPersistTimer, [clearCommitPersistTimer]);

  // Editor swap on the active transition ([L03] so the doc change lands in
  // the same paint as the mode flip). Enter: stash the current prompt draft,
  // then replace the composer with the seed message — the message alone; the
  // mode's dress is chrome, not document content. Exit: restore the stashed
  // draft (the `/commit` slash path clears the composer first, so that stash is
  // empty; ⌃⌘C over a typed prompt stashes and restores it). The message itself
  // is durable in the changeset draft store, so a cancel/re-enter resumes it.
  useLayoutEffect(() => {
    const editor = textEditorRef.current;
    if (editor === null) return;
    const prev = prevLandingActiveRef.current;
    prevLandingActiveRef.current = landingActive;
    if (landingActive && !prev) {
      inLandingModeRef.current = true;
      preCommitDraftRef.current = editor.captureState();
      // Borrow the composer's current rendered height: a switch to commit mode
      // over a tall, in-progress prompt swaps the doc to the (usually empty)
      // commit message, which would collapse the editor to its floor and jump
      // the layout. Measured BEFORE the swap and pinned as the scroller's
      // min-height for the mode's duration (cleared on exit), so a quick glance
      // at Changes leaves the entry height put ([L06] — DOM, not React state).
      const scroller = editor.view()?.scrollDOM ?? null;
      const borrowedHeight = scroller?.getBoundingClientRect().height ?? 0;
      const seed =
        landingSnapRef.current?.seedMessage ??
        landingSnapRef.current?.persistedMessage ??
        "";
      editor.restoreState(buildCommitModeState(seed));
      if (scroller !== null && borrowedHeight > 0) {
        scroller.style.minHeight = `${Math.round(borrowedHeight)}px`;
      }
      // Seed the `data-commit-empty` gate explicitly: an empty seed over an
      // empty doc fires no update, so the listener alone can't be trusted to
      // refresh it on entry.
      rootRef.current?.setAttribute(
        "data-commit-empty",
        String(seed.trim().length === 0),
      );
      editor.focus();
    } else if (!landingActive && prev) {
      inLandingModeRef.current = false;
      clearCommitPersistTimer();
      const restored = preCommitDraftRef.current ?? EMPTY_EDIT_STATE;
      preCommitDraftRef.current = null;
      editor.restoreState(restored);
      // Drop the borrowed-height floor: the restored draft sizes the editor by
      // its own content again (that content is what set the borrowed height, so
      // this reverts seamlessly).
      const exitScroller = editor.view()?.scrollDOM ?? null;
      if (exitScroller !== null) exitScroller.style.minHeight = "";
      rootRef.current?.setAttribute("data-commit-empty", "true");
      editor.view()?.dispatch({ effects: setWaveCaretActive.of(false) });
      editor.focus();
    }
  }, [landingActive, clearCommitPersistTimer]);

  // Auto-Message stream ([P06]): the scribe's draft fills the editor live while
  // `drafting`. The editor is read-only
  // for the duration (so the user can't interfere), and a wave caret rides the
  // stream's tail in place of the (suppressed) native caret. On settle
  // (`drafting → ready`) the generated message becomes editable; on a cancel
  // (`→ idle`) or failure (`→ error`) the field reverts to the persisted
  // pre-draft message. Either way the caret is re-claimed and the wave cleared.
  const prevLandingDraftPhaseRef = useRef(landingSnap?.draftPhase ?? "idle");
  // The message being replaced, captured at drafting start so the whole
  // generation collapses to one undo step ([P06]).
  const preDraftMessageRef = useRef("");
  useLayoutEffect(() => {
    const phase = landingSnap?.draftPhase ?? "idle";
    const prevPhase = prevLandingDraftPhaseRef.current;
    prevLandingDraftPhaseRef.current = phase;
    if (!landingActive) return;
    const editor = textEditorRef.current;
    if (editor === null) return;
    const streamState = buildCommitModeState(landingSnap?.draftText ?? "");
    if (phase === "drafting") {
      // Stream ephemerally — no per-delta undo events; the settle folds the
      // whole generation into one. On the first delta, remember what we're
      // replacing and light the wave caret.
      if (prevPhase !== "drafting") {
        preDraftMessageRef.current = readCommitMessage();
        editor.restoreState(streamState, { addToHistory: false });
        editor.view()?.dispatch({ effects: setWaveCaretActive.of(true) });
      } else {
        editor.restoreState(streamState, { addToHistory: false });
      }
      // Follow the wave caret at the tail so the newest text stays in view as
      // it streams (a no-op while the message fits). Reset to the top on settle.
      const view = editor.view();
      if (view !== null) view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
    } else if (prevPhase === "drafting") {
      editor.view()?.dispatch({ effects: setWaveCaretActive.of(false) });
      if (phase === "ready") {
        // One undo for the whole thing: revert to the pre-draft message with no
        // history event, then apply the final message as the single recorded
        // edit — so ⌘Z removes the generated message and ⌘⇧Z restores it.
        editor.restoreState(buildCommitModeState(preDraftMessageRef.current), {
          addToHistory: false,
        });
        editor.restoreState(buildCommitModeState(landingSnap?.draftText ?? ""));
        // Show the START of the generated message, not its tail.
        const view = editor.view();
        if (view !== null) view.scrollDOM.scrollTop = 0;
      } else {
        // Cancel / error: revert to the persisted message, leaving no undo
        // trace (the ephemeral stream never entered history).
        editor.restoreState(buildCommitModeState(landingSnap?.persistedMessage ?? ""), {
          addToHistory: false,
        });
      }
      editor.focus();
    }
  }, [
    landingActive,
    landingSnap?.draftPhase,
    landingSnap?.draftText,
    landingSnap?.persistedMessage,
    readCommitMessage,
  ]);

  // Exit commit mode (Cancel button, the Z4A commit chip, Escape): persist the
  // typed message so a re-entry resumes it, then exit. Land-success exits
  // through the controller's own path (which clears the draft first), so it
  // never routes here — the persist below only ever runs on a user cancel.
  const exitCommitMode = useCallback(() => {
    landingModeRef.current?.leave();
  }, []);

  // The composer owns the document, so it is the only thing that can read the
  // typed message — hand the controller that read so a door OUTSIDE the
  // composer (⌘F, which leaves Changes) persists the draft the same way
  // Cancel and the Z4A tab do.
  useLayoutEffect(() => {
    if (landingMode === undefined) return;
    landingMode.setMessageProvider(() => readCommitMessage());
    return () => landingMode.setMessageProvider(null);
  }, [landingMode, readCommitMessage]);

  // Auto-Message ([P06]): a typed message is protected by the Replace confirm;
  // an empty field drafts straight away. Read the editor live rather than the
  // persisted `edited` flag so unsaved typing is guarded too.
  const handleCommitAutoMessage = useCallback(() => {
    const controller = landingModeRef.current;
    if (controller === undefined) return;
    // Already streaming — the button is lit but inert; ignore a re-trigger.
    if (commitDraftingRef.current) return;
    // A non-empty message is guarded by the Replace confirm; an empty field
    // regenerates straight away — and always FORCES, so the [P03] edited-gate
    // (a prior edit pins `edited=true`) never swallows a repeat request. This
    // is what makes Auto-Message repeatable across edit/clear/redo cycles.
    if (readCommitMessage().trim().length > 0) setCommitConfirmOpen(true);
    else controller.requestDraft(true);
  }, [readCommitMessage]);

  // Cancel an in-flight Auto-Message draft ([P06]) — the Z5 cancel button,
  // Escape, or Cmd-. while the scribe streams. Aborts only the scribe child
  // (never the session's turn); the terminal `cancelled` state reverts the
  // composer and drops the wave caret. Distinct from `exitCommitMode`, which
  // exits the whole mode when nothing is drafting.
  const cancelCommitDraft = useCallback(() => {
    landingModeRef.current?.cancelDraft();
  }, []);

  // ⌃⌘M invokes Auto-Message ([P06]) while commit mode is up — the keyboard
  // twin of the pencil-sparkles button.
  //
  // A scoped binding rather than a raw capture listener, and the difference is
  // not stylistic: a listener that claims a chord out of the DOM is invisible
  // to `resolveChord`, to the keymap pane, and to the collision lint, so
  // nothing could tell you ⌃⌘M was taken until you pressed it. Registered
  // here, it is live exactly while this responder is on the first-responder
  // walk and while commit mode is up, and the chord itself comes from the
  // command's registry entry rather than being spelled again.
  //
  // ⌃⌘A / ⌃⇧⌘A ride the same gate for the same reason: the Changes shade is
  // passive, so the composer keeps focus while it is up. They are HANDLED on
  // the session card, which is the component that holds `changesController` —
  // an action this responder does not claim falls through to the card below
  // it on the chain.
  const commitKeybindings = useMemo<KeyBinding[]>(() => {
    if (!landingActive) return [];
    const COMMIT_SCOPED_COMMANDS = [
      TUG_ACTIONS.COMMIT_AUTO_MESSAGE,
      TUG_ACTIONS.CLAIM_ALL_CHANGES,
      TUG_ACTIONS.DISCLAIM_ALL_CHANGES,
    ] as const;
    return COMMIT_SCOPED_COMMANDS.flatMap((commandId) =>
      keymapRegistry.bindingsOf(commandId).map((b) => ({
        key: b.chord.key,
        ...(b.chord.ctrl === true ? { ctrl: true } : {}),
        ...(b.chord.meta === true ? { meta: true } : {}),
        ...(b.chord.shift === true ? { shift: true } : {}),
        ...(b.chord.alt === true ? { alt: true } : {}),
        action: commandId,
        commandId,
        preventDefaultOnMatch: b.preventDefault === true,
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landingActive, keymapRegistry.getSnapshot()]);
  useKeybindings(commitKeybindings);

  // Command insert ([P03]/[P04]). A click on a known slash command in the
  // transcript parks `{ name, args }` on the code-session store; this
  // effect observes the slot, seeds the editor with the atomized command —
  // a leading command atom (`name`) plus the trailing argument text —
  // focuses, and consumes. Unlike draft restore, the seed is UNCONDITIONAL
  // (no empty-guard): a click is an explicit intent to run this command,
  // and a command atom must lead at document position 0 to expand as a user
  // invocation, so `restoreState` replaces any in-progress draft. The seed
  // shape matches a typed command — `TUG_ATOM_CHAR` + a trailing space
  // (+ args) — so a clicked command is byte-identical to one accepted from
  // the `/` completion. Mirrors the share effect: [L02] slot via
  // useSyncExternalStore; [L03] useLayoutEffect so the doc change lands in
  // one paint; the slot survives until an editor exists (no consume on a
  // missing view) so a click is never silently dropped.
  const pendingCommandInsert = snap.pendingCommandInsert;
  useLayoutEffect(() => {
    if (pendingCommandInsert === null) return;
    const editor = textEditorRef.current;
    if (editor === null) return;
    const { name, args } = pendingCommandInsert;
    editor.restoreState(
      buildEditingStateFromDraftRestore(`${TUG_ATOM_CHAR} ${args}`, [
        { kind: "atom", type: "command", label: name, value: name },
      ]),
    );
    editor.focus();
    codeSessionStore.consumePendingCommandInsert();
  }, [pendingCommandInsert, codeSessionStore]);

  // Jot insert ([P05]). A jot dragged from the Lens onto the prompt
  // entry (or double-clicked) parks `{ text, at }` here; this effect inserts
  // the text — at the drop offset when `at` resolves, else appended (empty
  // editor takes it as-is, non-empty on a new line, the
  // `applyAppendInsertion` rule) — then consumes. [L02] slot via the
  // snapshot; [L03] useLayoutEffect so the doc change lands in one paint; the
  // slot survives until an editor exists (no consume on a missing view) so a
  // drop is never silently dropped.
  //
  // No focus claim: a drop inserts content and leaves activation and focus
  // where the user left them (focus-language.md § Drag and the keyboard).
  // The dispatched `selection` records the insertion point; it becomes the
  // visible caret when the editor is next granted focus legitimately.
  const pendingJotInsert = snap.pendingJotInsert;
  useLayoutEffect(() => {
    if (pendingJotInsert === null) return;
    const editor = textEditorRef.current;
    const view = editor?.view() ?? null;
    if (editor === null || view === null) return;
    const { text, at } = pendingJotInsert;
    const offset = at !== null ? dropOffsetAtCoords(view, at.x, at.y) : null;
    let from: number;
    let insert: string;
    if (offset !== null) {
      from = offset;
      insert = text;
    } else {
      const appended = applyAppendInsertion(text, {
        length: view.state.doc.length,
        isEffectivelyEmpty: isEffectivelyEmpty(view),
      });
      from = appended.from;
      insert = appended.insert;
    }
    view.dispatch({
      changes: { from, insert },
      selection: { anchor: from + insert.length },
      scrollIntoView: true,
    });
    codeSessionStore.consumePendingJotInsert();
  }, [pendingJotInsert, codeSessionStore]);

  // Atom insert. A transcript annotation inserted as an atom parks its
  // segment here; this effect drops the atom at the caret and consumes.
  // The insertion is additive (never a `restoreState`) — an atom is one
  // more thing the prompt mentions, so an in-progress draft survives it.
  // [L02] slot via the snapshot; [L03] useLayoutEffect so the doc change
  // lands in one paint; the slot survives until an editor exists so the
  // gesture is never silently dropped.
  const pendingAtomInsert = snap.pendingAtomInsert;
  useLayoutEffect(() => {
    if (pendingAtomInsert === null) return;
    const editor = textEditorRef.current;
    if (editor === null) return;
    editor.insertAtom(pendingAtomInsert);
    editor.focus();
    codeSessionStore.consumePendingAtomInsert();
  }, [pendingAtomInsert, codeSessionStore]);

  // Code's Z5 button follows the Claude session lifecycle unchanged.
  const submitButtonMode = claudeSubmitButtonMode;
  const submitView = resolveSubmitButtonView(submitButtonMode);
  // The chord that fires the Z5, when a plain Return does not
  // ([#chord-ring]). The editor's Return is a user setting shipping as
  // `newline`, and `resolveEnterAction` flips the base action on Shift — so at
  // the default it is SHIFT+Return that submits, and the shell's default ring
  // has to say so. `undefined` (the `submit` setting) omits the attribute and
  // leaves the ring solid, which is then true.
  const submitChord =
    (returnActionOverride ?? "newline") === "newline" ? "shift" : undefined;
  // The same chord spelled for a tooltip bubble. Authored rather than read
  // from the registry, and deliberately so: the composer's submit key is the
  // editor's own Return, text-editing currency handled by the CM6 keymap
  // rather than a registry command ([#non-goals]) — there is no binding to
  // read. Deriving it from `submitChord` is what keeps the bubble and the
  // shell's default ring from ever disagreeing about which key submits.
  const submitChordLabel = submitChord === "shift" ? "⇧⏎" : "⏎";
  const submitButtonModeRef = useRef(submitButtonMode);
  useLayoutEffect(() => {
    submitButtonModeRef.current = submitButtonMode;
  }, [submitButtonMode]);

  // Per-route history providers. One provider per route — each holds
  // its own cursor + in-memory "return to draft" cache, so the user's
  // browsing position in history survives route switches. Providers
  // are created lazily and persist for the lifetime of the entry mount.
  useSyncExternalStore(
    historyStore.subscribe,
    historyStore.getSnapshot,
  );

  // History keys on the session's id. The provider cache is keyed by
  // `${sessionId}${HISTORY_KEY_SEP}${route}` so a route change for the same
  // session reuses the cached provider (preserving its cursor + draft
  // state).
  const historyProvidersRef = useRef<Record<string, HistoryProvider>>({});
  const currentHistoryProvider = useMemo<HistoryProvider>(() => {
    const sessionId = snap.tugSessionId;
    const cacheKey = `${sessionId}${HISTORY_KEY_SEP}${route}`;
    const cached = historyProvidersRef.current[cacheKey];
    if (cached) return cached;
    const fresh = historyStore.createRouteProvider(sessionId, route);
    historyProvidersRef.current[cacheKey] = fresh;
    logSessionLifecycle("history.provider_create", {
      session_id: sessionId,
      route,
    });
    return fresh;
  }, [historyStore, route, snap.tugSessionId]);

  // Re-seed the per-card bytes store from stored history attachments so a
  // recalled prompt shows its image previews even after a cold launch — the
  // bytes are ephemeral and per-card, but the entry carries the path of the
  // original tugcast stored at drop time. This is structure-zone store→store
  // wiring ([L24]): observe the history store's own subscription directly
  // and mutate the bytes store in the callback ([L22]) — not a
  // `useSyncExternalStore` → `useEffect` round-trip. The effect re-subscribes
  // on a session change, so the callback never reads a stale id ([L07]).
  // Gaps only: a live id whose full bytes are still present is never
  // clobbered.
  //
  // Every image atom gets a marker, path-bearing or not. Seeding only the
  // path-bearing ones would leave `attachmentBytesStore.get(id) === null` for
  // the rest, and the submit gate reads that as "still processing" — which
  // would block a recalled prompt from ever being sent again.
  //
  // A marker with a path is then handed to rehydration, which reads the
  // original back and replaces it with real bytes — the difference between a
  // recalled prompt that merely shows what was attached and one that can be
  // resubmitted.
  useLayoutEffect(() => {
    const sessionId = snap.tugSessionId;
    if (sessionId.length === 0) return;
    const reseed = (): void => {
      const seeded: Record<string, { content: string; mediaType: string; path?: string }> = {};
      for (const entry of historyStore.getSessionEntries(sessionId)) {
        for (const atom of entry.atoms) {
          if (atom.type !== "image" || atom.id === undefined) continue;
          if (attachmentBytesStore.get(atom.id) !== null) continue;
          attachmentBytesStore.put(atom.id, {
            content: "",
            mediaType: "",
            path: atom.path,
          });
          if (atom.path !== undefined) {
            seeded[atom.id] = { content: "", mediaType: "", path: atom.path };
          }
        }
      }
      // After every marker is in place, never during — rehydration re-reads
      // the store to decide whether the atom is still live.
      if (Object.keys(seeded).length > 0) {
        rehydrateDraftAttachments(seeded, attachmentBytesStore);
      }
    };
    reseed();
    return historyStore.subscribe(reseed);
  }, [historyStore, attachmentBytesStore, snap.tugSessionId]);

  // Late-upload backfill for the pathless atoms of a just-submitted prompt.
  // A drop's upload can land after the submit that recorded it, so the stored
  // row holds an image atom with no path — recall would show a severed
  // attachment. Each registration watches the bytes store until every id it
  // was given has a path, patches the stored row through the history store,
  // and unsubscribes itself. One-shot per atom; a card that closes first
  // simply drops the watch, and the route treats a missing row as a no-op.
  const atomPathWatchesRef = useRef<Set<() => void>>(new Set());
  const registerAtomPathBackfill = useCallback(
    (clientEntryId: string, atomIds: readonly string[]): void => {
      if (atomIds.length === 0) return;
      const outstanding = new Set(atomIds);
      let unsubscribe: (() => void) | null = null;
      const stop = (): void => {
        if (unsubscribe === null) return;
        const fn = unsubscribe;
        unsubscribe = null;
        atomPathWatchesRef.current.delete(fn);
        fn();
      };
      const check = (): void => {
        for (const id of [...outstanding]) {
          const path = attachmentBytesStore.get(id)?.path;
          if (path === undefined) continue;
          outstanding.delete(id);
          historyStore.patchAtomPath(clientEntryId, id, path);
        }
        if (outstanding.size === 0) stop();
      };
      unsubscribe = attachmentBytesStore.subscribe(check);
      atomPathWatchesRef.current.add(unsubscribe);
      // The upload may already have landed between the submit and here.
      check();
    },
    [attachmentBytesStore, historyStore],
  );

  // Drop every outstanding watch when the entry unmounts.
  useLayoutEffect(() => {
    const watches = atomPathWatchesRef.current;
    return () => {
      for (const unsubscribe of watches) unsubscribe();
      watches.clear();
    };
  }, []);

  // An append that has outlived its fast retry rungs is the user's prompt not
  // yet on disk. Say so through the card's notice channel rather than letting
  // the retry grind on invisibly ([L31]) — the ladder keeps going either way.
  useLayoutEffect(
    () =>
      subscribeAppendFailures((notice) => {
        const excerpt =
          notice.text.length > 60 ? `${notice.text.slice(0, 60)}…` : notice.text;
        publishAttachmentError(
          `Prompt history isn't saving — still retrying "${excerpt}".`,
        );
      }),
    [publishAttachmentError],
  );

  // Live ref to the active route's history provider so `performSubmit`
  // can reset its cursor without taking `currentHistoryProvider` as a
  // dep (which would churn `performSubmit`'s identity on every route
  // switch). [L07]
  const currentHistoryProviderRef = useRef(currentHistoryProvider);
  useLayoutEffect(() => {
    currentHistoryProviderRef.current = currentHistoryProvider;
  }, [currentHistoryProvider]);

  // Live refs for `onBeforeSubmit` / `onAfterSubmit` so an inline
  // closure passed by the host doesn't churn `performSubmit`'s
  // identity. [L07]
  const onBeforeSubmitRef = useRef(onBeforeSubmit);
  useLayoutEffect(() => {
    onBeforeSubmitRef.current = onBeforeSubmit;
  }, [onBeforeSubmit]);
  const onAfterSubmitRef = useRef(onAfterSubmit);
  useLayoutEffect(() => {
    onAfterSubmitRef.current = onAfterSubmit;
  }, [onAfterSubmit]);
  // Live ref for the empty-Escape gesture. The editor keymap below is
  // captured at mount (empty-deps memo), so it must read the current
  // callback through a ref rather than closing over the prop. [L07]
  const onEscapeWhenEmptyRef = useRef(onEscapeWhenEmpty);
  useLayoutEffect(() => {
    onEscapeWhenEmptyRef.current = onEscapeWhenEmpty;
  }, [onEscapeWhenEmpty]);
  const onDoubleEscapeWhenEmptyRef = useRef(onDoubleEscapeWhenEmpty);
  useLayoutEffect(() => {
    onDoubleEscapeWhenEmptyRef.current = onDoubleEscapeWhenEmpty;
  }, [onDoubleEscapeWhenEmpty]);
  // Live ref for the emptiness-transition callback, for the same reason the
  // Escape refs above exist: the substrate extensions are captured at mount
  // and cannot read a prop that changes identity later. [L07]
  const onEmptyChangeRef = useRef(onEmptyChange);
  useLayoutEffect(() => {
    onEmptyChangeRef.current = onEmptyChange;
  }, [onEmptyChange]);
  // The last emptiness the host was told about — the transition filter, so a
  // keystroke inside a non-empty document reports nothing.
  const lastReportedEmptyRef = useRef<boolean | null>(null);
  const reportEmptiness = useCallback((empty: boolean) => {
    if (lastReportedEmptyRef.current === empty) return;
    lastReportedEmptyRef.current = empty;
    onEmptyChangeRef.current?.(empty);
  }, []);
  // Timestamp (performance.now) of the previous Escape keydown, used by
  // the editor keymap to recognise a double-Escape and reject auto-repeat.
  const lastEscapePressAtRef = useRef(0);
  // Forces the just-cleared draft durable the moment a double-Escape
  // empties the editor. Held in a ref because the mount-time keymap memo
  // is captured before `persistClearedDraft` is defined [L07].
  const persistClearedDraftRef = useRef<() => void>(() => {});

  // Card id for diagnostic deck-trace events. Held in a ref so the
  // onRestore closure (registered through useCardStatePreservation)
  // reads the current value at fire time per [L07].
  const cardIdForTrace = useCardId();
  const cardIdForTraceRef = useRef(cardIdForTrace);
  cardIdForTraceRef.current = cardIdForTrace;

  // Dirty-pipeline participation. `useCardDirtyState` only marks the card
  // dirty on host-level `scroll` / `selectionchange`; the editor must mark
  // itself on every doc change so a typed character, a dropped/pasted atom,
  // or an undo schedules the debounced durable save — rather than relying
  // on an incidental selection event to do it. Stable callback (no-op
  // outside a `CardHost`, e.g. the gallery); held in a ref so the mount-time
  // editor extension reads the live value at fire time [L07].
  const markDirty = useCardDirty();
  const markDirtyRef = useRef(markDirty);
  markDirtyRef.current = markDirty;

  // Deck store + card id, read at submit time to force the cleared draft
  // durable the instant a turn is sent (see `performSubmit`). Held through
  // refs so the `performSubmit` closure never goes stale [L07]. Both are
  // absent in the gallery / unit-test mounts, where submit just skips the
  // forced flush.
  const deckStore = useContext(DeckManagerContext);
  const deckStoreRef = useRef(deckStore);
  deckStoreRef.current = deckStore;

  // Find session, held in a ref so the mount-time editor extension (which
  // mirrors the query on every doc change while in the Find route) reads the
  // live value at fire time [L07]. Absent in hosts without a transcript.
  const findSessionRef = useRef(findSession);
  findSessionRef.current = findSession;

  // Helper: route the embedded substrate's selection through
  // selectionGuard for the inactive-paint channel.
  const publishToSelectionGuard = useCallback((range: Range | null): void => {
    const id = cardIdForTraceRef.current;
    if (id === null) return;
    selectionGuard.updateCardDomSelection(id, range);
  }, []);

  // Shell routing is live only when the shared-agent store says the agent can
  // answer AND the tenant's kill switch is on. Mirrored to a ref because the
  // extension closures below run per keystroke and must never re-render for
  // this ([L07]); when it is false every entry point short-circuits and the
  // surface behaves exactly as a build with no model at all ([P12]).
  const shellRoutingReady = useSharedAgentReady("shell-routing");
  const shellRoutingReadyRef = useRef(shellRoutingReady);
  shellRoutingReadyRef.current = shellRoutingReady;

  // Verdicts for candidate lines, plus the request currently on the wire.
  // Non-render state by construction: a verdict arriving must not repaint the
  // composer, it only settles where the next submit goes ([L06]).
  const verdictCacheRef = useRef(new ShellVerdictCache());
  const pendingVerdictRef = useRef<{
    text: string;
    promise: Promise<"shell" | "prompt" | null>;
  } | null>(null);
  const verdictDebounceRef = useRef<number | null>(null);
  // A submit parked at one of the bounded waits below owns the draft; a second
  // Return during that window would run the same line twice — and a wrongly
  // re-run command cannot be un-run.
  const submitArbitratingRef = useRef(false);
  // Set by Escape while a submit is parked. Nothing has been executed or sent
  // at that point — only decided — so the submission can still be taken back
  // whole, which is what makes the pending state an honest one.
  const arbitrationWithdrawnRef = useRef(false);
  const arbitrationRevealRef = useRef<number | null>(null);

  // Show the wait, but only once it is a wait worth showing. The typing
  // debounce normally has the verdict cached by Return, so the common path
  // resolves in a frame or two — revealing on arrival would strobe the button
  // on every submit. Past the delay the pause is perceptible, and then saying
  // nothing is the lie: the composer would sit there looking idle while the
  // draft's fate is already decided elsewhere.
  const setArbitrating = useCallback((on: boolean): void => {
    if (arbitrationRevealRef.current !== null) {
      window.clearTimeout(arbitrationRevealRef.current);
      arbitrationRevealRef.current = null;
    }
    const paint = (busy: boolean): void => {
      const root = rootRef.current;
      if (root === null) return;
      const button = root.querySelector<HTMLElement>(
        ".tug-prompt-entry-submit-button",
      );
      if (button === null) return;
      // The button's own activity vocabulary (`TugButtonActivity`) — written
      // as an attribute rather than passed as the `activity` prop, because
      // the prop would mean a render of the whole composer for a transient
      // that is usually gone in two frames.
      if (busy) button.setAttribute("data-tug-activity", "busy");
      else button.removeAttribute("data-tug-activity");
      button.setAttribute("aria-busy", String(busy));
    };
    if (!on) {
      paint(false);
      return;
    }
    arbitrationRevealRef.current = window.setTimeout(() => {
      arbitrationRevealRef.current = null;
      paint(true);
    }, ARBITRATION_REVEAL_DELAY_MS);
  }, []);

  // The debounce and reveal timers are acquisitions; a pending one is
  // released at unmount so it cannot fire into stores — or a DOM node — the
  // card has already torn down [L27].
  useLayoutEffect(
    () => () => {
      if (verdictDebounceRef.current !== null) {
        window.clearTimeout(verdictDebounceRef.current);
        verdictDebounceRef.current = null;
      }
      if (arbitrationRevealRef.current !== null) {
        window.clearTimeout(arbitrationRevealRef.current);
        arbitrationRevealRef.current = null;
      }
    },
    [],
  );

  // Substrate-level extensions installed at mount time. The
  // data-empty sync writes through a ref-tracked root element —
  // stable across renders. Extension array is captured by the
  // substrate at mount; subsequent identity changes don't propagate
  // (per the substrate's `extensions` prop contract), so we wrap in
  // `useMemo` with empty deps to avoid churn.
  const editorExtensions = useMemo(
    () => [
      // data-empty bridge: keep the entry root's `data-empty`
      // attribute in sync with `view.state.doc.length === 0`.
      // Direct DOM write per [L06] / [L22] — no React re-render on
      // every keystroke.
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        // Every doc change is a draft edit — schedule the debounced durable
        // save. This is the editor's entry into the dirty pipeline; without
        // it the draft is only persisted when an incidental scroll /
        // selectionchange happens to fire (e.g. a programmatic atom insert
        // that doesn't move the global selection would otherwise not save).
        markDirtyRef.current();
        const root = rootRef.current;
        if (root !== null) {
          root.setAttribute(
            "data-empty",
            String(update.state.doc.length === 0),
          );
        }
        // Behavior path alongside the attribute: hosts that gate on a quiet
        // composer hear the transition, never the keystroke.
        reportEmptiness(update.state.doc.length === 0);
        // Z4C bridge: refresh the compose-phase attachment strip from the
        // editor's live atom set. Cheap structural-key gate inside.
        const positioned = getAtomsInState(update.state);
        syncComposeImageAtoms(positioned.map((p) => p.segment));
        // Commit mode ([P03]): the document is the message. Mirror its
        // emptiness to the root (`data-commit-empty` CSS-gates the Commit
        // button, [L22]) and schedule a debounced durable save of real edits —
        // skipping our own programmatic seeds / scribe stream (guarded on a
        // user event + non-drafting phase).
        if (inLandingModeRef.current) {
          const message = update.state.doc.toString();
          if (root !== null) {
            root.setAttribute(
              "data-commit-empty",
              String(message.trim().length === 0),
            );
          }
          // Same edge, told to the controller: the Session ▸ Commit Changes
          // gate is a menu fact, and the menu cannot read a DOM attribute.
          landingModeRef.current?.notifyMessageChanged();
          const drafting = landingSnapRef.current?.draftPhase === "drafting";
          const userEdit = update.transactions.some(
            (tr) => tr.isUserEvent("input") || tr.isUserEvent("delete"),
          );
          if (!drafting && userEdit) commitPersistRef.current();
        }
        // Renumber inline image chips if a delete / mid-insert left them
        // out of document order. Cheap synchronous check; the correcting
        // dispatch is deferred to a microtask so it doesn't re-enter the
        // in-flight update.
        let ord = 0;
        let mismatch = false;
        for (const p of positioned) {
          if (p.segment.type !== "image") continue;
          ord += 1;
          if (p.segment.label !== `image-${ord}`) {
            mismatch = true;
            break;
          }
        }
        if (mismatch) {
          const view = update.view;
          queueMicrotask(() => renumberImageChips(view));
        }
        // Verdicts belong to the draft being composed, not to the session:
        // an emptied editor (clear, select-all-delete, or the teardown at
        // the end of a submit) is where they go.
        if (update.state.doc.length === 0) {
          verdictCacheRef.current.clear();
          shellGrammarStoreRef.current?.clear();
          shellClassifyStoreRef.current?.clear();
          pendingVerdictRef.current = null;
        }

        // Pre-consult the agent on candidate lines while the user types,
        // so a verdict is usually already cached by the time Return arrives —
        // submit-time is far too late to start a multi-hundred-millisecond
        // round trip. Debounced: a verdict is only worth asking for once the
        // line has stopped changing.
        if (update.docChanged) {
          if (verdictDebounceRef.current !== null) {
            window.clearTimeout(verdictDebounceRef.current);
            verdictDebounceRef.current = null;
          }
          const doc = update.state.doc;
          if (
            shellRoutingReadyRef.current &&
            positioned.length === 0 &&
            doc.length > 0 &&
            doc.length <= 256
          ) {
            // Warmed on the same spliced line submit will grade, so a draft
            // written across backslash continuations arrives with its answer
            // already cached rather than paying the round trip at Return.
            const text = spliceContinuations(doc.sliceString(0).trim()) ?? "";
            if (
              text.length > 0 &&
              verdictCacheRef.current.get(text) === undefined &&
              isShellCandidate(
                text,
                pathCommandsStoreRef.current?.getSnapshot() ?? null,
              )
            ) {
              verdictDebounceRef.current = window.setTimeout(() => {
                verdictDebounceRef.current = null;
                // Grade alongside the classify request, not before it. Both
                // round trips run concurrently, so the grade is warm by submit
                // without ever putting its latency in front of the model's.
                //
                // This request is also what warms the agent: the first job of a
                // class spawns that class's worker, and a cold spawn costs more
                // than the whole submit budget. Asking here means the spawn is
                // paid while somebody is still typing.
                void shellGrammarStoreRef.current?.request(text);
                const store = shellClassifyStoreRef.current;
                const promise =
                  store === undefined
                    ? Promise.resolve(null)
                    : store.request(text);
                pendingVerdictRef.current = { text, promise };
                void promise.then((verdict) => {
                  if (verdict !== null) verdictCacheRef.current.set(text, verdict);
                  if (pendingVerdictRef.current?.text === text) {
                    pendingVerdictRef.current = null;
                  }
                });
              }, VERDICT_DEBOUNCE_MS);
            }
          }
        }
      }),
      // Empty-Escape gesture. On an empty editor, Escape surfaces
      // `onEscapeWhenEmpty` so the host can collapse the entry pane.
      // Gated on `doc.length === 0`: a non-empty editor returns `false`
      // so Escape falls through to the editor's own handlers
      // (autocomplete dismiss, etc.). Host-supplied extensions sit
      // below the substrate's keymap precedence, so by the time Escape
      // reaches here the typeahead / completion layers have already
      // had their turn — and none of those can be open on an empty
      // doc, which is why the empty gate is sufficient.
      keymap.of([
        {
          key: "Escape",
          run: (view) => {
            const now = performance.now();
            const sinceLast = now - lastEscapePressAtRef.current;
            lastEscapePressAtRef.current = now;

            // Reject auto-repeat from a held key: presses tighter than the
            // floor are the OS key-repeat stream, never a human double-tap.
            // Fall through inertly — the first (non-repeat) press already
            // ran its single-press action, and nothing else owns Escape on
            // the now-settled doc.
            if (sinceLast < ESCAPE_REPEAT_FLOOR_MS) return false;

            // A submit parked on the shell/Claude decision is the most
            // salient thing Escape can address, so it claims the key: the
            // submission is withdrawn and the draft stays put. The press is
            // spent here and not paired with the next one — withdrawing and
            // then clearing the draft is two gestures, never one.
            if (submitArbitratingRef.current) {
              arbitrationWithdrawnRef.current = true;
              lastEscapePressAtRef.current = 0;
              return true;
            }

            const isEmpty = view.state.doc.length === 0;
            const isDoublePress = sinceLast <= ESCAPE_DOUBLE_PRESS_MS;

            if (isDoublePress) {
              // Reset so a third press can't pair with this second one.
              lastEscapePressAtRef.current = 0;
              if (!isEmpty) {
                // Double-Escape on a non-empty editor clears the draft.
                // The clear is a normal transaction (undoable via Cmd+Z),
                // and the emptied draft is forced durable at once so a
                // relaunch can't restore the just-cleared text.
                textEditorRef.current?.clear();
                persistClearedDraftRef.current();
                return true;
              }
              // Double-Escape on an empty editor surfaces the rewind
              // gesture (the Session card raises the same sheet as `/rewind`).
              const onDoubleEscape = onDoubleEscapeWhenEmptyRef.current;
              if (onDoubleEscape === undefined) return false;
              onDoubleEscape();
              return true;
            }

            // Single press. On an empty editor, surface `onEscapeWhenEmpty`
            // so the host can collapse the entry pane. A non-empty editor
            // returns `false` so Escape falls through to the editor's own
            // handlers (autocomplete dismiss, etc.) — none of which can be
            // open on an empty doc, which is why the empty gate is enough.
            if (!isEmpty) return false;
            const onEscape = onEscapeWhenEmptyRef.current;
            if (onEscape === undefined) return false;
            onEscape();
            return true;
          },
        },
      ]),
      // Empty-Tab gesture, the movement twin of empty-Escape above. An empty
      // composer has nothing to indent, so Tab is better spent moving the
      // keyboard — and where it moves is the card's own focus cycle, entered
      // at the editor's seat in it, so this is the CARD's Tab order rather
      // than a second one. The field keeps owning the key (the
      // `data-tug-tab-consume` marker stands); it just spends it differently.
      // Non-empty, or no host: `false` falls through and indents.
      //
      // `Prec.high` puts this ahead of the substrate's `indentWithTab` (default
      // precedence) but still behind the `Prec.highest` typeahead popup and
      // inline ghost, which claim Tab while they are showing. Neither can be
      // open on an empty doc, which is why the empty gate is sufficient here
      // for the same reason it is for Escape.
      // Lowest-precedence Escape catch-all. The handlers above return
      // `false` on the paths that should fall through (a single non-empty
      // Escape lets the completion layer dismiss; an auto-repeat tick is
      // ignored). When nothing downstream claims Escape either, the
      // keystroke would reach the OS unhandled and WebKit sounds the
      // system beep. Swallowing it here — after the completion keymap has
      // had its turn — keeps Escape silent without stealing the
      // completion-dismiss gesture.
      Prec.lowest(keymap.of([{ key: "Escape", run: () => true }])),
      // Auto-Message wave caret ([P06]): inert until `setWaveCaretActive`
      // toggles it while the scribe streams the commit draft.
      waveCaretExtension,
    ],
    [],
  );

  // A submit that landed during the transport-settling window is
  // armed here and flushed by the effect below the moment `canSubmit`
  // flips true. See `classifyBlockedSubmit` + `performSubmit`'s
  // blocked-submit branch.
  const pendingSubmitRef = useRef(false);

  // Live refs so `performSubmit` (a stable callback) reads the shell + PATH
  // stores without widening its dep list ([L07]).
  const shellSessionStoreRef = useRef(shellSessionStore);
  shellSessionStoreRef.current = shellSessionStore;
  const pathCommandsStoreRef = useRef(pathCommandsStore);
  pathCommandsStoreRef.current = pathCommandsStore;
  const shellGrammarStoreRef = useRef(shellGrammarStore);
  shellGrammarStoreRef.current = shellGrammarStore;
  const shellClassifyStoreRef = useRef(shellClassifyStore);
  shellClassifyStoreRef.current = shellClassifyStore;

  // Card-scoped dispatch for locally-handled slash commands. A bare
  // `/command` matching the local registry is routed to the host-supplied
  // `localCommandTargetId` responder — THIS card's command-owning scope —
  // so the owning card opens the command's surface, instead of being sent
  // to claude. The prompt entry stays generic: it knows the command
  // *shape* via the pure matcher and the target *by id*, not what any
  // command does ([D23], [#step-1c]).
  //
  // Routing to a captured target id via `sendToTarget` — NOT
  // `sendToKeyCard` — is load-bearing for pane modality ([D15]): the key
  // card is derived from the GLOBAL first responder, so a pane-modal sheet
  // open in another pane (which holds first responder there) makes that
  // pane's card the key card. A `/rewind` typed here would then be handled
  // by the OTHER pane's card, hijacking its sheet. The prompt entry
  // belongs to exactly one card; the command must run on THAT card, by
  // identity, regardless of where focus sits app-wide. (The card-content
  // responder is reached by DOM-subtree search from the key card, not by
  // the prompt entry's parentId chain — it is a registry *sibling*, not an
  // ancestor — so a parent-targeted control dispatch can't reach it; the
  // host hands us its id explicitly. See responder-chain.md §"The four
  // dispatch shapes" → cascade-target pattern.)
  const manager = useResponderChain();
  const localCommandTargetIdRef = useRef(localCommandTargetId);
  localCommandTargetIdRef.current = localCommandTargetId;

  // Force the just-cleared draft durable immediately after a submit.
  // `editor.clear()` empties the doc, but the debounced save that would
  // persist the cleared state is up to SAVE_DEBOUNCE_MS out, and WKWebView
  // fires no `beforeunload` / `visibilitychange` on quit — so a relaunch in
  // that window would otherwise restore the just-submitted message from the
  // stale pre-submit bag. Flushing here closes the window regardless of the
  // quit path. No-op in the gallery / unit-test mounts (no deck store or
  // card id). [L23].
  const persistClearedDraft = useCallback(() => {
    const store = deckStoreRef.current;
    const cardId = cardIdForTraceRef.current;
    if (store?.flushCardStateNow !== undefined && cardId !== null) {
      store.flushCardStateNow(cardId);
    }
  }, []);
  persistClearedDraftRef.current = persistClearedDraft;

  // Shared submit logic. Invoked by both the SUBMIT chain-action
  // handler (button click, Cmd+Enter, etc.) and the Return /
  // Shift+Return keyboard path (via the substrate's `onSubmit`).
  // Single closure means keyboard and pointer converge on the same
  // interrupt-vs-send decision and the same clear-and-route teardown.
  //
  // Stable identity (`useCallback` with deps that are themselves
  // stable — `codeSessionStore` is a prop reference); policy is read
  // through refs so the closure never goes stale [L07].
  // Async only for the one branch that can wait on an agent verdict; an
  // async function body runs synchronously up to its first `await`, so every
  // other path through this callback settles in the same tick it always did.
  const performSubmit = useCallback(async (): Promise<void> => {
    const editor = textEditorRef.current;
    const view = editor?.view() ?? null;
    const snap = snapRef.current;
    if (editor === null || view === null) return;

    // Landing mode: submit lands the commit or the join instead of sending to
    // Claude. The message is the document verbatim; success clears the draft
    // and exits the mode (the active-transition effect clears the editor).
    // Nothing else in this function runs.
    //
    // A refused land leaves the draft intact and surfaces its own sentence
    // ([L31]) — the outcome is read here so the refusal is a value this path
    // received rather than a branch it never saw.
    if (inLandingModeRef.current) {
      const outcome = landingModeRef.current?.land(view.state.doc.toString());
      if (outcome?.kind === "refused") {
        tugDevLogStore.debug("prompt-entry", "land refused", { sentence: outcome.sentence });
      }
      return;
    }

    // Submit-while-completing: if the completion popup is open with a
    // highlighted item, accept it FIRST so a submit made via the button or
    // Shift+Return commits the *completed* command / `@`-mention, not the
    // typed fragment (e.g. `/re` + Enter would otherwise send `/re`, not
    // `/rewind`). The keyboard accept (plain Enter / Tab) lives in the
    // completion keymap; this is the seam for submit paths that bypass it.
    // The accept dispatches synchronously, so the draft reads below see the
    // inserted atom. Applies uniformly to `/` commands and `@` mentions.
    editor.acceptActiveCompletion();

    // Slash-command interception ([D23], [#step-1c]). Accepting any
    // slash-command suggestion inserts a `type:"command"` atom and dismisses
    // the popup — uniform for every command. The local-vs-remote split is
    // made HERE, at submit: a command whose name is in the local registry
    // opens its surface (dispatch `RUN_SLASH_COMMAND` to the key card's
    // card-content responder); everything else (a claude command atom, plain
    // text) flows on to `send()` unchanged. The command line is recognized in
    // either form — a bare `/name` typed without the popup, or a lone
    // accepted command atom (the U+FFFC placeholder is the only text). Runs
    // BEFORE the send-readiness gates (matching `Shift+Tab`, not gated on
    // `canSubmit`); if no responder handles the dispatch (a host with no
    // card-content handler, e.g. the gallery), fall through to `send()`.
    if (!isEffectivelyEmpty(view)) {
      const draftAtoms = getAtomsInState(view.state);
      const draftText = editor.captureState().text;
      // Reconstruct a plain `/command …` line even when the draft carries
      // atoms — a leading command atom or `@`/file mentions in the argument
      // (e.g. `/compact prepare @plan.md`) — by expanding each atom in place
      // (command → `/name`, file/doc/link → its path/value, image dropped).
      // A draft that doesn't lead with a slash command won't match the
      // registry, so non-command drafts are unaffected.
      const commandLine: string = buildSlashCommandLine(draftText, draftAtoms);
      // One namespace: the local slash-command registry (`/model`, `/shell`,
      // `/rewind`, …), dispatched to the card responder. An arbitrary claude
      // slash command falls through to `send()`, and a non-command draft
      // matches nothing, so plain prose — a leading `!` included — is
      // untouched.
      const localCommand = matchLocalSlashCommand(commandLine);
      const targetId = localCommandTargetIdRef.current;
      if (
        localCommand !== null &&
        manager !== null &&
        targetId !== undefined &&
        // Guard the `sendToTarget` throw-on-unregistered contract, and
        // confirm the target actually owns RUN_SLASH_COMMAND before we
        // route (else fall through to send, never silently swallow).
        manager.nodeCanHandle(targetId, TUG_ACTIONS.RUN_SLASH_COMMAND)
      ) {
        // The draft substrate rides along with the flattened match: a
        // surface that echoes its command into the transcript as a real
        // submission (`/compact`) rebuilds the user's chips from it —
        // `commandLine` alone has already lost them to plain text.
        const handled = manager.sendToTarget(targetId, {
          action: TUG_ACTIONS.RUN_SLASH_COMMAND,
          value: { ...localCommand, draft: { text: draftText, atoms: draftAtoms } },
          phase: "discrete",
        });
        if (handled) {
          // Record the command in per-session history so ↑ recalls it,
          // exactly like a sent message (the dispatch consumed the draft,
          // but the user still typed and submitted a line).
          const sessionId = snapRef.current.tugSessionId;
          historyStore.push({
            id: `${sessionId}-${Date.now()}`,
            sessionId,
            projectPath: "",
            route,
            text: commandLine,
            atoms: [],
            timestamp: Date.now(),
          });
          editor.clear();
          // Submitting (even a recalled entry) returns the history
          // cursor to the end of the list — next ↑ starts from the most
          // recent entry, including this one.
          currentHistoryProviderRef.current.resetToDraft(EMPTY_EDIT_STATE);
          persistClearedDraft();
          return;
        }
      }

      // [D14] notice for a typed `/command` the session card will not run
      // ([#step-13a]). Two cases: a *hidden* (known-unsupported) command —
      // never sent to claude — and a *genuine unknown* (catalog populated,
      // name absent) that would otherwise burn a turn on a typo. Either way,
      // surface a client-side `SHOW_SLASH_COMMAND_NOTICE` alert via the card's
      // responder with the matching `reason`, instead of silently dropping or
      // bouncing off claude. Recorded in history (↑ recalls it), mirroring the
      // local-command path. A local command was already dispatched above.
      const name = slashCommandName(commandLine);
      if (name !== null) {
        const hidden = isHiddenSlashCommand(name);
        const unknown =
          !hidden &&
          isUnknownRemoteCommand(
            name,
            sessionMetadataStore.getSnapshot().slashCommands.map((c) => c.name),
          );
        if (hidden || unknown) {
          const target = localCommandTargetIdRef.current;
          const notified =
            manager !== null &&
            target !== undefined &&
            manager.nodeCanHandle(
              target,
              TUG_ACTIONS.SHOW_SLASH_COMMAND_NOTICE,
            ) &&
            manager.sendToTarget(target, {
              action: TUG_ACTIONS.SHOW_SLASH_COMMAND_NOTICE,
              value: { name, commandLine, reason: hidden ? "unsupported" : "unknown" },
              phase: "discrete",
            });
          // A hidden command is always swallowed (never reaches claude). A
          // genuine unknown is swallowed only when a notice was actually
          // shown — with no responder (e.g. the gallery host), fall through to
          // `send()` so claude still sees it.
          if (hidden || notified) {
            const sessionId = snapRef.current.tugSessionId;
            historyStore.push({
              id: `${sessionId}-${Date.now()}`,
              sessionId,
              projectPath: "",
              route,
              text: commandLine,
              atoms: [],
              timestamp: Date.now(),
            });
            editor.clear();
            currentHistoryProviderRef.current.resetToDraft(EMPTY_EDIT_STATE);
            return;
          }
        }
      }
    }

    // Z5 disabled-mode gate. When `submitButtonMode` is one of the
    // four inert kinds (awaiting-user / stopping / reconnecting /
    // restoring) the button is `disabled` — a native-disabled button
    // already rejects click + the chain dispatch, but the editor's
    // Return key reaches `performSubmit` directly, so it is gated
    // here too. A disabled mode does not fire on Enter.
    if (resolveSubmitButtonView(submitButtonModeRef.current).disabled) {
      return;
    }
    // A mid-turn submit queues — the reducer's `handleSend` enqueues
    // a `send` dispatched while a turn runs ([D-T3-07], superseded by
    // [P06]/[P07] mid-turn steering: the queued message is held
    // client-side and retractable, then picked up at the next agent-loop
    // boundary and merged into the running turn, rather than only at
    // `turn_complete`). The earlier "submit is interrupt" branch is
    // retired: the primary Stop button interrupts through the SUBMIT
    // action handler; editor Return and the `+` button queue.
    // `performSubmit` is now uniformly "submit the editor draft" —
    // `codeSessionStore.send()` below, which the reducer routes to a
    // turn start (idle) or the queue (mid-turn).
    //
    // Blocked submit ([D-T3-08]): `canSubmit` AND `canInterrupt` both
    // false means the card is `replaying` (drop — a deferred send
    // committing post-replay would surprise the user) or the
    // transport is still settling on a fresh / reconnecting card
    // (defer — the submission is valid, it just landed a beat early).
    // Deferral arms `pendingSubmitRef`; the flush effect below
    // re-fires `performSubmit` the instant `canSubmit` flips true. A
    // turn in flight is NOT blocked — it falls through to `send()`
    // and queues.
    if (!snap.canSubmit && !snap.canInterrupt) {
      if (
        classifyBlockedSubmit(snap.phase, snap.sessionMode) === "defer" &&
        !isEffectivelyEmpty(view)
      ) {
        pendingSubmitRef.current = true;
      }
      return;
    }
    // Empty-input guard — reads the live view per [L07].
    if (isEffectivelyEmpty(view)) return;
    const captured = editor.captureState();
    const positionedAtoms: PositionedAtom[] = getAtomsInState(view.state);

    // Attachment pending-gate: any atom carrying an id but no
    // bytes-store entry is mid-processing (drop inserted the
    // skeleton; async byte-fill hasn't completed yet). Submitting
    // now would ship the filename as text only, dropping the bytes
    // silently — confusing UX. Surface a banner via the existing
    // attachment-error channel and bail; the user retries once the
    // pulsing pending chips settle. Per
    // [D02](dash/dev-atoms.md#d02-image-attach-text-rest)'s
    // pending-atom contract.
    const pendingAttachmentCount = positionedAtoms.filter(
      (a) =>
        a.segment.id !== undefined &&
        attachmentBytesStore.get(a.segment.id) === null,
    ).length;
    if (pendingAttachmentCount > 0) {
      publishAttachmentError(
        pendingAttachmentCount === 1
          ? "Attachment is still processing — wait for it to finish before submitting."
          : `${pendingAttachmentCount} attachments are still processing — wait for them to finish before submitting.`,
      );
      return;
    }

    // Trim whitespace from both ends of the submitted command. Atoms
    // ride as `￼` placeholder characters — never whitespace — so
    // trimming only removes surrounding spaces / newlines and never
    // touches an atom, keeping the placeholder count aligned with
    // `sendAtoms`.
    const submitText = captured.text.trim();
    const sendAtoms: AtomSegment[] = positionedAtoms.map((a) => a.segment);
    // A whitespace-only draft (no atoms) trims to nothing — treat it like
    // the empty-input guard and don't send a blank turn.
    if (submitText.length === 0 && sendAtoms.length === 0) return;

    // Shell routing ([P09], Spec S07): an atom-free draft holding one logical
    // command line whose first word names a real program may route to the shell
    // instead of Claude — after the slash-command intercepts, before `send`.
    // The agent makes that call; nothing here reads the line's meaning. The
    // auto-routed row renders a visible `→ shell` attribution with a one-click
    // "send to Claude instead", which recovers the answer but cannot un-run the
    // command, so every degraded path below resolves to Claude.
    //
    // Backslash continuations are spliced first, and the spliced line is what
    // gets graded, asked about, and run. A draft with a newline still standing
    // in it after that is more than one statement and never routes.
    const shellLine = spliceContinuations(submitText);
    const shellStore = shellSessionStoreRef.current;
    const routeToShell = (line: string): void => {
      shellStore?.exec(line, { origin: "auto" });
      // Auto-routed submissions were typed as prompt input, so record the
      // raw line under the prompt route.
      const sessionId = snapRef.current.tugSessionId;
      historyStore.push({
        id: `${sessionId}-${Date.now()}`,
        sessionId,
        projectPath: "",
        route,
        text: captured.text,
        atoms: [],
        timestamp: Date.now(),
      });
      onBeforeSubmitRef.current?.();
      // The verdict wait leaves the editor live. Anything typed during it is
      // the user's next draft, not part of this submission — clearing would
      // destroy it [L23] — so the editor is only emptied when it still holds
      // exactly what was submitted.
      const unchanged = editor.captureState().text === captured.text;
      if (unchanged) editor.clear();
      onAfterSubmitRef.current?.();
      if (unchanged) {
        currentHistoryProviderRef.current.resetToDraft(EMPTY_EDIT_STATE);
        persistClearedDraft();
      }
    };

    if (
      shellStore !== undefined &&
      sendAtoms.length === 0 &&
      shellLine !== null &&
      // Readiness off ⇒ never route, which is exactly the behavior of a build
      // with no agent at all ([P12]).
      shellRoutingReadyRef.current &&
      isShellCandidate(
        shellLine,
        pathCommandsStoreRef.current?.getSnapshot() ?? null,
      )
    ) {
      // A submit already parked at one of the bounded waits below owns this
      // draft: letting a second Return through (key auto-repeat, an impatient
      // double-tap) would ask the same question twice and run the same command
      // twice. Dropped rather than deferred — the parked submit is about to
      // route the very line this one carries.
      if (submitArbitratingRef.current) return;
      submitArbitratingRef.current = true;
      arbitrationWithdrawnRef.current = false;
      setArbitrating(true);
      let modelCall: ReturnType<typeof modelCallForBand> = "skip";
      let verdict: "shell" | "prompt" | null = null;
      try {
        // Grade before asking. The typing debounce normally has the answer
        // cached already, so this resolves instantly; the bounded wait is only
        // for the case where Return beat the debounce, and it expires to
        // `unknown`, which is the pre-grader path.
        const grammarStore = shellGrammarStoreRef.current;
        const grade =
          grammarStore === undefined
            ? UNKNOWN_GRADE
            : await grammarStore.requestWithin(shellLine, GRADE_SUBMIT_WAIT_MS);
        modelCall = modelCallForBand(grade.band);
        // Only the two asking bands cost a round trip. `run` and `skip` are
        // already decided — the table below says which way.
        if (modelCall === "ask" || modelCall === "ask-with-grammar") {
          const grammar =
            modelCall === "ask-with-grammar" ? grade.synopsis : undefined;
          const withGrammar = grammar !== undefined;
          verdict = verdictCacheRef.current.get(shellLine, withGrammar) ?? null;
          if (verdict === null) {
            // Either the typing debounce already asked and the model hasn't
            // answered, or Return beat the debounce and nobody has asked yet. Both
            // resolve the same way: one request for this exact line, awaited for a
            // bounded moment.
            const inFlight = pendingVerdictRef.current;
            let asked: Promise<"shell" | "prompt" | null>;
            // The in-flight request the debounce fired carries no documentation,
            // so it cannot stand in for the grammar-bearing question.
            if (!withGrammar && inFlight !== null && inFlight.text === shellLine) {
              asked = inFlight.promise;
            } else {
              // A debounce timer that hasn't fired would ask the same question a
              // second time; the submit supersedes it.
              if (verdictDebounceRef.current !== null) {
                window.clearTimeout(verdictDebounceRef.current);
                verdictDebounceRef.current = null;
              }
              const store = shellClassifyStoreRef.current;
              asked =
                store === undefined
                  ? Promise.resolve(null)
                  : store.request(shellLine, grammar);
            }
            verdict = await new Promise<"shell" | "prompt" | null>((resolve) => {
              // The race timer is retired when the answer wins it [L27].
              const timer = window.setTimeout(
                () => resolve(null),
                VERDICT_SUBMIT_WAIT_MS,
              );
              void asked.then((answered) => {
                window.clearTimeout(timer);
                resolve(answered);
              });
            });
          }
        }
      } finally {
        submitArbitratingRef.current = false;
        setArbitrating(false);
      }
      // Every fact is in hand; the table decides. The veto is applied there
      // rather than where the verdict is cached, so the cache stays a faithful
      // record of what the model said and every path into the shell — cached
      // verdict, fresh answer, awaited in-flight one — passes the same gate.
      const destination = resolveSubmitDestination({
        line: shellLine,
        modelCall,
        verdict,
        withdrawn: arbitrationWithdrawnRef.current,
      });
      arbitrationWithdrawnRef.current = false;
      // Escape during the wait takes the submission back whole. Nothing had
      // run and nothing had been sent, so withdrawing costs the user nothing
      // and leaves the draft exactly where they left it. The verdict still
      // lands in the store's cache, which makes a re-submit of this line
      // instant.
      if (destination === "withdrawn") return;
      if (destination === "shell") {
        routeToShell(shellLine);
        return;
      }
    }

    // Canonicalize a lone plugin command to its qualified `/<plugin>:<leaf>`
    // form so the wire and transcript use the name claude expands — even when
    // the user typed (or accepted) the bare leaf. An exact catalog match is
    // left untouched (conflict / shadowing → exact typed wins). The catalog
    // here is the same turn-free `slashCommands` the popup reads.
    const catalogNames = sessionMetadataStore
      .getSnapshot()
      .slashCommands.map((c) => c.name);
    let wireText = submitText;
    let wireAtoms = sendAtoms;
    if (sendAtoms.length === 1 && sendAtoms[0].type === "command") {
      const canonical = resolveRemoteCommand(sendAtoms[0].value, catalogNames);
      if (canonical !== null && canonical !== sendAtoms[0].value) {
        wireAtoms = [
          { ...sendAtoms[0], value: canonical, label: canonical },
        ];
      }
    } else if (sendAtoms.length === 0) {
      const canonical = canonicalizeBareCommandLine(submitText, catalogNames);
      if (canonical !== null) wireText = canonical;
      // A command line typed out rather than accepted from the completion
      // popup carries no command atom, so the transcript would paint the
      // invocation as prose until a reload replayed it as a chip. Mint the
      // atom the popup would have placed, on the canonicalized text so the
      // chip reads the qualified name claude expands. Every local, hidden
      // and unknown name was dispatched or refused above, so no
      // known-command gate is needed here.
      const minted = mintLeadingCommandAtom(wireText, wireAtoms, TUG_ATOM_CHAR);
      if (minted !== null) {
        wireText = minted.text;
        wireAtoms = minted.atoms;
      }
    }

    codeSessionStore.send(wireText, wireAtoms);
    // Record the submission in per-session history, keyed by the
    // session's id. The route field pins to Code so the Code provider
    // recalls it ([P11]). Captured before clear so the live state is
    // still the submitted content.
    const sessionId = snapRef.current.tugSessionId;
    const historyEntryId = `${sessionId}-${Date.now()}`;
    historyStore.push({
      id: historyEntryId,
      sessionId,
      projectPath: "",
      route,
      text: captured.text,
      atoms: positionedAtoms.map((a) => ({
        position: a.position,
        type: a.segment.type,
        label: a.segment.label,
        value: a.segment.value,
        id: a.segment.id,
        // The stored original, and only it — the preview a recalled prompt
        // shows is re-derived from these bytes, so persisting the baked
        // thumbnail alongside would store the same picture twice. Undefined
        // here when the upload hasn't landed yet; the backfill below
        // completes the row when it does.
        path:
          a.segment.id !== undefined
            ? attachmentBytesStore.get(a.segment.id)?.path
            : undefined,
      })),
      timestamp: Date.now(),
    });
    // Pathless image atoms: the upload can land after the submit that
    // recorded them. Watch the bytes store for each one and complete the
    // stored row when its path arrives, so a later recall of this prompt
    // reads real bytes back instead of showing a severed attachment. Store→
    // store wiring in a callback ([L22], [L24]) — nothing here is rendered.
    registerAtomPathBackfill(
      historyEntryId,
      positionedAtoms
        .filter(
          (a) =>
            a.segment.type === "image" &&
            a.segment.id !== undefined &&
            attachmentBytesStore.get(a.segment.id)?.path === undefined,
        )
        .map((a) => a.segment.id as string),
    );
    // Fire the pre-clear hook so hosts can drive submit-specific
    // effects BEFORE `editor.clear()` flips `data-empty="true"`.
    onBeforeSubmitRef.current?.();
    // The verdict wait above leaves the editor live. Anything typed during it
    // is the user's next draft, not part of this submission — clearing would
    // destroy it [L23] — so the editor is only emptied when it still holds
    // exactly what was submitted.
    const unchanged = editor.captureState().text === captured.text;
    if (unchanged) editor.clear();
    // Fire AFTER clear so host hooks (e.g., refocus) act on the
    // already-empty editor.
    onAfterSubmitRef.current?.();
    if (unchanged) {
      // Submitting returns the history cursor to the end of the list, so
      // the next ↑ starts from the most recent entry (this submission)
      // rather than wherever the user had browsed to. The draft is the
      // now-empty editor.
      currentHistoryProviderRef.current.resetToDraft(EMPTY_EDIT_STATE);
      // Force the cleared draft durable now so a relaunch can't restore the
      // message we just sent (see `persistClearedDraft`).
      persistClearedDraft();
    }
    // Route is a sticky user preference. Do not reset on submit.
  }, [
    codeSessionStore,
    historyStore,
    manager,
    sessionMetadataStore,
    persistClearedDraft,
    attachmentBytesStore,
    registerAtomPathBackfill,
    setArbitrating,
  ]);

  // Flush a deferred submit. When a submit landed during the
  // transport-settling window, `performSubmit`'s blocked-submit branch
  // armed `pendingSubmitRef`; re-fire it the instant `canSubmit` flips
  // true so Shift+Return (or the button) submits without the user
  // having to retry. `performSubmit` re-captures the editor live, so
  // any edits made while waiting are included — and an editor emptied
  // in the meantime no-ops cleanly.
  //
  // `useLayoutEffect` keyed on `snap.canSubmit` runs after the
  // `snapRef` mirror above (declared earlier, so it commits first),
  // so `performSubmit` reads the fresh snapshot. [L03]
  useLayoutEffect(() => {
    if (!snap.canSubmit) return;
    if (!pendingSubmitRef.current) return;
    pendingSubmitRef.current = false;
    void performSubmit();
  }, [snap.canSubmit, performSubmit]);

  // [L07] Register the responder node.
  //
  // CANCEL_DIALOG is conditionally registered — only when a turn is in
  // flight AND no interrupt is already in flight (`canInterrupt &&
  // !interruptInFlight`), i.e. exactly when there is still something
  // cancellable. Both Escape and Cmd-. map to CANCEL_DIALOG in
  // `keybinding-map.ts`; the chain walks from first responder upward so
  // any visible popover / sheet / alert dismisses first via its own
  // CANCEL_DIALOG handler ([DT07]). When nothing dialog-like is in the
  // chain and a turn is in flight, the walk reaches us and we
  // `popInteractive()` — the unified Stop ≡ Esc gesture: pop the
  // newest cancellable thing, a queued send first (LIFO), then the
  // running turn once the queue is empty. Identical to clicking the
  // red Stop button (the SUBMIT handler's stop branch calls the same
  // `popInteractive()`).
  //
  // Conditional registration matters: the chain marks an action as
  // handled iff its key exists in the responder's actions map
  // (`lookupHandler` is `node.actions[action]`). Registering
  // CANCEL_DIALOG unconditionally would suppress the bubble-phase
  // event (preventDefault + stopImmediatePropagation) even when there
  // is nothing to cancel — and that would break editor-internal
  // Escape semantics (CodeMirror's autocomplete dismiss). The
  // `useResponder` hook's R5 live-lookup proxy reads
  // `optionsRef.current.actions` on every dispatch, so the conditional
  // spread reflects the current snapshot at dispatch time.
  //
  // The `!interruptInFlight` clause closes the Esc-during-INTERRUPTING
  // gap: once a CASE B interrupt is in flight the turn is already
  // being torn down and `handleInterrupt` cleared its queue, so there
  // is nothing left to pop — and the Stop button is itself already
  // disabled (`submitButtonMode` is `stopping`), so dropping the Esc
  // handler too keeps Esc ≡ the Stop button. Without it, a second Esc
  // would re-fire `interrupt()` on a turn already interrupting (a
  // redundant wire frame + a clobbered interrupt-segment timestamp).
  //
  // The handler lives at THIS responder (TugPromptEntry's) rather
  // than further up the chain (card-content) because the chain walk
  // reaches us first — closer to the first responder is the natural
  // place for a behavior that's semantically owned by the prompt
  // entry (which already owns the submit / peel branching for the
  // Stop button via the SUBMIT action handler).
  const { ResponderScope, responderRef } = useResponder({
    id,
    actions: {
      // ⌘G / ⇧⌘G — advance / retreat the active match with the caret in the
      // composer. Gated on the SESSION holding matches, which is true exactly
      // while the find bar is open: closing the bar clears the session, so
      // these are inert without a live search. The transcript host reacts to
      // the active-index change (scroll + flash).
      [TUG_ACTIONS.FIND_NEXT]: () => {
        const session = findSessionRef.current;
        if (session !== undefined && session.getSnapshot().count > 0) {
          session.next();
        }
      },
      [TUG_ACTIONS.FIND_PREVIOUS]: () => {
        const session = findSessionRef.current;
        if (session !== undefined && session.getSnapshot().count > 0) {
          session.previous();
        }
      },
      // The Z4A route group. `TugChoiceGroup` dispatches `selectValue` up to
      // the parent responder ([L11]), and this entry is that parent — it owns
      // the document the route selects. Entering goes back out to the host,
      // which holds both landing controllers; leaving stays here, because
      // `exitCommitMode` (not a bare `exit()`) persists a typed message first,
      // so leaving a landing and coming back resumes it.
      [TUG_ACTIONS.SELECT_VALUE]: (event: ActionEvent) => {
        if (event.sender !== ROUTE_CHOICE_SENDER_ID) return;
        if (event.value === "changes") {
          onEnterChanges?.();
        } else if (event.value === "prompt") {
          exitCommitMode();
        }
      },
      // ⌘I / Session ▸ Insert File…. Registered HERE and nowhere above:
      // the command inserts at a caret, so the composer holding focus is
      // the only responder that can answer it. That is also the item's
      // gate — an unhandled chain walk is what dims the menu item when
      // focus sits in the transcript.
      [TUG_ACTIONS.INSERT_FILE]: (event: ActionEvent) => {
        const path = (event.value as { path?: unknown } | undefined)?.path;
        if (typeof path !== "string" || path === "") return;
        insertFilePath(path);
      },
      [TUG_ACTIONS.REMOVE_ATTACHMENT]: (event: ActionEvent) => {
        // The preview's ✕ / Delete controls dispatch the atom id of the
        // attachment to drop; the prompt-entry owns the editor doc +
        // bytes store, so it performs the removal here ([L11]).
        if (typeof event.value !== "string") return;
        handleRemoveAttachmentById(event.value);
      },
      [TUG_ACTIONS.SUBMIT]: (_event: ActionEvent) => {
        // The primary Z5 button dispatches SUBMIT in every mode. When
        // a turn is running the button is Stop — it pops the newest
        // cancellable thing (a queued send first, LIFO; the running
        // turn once the queue is empty), the same `popInteractive()`
        // gesture Esc invokes. In any submit-family mode it runs the
        // submit. Editor Return reaches `performSubmit` directly
        // (never via this action), so an in-flight Return queues
        // rather than popping.
        if (submitButtonModeRef.current.kind === "stop") {
          codeSessionStore.popInteractive();
        } else {
          void performSubmit();
        }
      },
      // ⌃⌘M and the pencil-sparkles button are two doors on one command
      // ([L11]). Inert mid-draft — the button stays lit but does nothing —
      // and otherwise routed through the same handler, so a typed message
      // still trips the Replace confirm.
      [TUG_ACTIONS.COMMIT_AUTO_MESSAGE]: (_event: ActionEvent) => {
        if (commitDraftingRef.current) return;
        handleCommitAutoMessage();
      },
      // Escape / ⌘. — one ladder, in one place.
      //
      // It used to be two: this handler when a turn was in flight, and a raw
      // capture listener on the composer root for the no-turn case, each with
      // its own copy of the drafting-then-mode-then-popup order. Registering
      // whenever there is something to cancel is what collapses them, and is
      // why the condition is a union rather than the interrupt gate alone —
      // in commit mode with no turn running, Escape still has to drop the
      // shade rather than fall through to the engine's ladder.
      ...(landingActive || (snap.canInterrupt && !snap.interruptInFlight)
        ? {
            [TUG_ACTIONS.CANCEL_DIALOG]: (_event: ActionEvent) => {
              // While the Auto-Message scribe streams ([P06]), Escape / ⌘.
              // cancel the DRAFT — never the running turn. Intercepting
              // drafting before everything below is what keeps the cancel
              // from leaking into the session; the backend aborts only the
              // scribe child.
              if (commitDraftingRef.current) {
                cancelCommitDraft();
                return;
              }
              // In commit mode the Changes shade is up: Escape / ⌘. dismiss
              // the mode (drop the shade), NEVER the running turn — so the
              // shade-dismiss outranks the interrupt.
              if (landingActiveRef.current) {
                exitCommitMode();
                return;
              }
              // A visible slash-command / file completion popup owns Escape
              // first: dismiss it and bail. The capture-phase binding routes
              // Escape here BEFORE the editor's bubble-phase keymap runs, so
              // without this check Escape would interrupt the turn while
              // leaving the popup open. With no popup open this is a no-op and
              // we fall through to the interrupt — Escape ≡ the Stop button.
              if (textEditorRef.current?.cancelActiveCompletion() === true) {
                return;
              }
              codeSessionStore.popInteractive();
            },
          }
        : {}),
    },
  });

  // Seed `data-empty` from the actual view state once the substrate
  // ref is wired [L03]. The JSX defaults `data-empty="true"` at
  // render, but on a browser reload / HMR refresh the editor may
  // already carry preserved content — the submit button would then
  // stay disabled until the user typed. Running the same check once
  // at mount closes that gap.
  useLayoutEffect(() => {
    const view = textEditorRef.current?.view() ?? null;
    reportEmptiness(isEffectivelyEmpty(view));
    const root = rootRef.current;
    if (root === null) return;
    root.setAttribute("data-empty", String(isEffectivelyEmpty(view)));
  }, [reportEmptiness]);

  // Snapshot the substrate's scroll position the moment the card
  // deactivates. The framework hides inactive cards via `display:
  // none`, which collapses `.cm-scroller`'s scrollable extent and
  // (on Safari/WebKit) wipes its `scrollTop`. Subsequent `onSave`
  // calls fired while the card is inactive (deactivation-time
  // flush, debounced auto-save, `saveState` RPC) would otherwise
  // capture `scrollTop: 0` and overwrite the user's saved scroll
  // position. The snapshot is cleared on re-activation so the live
  // `view.scrollDOM.scrollTop` resumes as the source of truth while
  // the card is interactive. [L23] enforcement — an internal
  // teardown (display:none) must not destroy user-visible state.
  const inactiveDraftSnapshotRef = useRef<TugTextEditingState | null>(null);
  // Pending draft to re-apply when the card next activates. Set by
  // `onRestore` when the card mounts inactive (`isActive === false`):
  // the substrate's `restoreState` runs against the hidden card,
  // and its `view.scrollDOM.scrollTop` write is wiped by
  // `display: none`. The user's saved scroll therefore needs to be
  // RE-applied when the card transitions to active (the activation
  // moment is when `.cm-scroller` regains real `clientHeight` and
  // can honour the scroll write). Cleared on activation.
  const pendingActivationDraftRef = useRef<TugTextEditingState | null>(null);
  // Last draft this entry captured or restored. `onSave` forwards it when
  // `textEditorRef.current` is null (a save fired in a window where the
  // substrate isn't mounted) — returning `draft: null` there would clobber
  // a previously-good persisted draft with nothing. [L23]
  const lastKnownDraftRef = useRef<TugTextEditingState | null>(null);

  // Phase E.11 Step 4e — engine-hook registration channel.
  //
  // Register `paintMirrorAsActive` / `paintMirrorAsInactive` hooks
  // with the deck-manager-store so `applyBagFocus` can drive the
  // engine through the framework's single channel. The closures
  // read `textEditorRef.current` and `pendingActivationDraftRef`
  // live at fire time per [L07].
  //
  // The active hook consumes `pendingActivationDraftRef` — set by
  // `onRestore` during cold-boot for the inactive-mount case so
  // the engine's scroll-axes write lands against the live (post-
  // activation) viewport. For runtime cmd-tab return (no pending
  // draft), the hook calls `paintMirrorAsActive(undefined)` which
  // trusts the engine's live state.
  //
  // Registration runs in `useLayoutEffect` keyed on `[cardIdForTrace]`
  // so it's complete before any framework event that could invoke
  // the hook fires ([L03]). When no `cardIdForTrace` is present
  // (standalone use outside a `CardStatePreservationContext`), we
  // skip — the imperative-API surface (`textEditorRef.paintMirrorAsActive`)
  // still allows ad-hoc callers.
  //
  // At Step 4e, the engine hook is REGISTERED but the autonomous
  // `paintMirrorAsActive` claim in `useCardStatePreservation`'s
  // `onCardActivated` / `onRestore` is still in place (retired at
  // Step 4f). During the migration window both fire; both are
  // idempotent. Once 4f retires the autonomous claim, the hook is
  // the only path that calls `paintMirrorAsActive`.
  useLayoutEffect(() => {
    if (cardIdForTrace === null) return;
    const store = getDeckStore();
    if (store === null) return;
    const unregister = store.registerEngineHooks(cardIdForTrace, {
      paintMirrorAsActive: () => {
        const editor = textEditorRef.current;
        if (editor === null) return;
        const pending = pendingActivationDraftRef.current;
        pendingActivationDraftRef.current = null;
        deckTrace.record({
          kind: "engine-paint-mirror-active",
          cardId: cardIdForTrace,
          caller: "via-engine-hook",
        });
        editor.paintMirrorAsActive(pending ?? undefined);
      },
      paintMirrorAsInactive: () => {
        const editor = textEditorRef.current;
        if (editor === null) return;
        deckTrace.record({
          kind: "engine-paint-mirror-inactive",
          cardId: cardIdForTrace,
        });
        editor.paintMirrorAsInactive(publishToSelectionGuard);
      },
    });
    return unregister;
  }, [cardIdForTrace, publishToSelectionGuard]);

  // TugPane state preservation [L23]. TugPromptEntry is the sole
  // preserver for this compound — the embedded `TugTextEditor` is
  // explicitly opted out via `preserveState={false}` below so there's
  // no competing registration. Payload carries the active route + a
  // single draft snapshot.
  useCardStatePreservation<TugPromptEntryState>({
    onCardActivated: () => {
      // Phase E.11 Step 4f — autonomous focus claim retired.
      // The framework's single-channel `applyBagFocus` dispatcher
      // invokes the engine via the registered engine hook
      // (registered in the useLayoutEffect above) when
      // `bag.focus.kind === "engine"`. The engine hook consumes
      // `pendingActivationDraftRef` and calls
      // `paintMirrorAsActive(pending ?? undefined)` — the same
      // call this handler used to make autonomously. See
      // `tuglaws/state-preservation.md` [Focus dispatch model].
      //
      // This handler keeps only the deactivation-time draft
      // snapshot reset: the substrate's live `view.scrollDOM.scrollTop`
      // is the authoritative value again now that the card is
      // interactive.
      inactiveDraftSnapshotRef.current = null;
    },
    onCardWillDeactivate: () => {
      // [L23] enforcement: hand the substrate's selection over to
      // selectionGuard via `paintMirrorAsInactive(publish)` before
      // the new active card claims focus + global Selection. NO
      // focus claim.
      //
      // Snapshot the substrate's full editing state — the live scroll
      // axes are still authoritative here (the React commit that
      // applies `display: none` has not run yet — `transferFocusFor
      // Activation` saves and deactivates outgoing BEFORE the commit
      // mutation flush). Any subsequent `onSave` while the card is
      // inactive returns this snapshot's scroll values verbatim
      // instead of reading the wiped live scroller.
      const editor = textEditorRef.current;
      if (editor !== null) {
        inactiveDraftSnapshotRef.current = editor.captureState();
      }
      editor?.paintMirrorAsInactive(publishToSelectionGuard);
    },
    onSave: (source) => {
      const editor = textEditorRef.current;
      // No live substrate: forward the last draft this entry saw rather
      // than writing `draft: null` over a good persisted draft. [L23]
      const liveDraft =
        editor !== null ? editor.captureState() : lastKnownDraftRef.current;
      const snap = inactiveDraftSnapshotRef.current;
      // Card is inactive: prefer the snapshot's scroll axes (the
      // live scroller has been zeroed by display:none). Selection,
      // text, atoms come from the live capture — selection-guard's
      // paintMirrorAsInactive has already routed the user's range
      // into selectionGuard.cardRanges, so the engine's live state
      // is still the right source for those axes.
      let draft = liveDraft;
      if (draft !== null && snap !== null) {
        draft = {
          ...draft,
          scrollTop: snap.scrollTop,
          scrollLeft: snap.scrollLeft,
          scrollAnchor: snap.scrollAnchor ?? null,
        };
      }
      // Snapshot the bytes-store alongside the draft so a card that
      // restores from disk (or HMR cycle) rehydrates its in-flight
      // image attachments with bytes intact. The store's `snapshot`
      // returns a fresh plain object — JSON-serializable. Omitted
      // when empty so persisted payloads stay small. Per [L23].
      const bytesSnap = attachmentBytesStore.snapshot();
      const attachmentBytes = Object.keys(bytesSnap).length > 0
        ? bytesSnap
        : undefined;
      // The app is exiting: text the user committed but that is not in
      // the composer — a pulled-back submission still sitting in the
      // restore slot, and every queued send — has no other durable home,
      // so it is appended to the draft rather than dropped with the
      // process. Steady-state saves must not do this: the queue is still
      // on screen as ghost rows and the restore slot is about to seed the
      // editor, so folding it in would duplicate the text. [L23].
      if (source === "termination") {
        const unsent = codeSessionStore.captureUnsentText();
        if (unsent.length > 0) {
          const existing = draft?.text ?? "";
          // Appended at the end so every atom position in the draft
          // (indices into `text`) and the saved selection stay valid.
          const text = existing.length > 0
            ? `${existing}\n\n${unsent.join("\n\n")}`
            : unsent.join("\n\n");
          draft = draft !== null
            ? { ...draft, text }
            : { text, atoms: [], selection: null };
        }
      }
      lastKnownDraftRef.current = draft;
      return {
        route,
        draft,
        attachmentBytes,
      };
    },
    onRestore: (raw, { isActive }) => {
      const restored = coerceRestorePayload(raw);
      lastKnownDraftRef.current = restored.draft;
      // Rehydrate the bytes-store BEFORE the editor restores its
      // draft so the moment the substrate reads atom-ids back, the
      // corresponding bytes are already there for buildWirePayload
      // (Step 3) to read at submit. Additive on existing keys per
      // [Spec S02] — if the live store has accumulated unrelated
      // entries from drops that happened after the snapshot was
      // taken (rare), they survive the restore.
      if (restored.attachmentBytes !== undefined) {
        attachmentBytesStore.restore(restored.attachmentBytes);
        // Read the originals back for every entry that arrived as a bare
        // reference. Fire-and-forget, and strictly after `coerceRestorePayload`
        // has already decided which atoms survive: the prune reads the
        // restored bag, not the eventual store contents, so the two must not
        // race. Until a read lands the chip paints a reserved slot and its
        // empty `content` submits as a mention marker, exactly as a recalled
        // thumbnail always has.
        rehydrateDraftAttachments(restored.attachmentBytes, attachmentBytesStore);
      }
      const editor = textEditorRef.current;
      if (editor !== null) {
        if (restored.draft !== null) {
          // restoreState updates the substrate's doc + atoms +
          // selection without touching DOM Selection or focus
          // (mirror-only restore). [L23].
          //
          // Phase E.11 Step 4f — for the `isActive` branch, the
          // autonomous `paintMirrorAsActive(restored.draft)` claim
          // is retired. The framework's `applyBagFocus` dispatcher
          // (CardHost cold-boot RESTORE for the active card)
          // invokes the registered engine hook (4e), which reads
          // `pendingActivationDraftRef` for the saved draft and
          // calls `paintMirrorAsActive`. Stash the draft for BOTH
          // active and inactive paths so the engine hook has a
          // uniform read source.
          editor.restoreState(restored.draft);
          pendingActivationDraftRef.current = restored.draft;
          if (!isActive) {
            // Inactive mount: also publish the saved selection
            // through the inactive-paint channel so selectionGuard
            // can render the dim selection band on the hidden
            // card. The pendingActivationDraftRef stashed above
            // covers the active-side re-apply when the card later
            // becomes active (engine hook reads it).
            editor.paintMirrorAsInactive(
              publishToSelectionGuard,
              restored.draft,
            );
          }
          // Diagnostic for the cold-boot selection-paint gap. Engine
          // string preserved from the legacy entry for
          // forward-compatible app-test matchers.
          if (cardIdForTraceRef.current !== null) {
            const view = editor.view();
            const domRange = readDomSelectionInside(view);
            deckTrace.record({
              kind: "engine-restore-applied",
              cardId: cardIdForTraceRef.current,
              engine: "gallery-prompt-entry",
              selectionApplied: restored.draft.selection ?? null,
              domSelectionAfter: domRange,
            });
          }
        } else {
          editor.clear();
        }
      }
      const root = rootRef.current;
      const view = editor?.view() ?? null;
      reportEmptiness(isEffectivelyEmpty(view));
      if (root !== null) {
        root.setAttribute("data-empty", String(isEffectivelyEmpty(view)));
      }
    },
  });

  // Expose the imperative delegate. Pass-throughs to the substrate;
  // the entry does not own text state.
  // Seed (or replace) the leading command chip ([P07]) — the shared sink for
  // the ⌃⌘ chords, the picker menu, and the delegate method.
  const seedCommandChip = useCallback((name: string) => {
    const editor = textEditorRef.current;
    if (editor === null) return;
    editor.restoreState(computeCommandChipInsert(editor.captureState(), name));
    editor.focus();
  }, []);

  // ⌘/ — the keyboard door to command discovery: focus the editor and seed a
  // leading `/`, which opens the slash-command completion popup. The `"/"`
  // provider is position-0 gated (`wrapPositionZero`), so this opens the
  // popup on an empty document and correctly does nothing but insert a
  // character in a draft that already has text.
  const openCommandPicker = useCallback(() => {
    const editor = textEditorRef.current;
    const view = editor?.view();
    if (editor === null || editor === undefined || view === null || view === undefined) {
      return;
    }
    editor.focus();
    view.dispatch({
      changes: { from: view.state.selection.main.from, to: view.state.selection.main.to, insert: "/" },
      selection: { anchor: view.state.selection.main.from + 1 },
      userEvent: "input.type",
    });
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        textEditorRef.current?.focus();
      },
      openCommandPicker() {
        openCommandPicker();
      },
      blur() {
        const view = textEditorRef.current?.view();
        view?.contentDOM.blur();
      },
      clear() {
        textEditorRef.current?.clear();
      },
      isEmpty() {
        return isEffectivelyEmpty(textEditorRef.current?.view() ?? null);
      },
      insertCommandChip(name: string) {
        seedCommandChip(name);
      },
      insertFilePath(path: string) {
        insertFilePath(path);
      },
      getEditorElement() {
        const view = textEditorRef.current?.view();
        return (view?.contentDOM as HTMLElement | undefined) ?? null;
      },
      regenerateAtoms() {
        const view = textEditorRef.current?.view();
        view?.dispatch({ effects: regenerateAtomsEffect.of(null) });
      },
    }),
    [openCommandPicker, seedCommandChip, insertFilePath],
  );

  // Compose rootRef + responderRef onto the same DOM element.
  const composedRootRef = useCallback(
    (el: HTMLDivElement | null) => {
      rootRef.current = el;
      responderRef(el);
    },
    [responderRef],
  );

  /*
   * Shell-slot occupants, hoisted so the {@link TugEntryShell} tag below
   * stays readable. Zone semantics (Z4C accessory strip, Z4A route popup,
   * Z4B indicators, Z5 buttons) are unchanged — the shell owns only the
   * layout positions.
   */
  {/*
            Z4C — the compose-phase attachment-preview zone. A flow sibling
            between the editor's scroll viewport and the toolbar (Z4), so it
            stays pinned below the scrolling text and directly above the
            toolbar, and grows the entry's height like added text rows.
            Rendered only when the editor holds image atoms; the preview
            component itself short-circuits to null when empty, but gating
            here keeps the zone wrapper out of the DOM entirely so it adds
            no padding to an attachment-free entry. The ✕ / Delete delete
            affordance is live here ([compose phase] — `onDelete` supplied),
            unlike the read-only transcript strip.
          */}
  const entryAccessoryRow =
    composeImageAtoms.length > 0 ? (

            <div
              className="tug-prompt-entry-attachments"
              data-slot="tug-prompt-entry-attachments"
              // Chrome, like the toolbar: a click on a tile or its ✕ must
              // not steal first-responder / DOM focus from the editor.
              // Descendant controls that need focus (none here — the tile
              // opens a sheet, the ✕ refuses) are unaffected.
              data-tug-focus="refuse"
              // Drops on the strip ride the entry-root drop surface (the
              // handlers on `.tug-prompt-entry` above) — no zone-local
              // handlers, one continuous target.
            >
              <TugAttachmentPreview
                atoms={composeImageAtoms}
                bytesStore={attachmentBytesStore}
                deletable
                // The Z4C zone is a fixed-height single row, so the scrollbar's
                // pixels have to come out of the tile height. This is the only
                // surface that layout applies to.
                measureRowOverflow
                focusGroup={attachmentFocusGroup}
                focusOrderBase={attachmentFocusOrderBase}
              />
            </div>
    ) : undefined;

  // Z4A leading slot — the composer's routes. A route is a mode that owns the
  // composer's whole document, and there are two: typing a prompt, and
  // authoring the message that lands what is in flight. Everything else is a
  // one-shot verb (a slash command) or lives outside the composer.
  //
  // The group is INVARIANT: two segments on every card, whatever it is mated
  // to. *Changes* names the room; which landing that room opens — a commit or
  // a join — is the host's to resolve from the card's binding, and the Z5 land
  // button is what names the act. A group whose population changed under a
  // bind was presenting commits and joins as sibling choices, which is not how
  // anyone thinks about them, and moved the segments under the pointer.
  //
  // The group is a VIEW of whichever landing mode is up, not a second home for
  // the selection: `value` is derived from `landingActive` alone. That is what
  // makes every existing entry and exit path — ⌃⌘C, `/commit`, `/dash-join`,
  // the Session menu, a successful land, Cancel ✕, Escape, the shade's
  // self-close — move the visible tab with no extra wiring.
  //
  // No controller means no group. Hosts without a landing mode (the Component
  // Gallery's prompt entry) render an empty leading slot rather than a Changes
  // segment that cannot act. The group is deliberately NOT disabled while a
  // landing is active — it is how you leave one.
  const entryRouteChoice =
    landingMode !== undefined ? (
      <TugChoiceGroup
        className="tug-prompt-entry-route-group"
        // The unread dot, painted by CSS off this attribute rather than by a
        // second segment or a label swap ([L06]). It rides the group root
        // because `TugChoiceItem` carries no per-segment attribute hook, and
        // the segment it belongs to is named in the selector.
        data-join-offer={changesHasOffer || undefined}
        items={[
          {
            value: "prompt",
            label: "Prompt",
            icon: <MessageSquareText strokeWidth={2} />,
            tooltip: "Write a prompt",
            tooltipShortcut: commandShortcut(`${TUG_ACTIONS.SELECT_COMPOSER_ROUTE}:prompt`),
          },
          {
            value: "changes",
            label: "Changes",
            icon: <GitCommitHorizontal strokeWidth={2} />,
            // The label is invariant; the tooltip follows the binding, so the
            // bubble says which message this room is for.
            tooltip: LANDING_WORDS[changesLandingKind].routeTooltip,
            tooltipShortcut: commandShortcut(TUG_ACTIONS.TOGGLE_CHANGES_VIEW),
          },
        ]}
        value={landingActive ? "changes" : "prompt"}
        senderId={ROUTE_CHOICE_SENDER_ID}
        size="xs"
        aria-label="Route"
        focusGroup={routeFocusGroup}
        focusOrder={routeFocusOrder}
      />
    ) : undefined;

  // What the primary Z5's bubble says the keyboard does. In `submit` the
  // button is the submit key's pointer twin, so it shows that key.
  //
  // In `stop` the twin is CANCEL_DIALOG, not INTERRUPT_SESSION: Escape / ⌘.
  // land on this entry's CANCEL_DIALOG handler and call the same
  // `popInteractive()` the button's own SUBMIT branch calls — Stop ≡ Esc, one
  // gesture. INTERRUPT_SESSION is the Session ▸ Stop menu item, which carries
  // no binding, so reading it here would have shown the phrase alone forever
  // while two live chords went unnamed. The chord is read, not authored, and
  // the registry picks which of Cancel's two it shows ([P11]) — the same
  // single-chip face the commit rail's ✕ wears.
  //
  // The four inert modes are native `disabled`, which never opens a bubble.
  const submitTooltipShortcut =
    submitView.dataMode === "submit"
      ? submitChordLabel
      : submitView.dataMode === "stop"
        ? commandShortcut(TUG_ACTIONS.CANCEL_DIALOG)
        : undefined;

  const entryToolbarTrailing = (
    <>
            {/*
              Z5 `+` queue button — mounted alongside the primary Stop
              button while a turn runs (mode `stop`). CSS-gated on the
              entry root's `data-empty` attribute: hidden until the
              editor holds a draft, so a plain submit → wait → submit
              flow never surfaces it ([L06] / [L22] — no per-keystroke
              React state). Click queues the draft — the pointer twin of
              editor Return — via a direct `onClick` on `performSubmit`,
              never the SUBMIT action, so it does not route through the
              Stop branch of the SUBMIT handler.
            */}
            {submitView.dataMode === "stop" && (
              // The chord is the editor's, not the button's own: while a turn
              // runs, the submit key queues, and this button is that key's
              // pointer twin — so it says the key.
              <TugTooltip content="Queue prompt" shortcut={submitChordLabel}>
                <TugPushButton
                  className="tug-prompt-entry-queue-button"
                  subtype="icon"
                  size="lg"
                  emphasis="filled"
                  role="action"
                  onClick={performSubmit}
                  aria-label="Queue prompt"
                  icon={<Plus size={16} strokeWidth={2.5} />}
                />
              </TugTooltip>
            )}
            {/*
              ONE button node across every mode ([L26]) — only
              `data-mode` / `disabled` / `aria-label` / the icon glyph
              change. `data-mode` drives the per-mode visual via CSS
              ([L06]); `submitView` is the pure projection of the
              lifecycle `submitButtonMode`.

              The bubble is one wrapper for the same reason the button is one
              node: its type never changes across a mode transition, only its
              phrase and its chip.
            */}
            <TugTooltip
              content={submitView.ariaLabel}
              shortcut={submitTooltipShortcut}
            >
              <TugPushButton
                className="tug-prompt-entry-submit-button"
                data-mode={submitView.dataMode}
                // Return's home while the caret is in this composer — the shell
                // lights the default ring and stands the fill down when the caret
                // moves to another entry surface (the find bar).
                data-tug-entry-default=""
                data-default-chord={submitChord}
                action={TUG_ACTIONS.SUBMIT}
                subtype="icon"
                size="lg"
                emphasis="filled"
                focusGroup={submitFocusGroup}
                focusOrder={submitFocusOrder}
                role={submitView.danger ? "danger" : "action"}
                disabled={submitView.disabled}
                aria-label={submitView.ariaLabel}
                icon={
                  submitView.icon === "stop" ? (
                    <Square size={14} strokeWidth={3} />
                  ) : (
                    <ArrowUp size={16} strokeWidth={2.5} />
                  )
                }
                // The arbitration tell, expressed as a button activity: while a
                // submit is parked on the shell-vs-Claude decision, the Z5 arrow
                // trades places with the wave — the same glyph every other "the
                // system is deciding" moment wears, so the pause reads as one of
                // that family rather than as a new vocabulary. `busy` because
                // the motion is the swapped-in glyph's own, not the arrow's.
                //
                // The button mounts both halves and the swap comes out of the
                // cascade, which is what lets `setArbitrating` write the
                // attribute by hand: a parked submit must not re-render the
                // composer ([L06]). Offered only in `submit` mode — a running
                // turn shows the Stop square, and a stop gesture must never be
                // dressed up as progress.
                activityIcon={
                  submitView.icon === "stop" ? undefined : (
                    <TugProgressIndicator
                      variant="wave"
                      state="running"
                      role="inherit"
                      size={14}
                    />
                  )
                }
              />
            </TugTooltip>
    </>
  );

  // ── Commit-mode chrome ([P03], Z5 icon rail) ─────────────────────────────
  // Z5: auto-message / commit, both icons ([P03]). Auto-Message drafts
  // (pencil-sparkles; a spinner + disabled while drafting), Commit lands.
  //
  // The land button is NOT disabled by the land gate, and that is the point
  // ([L31]). An HTML-disabled button takes no pointer events, so a press on it
  // reaches nothing and its tooltip — the one carrying `landBlockedReason` —
  // can never open: the refusal is computed, carried here, and then hung where
  // no gesture can reach it. Blocked, it dims and keeps its cursor cue, and a
  // press runs the land route, which refuses out loud through the one exit
  // that writes the sentence to the bulletin, the dev log, and its caller.
  // `disabled` is kept for the two states that are mechanical rather than
  // judgments — a draft streaming into the editor and a landing already in
  // flight — where the button is reporting itself and there is nothing to say.
  const landingPending = landingSnap?.landPhase === "pending";
  const commitCanLand =
    landingSnap !== null && landingSnap.canLandIgnoringMessage;
  // The rail's words are functions of which landing this is ([P01]). Only the
  // words move — every control, gate, and ordering below is shared.
  const landingWords = LANDING_WORDS[landingMode?.kind ?? "commit"];
  // The rail's three consecutive cycle stops. Undefined base means a
  // non-cycling host, and `undefined + n` would be `NaN` — so the whole rail
  // stays off the walk together, the way the single submit does.
  const commitOrder = (offset: number): number | undefined =>
    commitFocusOrderBase === undefined ? undefined : commitFocusOrderBase + offset;
  const commitToolbarTrailing = (
    <>
      {/* Cancel is not here. The X lives at the Changes shade's trailing
          header edge, where every other close in the deck sits; ⎋ and ⌘. reach
          the same two acts from the keyboard. `commitOrder(0)` therefore goes
          unclaimed — Commit stays on `SESSION_CYCLE_ORDER_SUBMIT` at
          `commitOrder(2)`, which renumbering would move. */}
      <TugActionTooltip
        action={TUG_ACTIONS.COMMIT_AUTO_MESSAGE}
        content={landingDrafting ? "Composing…" : landingWords.autoMessage}
      >
        <TugPushButton
          className="tug-prompt-entry-commit-auto"
          subtype="icon"
          size="lg"
          // Stays lit for the whole composition ([P06]): the button becomes a
          // real filled accent button while the scribe streams (its own tokens,
          // not a hand-rolled pose), and `data-drafting` neutralizes pointer
          // input (CSS) so a click can't re-request.
          emphasis={landingDrafting ? "filled" : "outlined"}
          role="accent"
          // The sparkles twinkle for as long as the scribe is writing. A lit
          // button says "pressed"; it does not say "still going" — and this
          // wait is long enough (a model reading a diff) that a still button
          // is the one thing that would read as stuck. The pencil holds still
          // underneath: the tool is steady, the magic is what flickers.
          activity={landingDrafting ? "twinkle" : undefined}
          data-drafting={landingDrafting ? "" : undefined}
          aria-pressed={landingDrafting || undefined}
          onClick={handleCommitAutoMessage}
          aria-label="Auto-message"
          focusGroup={submitFocusGroup}
          focusOrder={commitOrder(1)}
          data-testid="tug-prompt-entry-commit-auto"
          icon={<PencilSparkles size={16} strokeWidth={2} />}
        />
      </TugActionTooltip>
      <TugTooltip
        // The mode's own sentence when it has one — "Clear what blocks this
        // join first" beats a constant that names no cause, and a disabled
        // land button with no reason is a dead end at the worst moment.
        content={
          commitCanLand
            ? landingWords.land
            : landingSnap?.landBlockedReason ?? landingWords.landUnavailable
        }
        // Authored, and deliberately so: the composer's submit key is the
        // editor's own, text-editing currency handled by the CM6 keymap rather
        // than a registry command ([#non-goals]). There is no binding to read
        // — but there IS a setting, so the label is derived from the same
        // `submitChord` the entry shell's default ring reads, never spelled
        // ⇧⏎ by hand: at `returnAction: submit` a hand-spelled ⇧⏎ names a key
        // that inserts a newline.
        shortcut={commitCanLand ? submitChordLabel : undefined}
      >
        <TugPushButton
          className="tug-prompt-entry-commit-button"
          subtype="icon"
          size="lg"
          emphasis="filled"
          // Return's home in commit mode — the Z5 the composer's own key
          // lands on, exactly as the prompt route's submit is on the prompt
          // route. The two are never co-mounted, so the entry shell still
          // lights exactly one default ([#chord-ring]).
          data-tug-entry-default=""
          data-default-chord={submitChord}
          disabled={landingDrafting || landingPending}
          // Dimmed and cursor-marked, still pressable — see the rail comment.
          data-land-blocked={commitCanLand ? undefined : ""}
          onClick={performSubmit}
          aria-label={landingWords.land}
          focusGroup={submitFocusGroup}
          focusOrder={commitOrder(2)}
          data-testid="tug-prompt-entry-commit-button"
          icon={<ArrowUp size={16} strokeWidth={2.5} />}
        />
      </TugTooltip>
    </>
  );

  // The landing arc's register used to mount here, and does not any more: an
  // account of what the machine is doing is something to *read*, so it belongs
  // in the transcript, where the rest of the session's account is. It lives at
  // the transcript's live edge now (`SessionLandingProgressRow`), reading the
  // same landing snapshot with the same lifetime — including the narration
  // that outlives the mode, which is what let it finish its sentence here.
  // What is left of this row is the host's own status and caution slots.
  //
  // Render the status row only when there is something to put in it.
  const hasStatusRow =
    statusContent !== undefined || cautionContent !== undefined;

  return (
      <ResponderScope>
        <TugEntryShell
          // The shell's forwarded root ref carries BOTH the entry's own
          // rootRef (the substrate's `data-empty` bridge writes through it
          // per [L22]) and the responder-chain registration.
          ref={composedRootRef}
          data-slot="tug-prompt-entry"
          data-phase={snap.phase}
          data-can-interrupt={String(snap.canInterrupt)}
          data-can-submit={String(snap.canSubmit)}
          data-errored={snap.lastError ? "" : undefined}
          data-pending-approval={snap.pendingApproval ? "" : undefined}
          data-pending-question={snap.pendingQuestion ? "" : undefined}
          data-empty="true"
          data-commit-empty="true"
          // Whole-entry stand-down: `inert` blocks mouse, keyboard,
          // and focus for the entire subtree — the route toggle,
          // chips, and submit included — while a restore replays.
          // React 19 boolean prop; dimming rides `data-disabled`
          // ([L06]).
          inert={disabled || undefined}
          data-disabled={disabled ? "" : undefined}
          className={cn("tug-prompt-entry", className)}
          // One continuous drop surface (see the handlers above): a file
          // drag anywhere over the entry — chrome included — accepts and
          // lands in the editor. The substrate's own host-level handlers
          // claim drags over the editor first; these catch the rest.
          onDragOver={handleEntryDragOver}
          onDragLeave={handleEntryDragLeave}
          onDragEnd={clearEntryDropState}
          onDrop={handleEntryDrop}
          statusRow={
            hasStatusRow ? (
              <div className="tug-prompt-entry-status">
                <div className="tug-prompt-entry-status-content">
                  {statusContent}
                </div>
                {cautionContent !== undefined && (
                  <div
                    className="tug-prompt-entry-status-caution"
                    data-slot="tug-prompt-entry-status-caution"
                  >
                    {cautionContent}
                  </div>
                )}
              </div>
            ) : undefined
          }
          inputAreaClassName="tug-prompt-entry-input-area"
          accessoryRow={entryAccessoryRow}
          toolbarClassName="tug-prompt-entry-toolbar"
          toolbarLeading={entryRouteChoice}
          toolbarCenter={indicatorsContent}
          toolbarTrailing={landingActive ? commitToolbarTrailing : entryToolbarTrailing}
        >
            <TugTextEditor
              ref={textEditorRef}
              borderless
              // Auto-height: opens at the host's `--tug-text-editor-min-height`
              // (the Session card sets 200px), grows with content up to its
              // height cap, then scrolls. The cap is `maxRows` rows by
              // default; a host may override the scroller's `max-height`
              // (the Session card caps by card height instead — see
              // `session-card.css` — so the gallery prompt keeps the 20-row cap
              // while the Dev prompt scrolls at a fraction of the card).
              maxRows={20}
              // In commit mode the field is a plain-prose message editor:
              // read-only while the scribe streams a draft, and the slash /
              // mention / argument machinery stands down (submit lands the
              // commit; a `/` popup would be nonsense).
              disabled={deactivated || landingDrafting}
              placeholder={
                landingActive
                  ? // While Auto-Message drafts, the wave caret owns the field —
                    // drop the placeholder the instant drafting starts so the
                    // two never overlap. It returns on exit only if the field
                    // is still empty (an empty doc re-shows it for free).
                    landingDrafting
                    ? ""
                    : landingWords.emptyHint
                  : placeholder ?? ""
              }
              completionProviders={landingActive ? undefined : completionProviders}
              argumentHintResolver={landingActive ? undefined : argumentHintResolver}
              argumentHintRefresh={argumentHintRefresh}
              pastedCommandResolver={landingActive ? undefined : pastedCommandResolver}
              inlineCommandMatcher={landingActive ? undefined : inlineCommandMatcher}
              resolveAtomPath={resolveAtomPath}
              dropHandler={dropHandler}
              attachmentBytesStore={attachmentBytesStore}
              onAttachmentError={publishAttachmentError}
              historyProvider={currentHistoryProvider}
              focusGroup={editorFocusGroup}
              focusOrder={editorFocusOrder}
              // Code Return semantics: Return inserts a newline; Shift+Return
              // (or the Z5 button) submits. A host override wins when supplied.
              returnAction={returnActionOverride ?? "newline"}
              numpadEnterAction={numpadEnterAction}
              // …unless a surface above the entry holds Return ([P14]) — then
              // a plain Return goes where the one ring on screen says it does.
              defaultButtonOwnsReturn={defaultButtonOwnsReturn}
              lineWrap={lineWrap}
              lineNumbers={lineNumbers}
              highlightActiveLineGutter={highlightActiveLineGutter}
              // Code is prose to Claude, so light markdown styling stays on.
              markdownTextStyling
              onSubmit={performSubmit}
              extensions={editorExtensions}
              /* State preservation is owned by TugPromptEntry. Disable
                 the substrate's registration so only one component
                 claims the single CardStatePreservationContext slot. */
              preserveState={false}
            />
        </TugEntryShell>
        {/* Replace-message confirm ([P03]): guards a typed commit message from
            an Auto-Message overwrite, anchored on the pencil-sparkles button. */}
        {landingActive ? (
          <TugConfirmPopover
            open={commitConfirmOpen}
            anchorEl={
              rootRef.current?.querySelector<HTMLElement>(
                '[data-testid="tug-prompt-entry-commit-auto"]',
              ) ?? rootRef.current
            }
            // Pop above the Auto-Message button with a pointer aimed at it, so
            // the confirm reads as belonging to that control ([P06]).
            side="top"
            arrow
            message="Replace message?"
            confirmLabel="Replace"
            confirmRole="danger"
            onConfirm={() => {
              setCommitConfirmOpen(false);
              landingModeRef.current?.requestDraft(true);
            }}
            onCancel={() => setCommitConfirmOpen(false)}
          />
        ) : null}

      </ResponderScope>
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the live DOM Selection's range as a `{ start, end }` pair if
 * it falls inside `view.contentDOM`, otherwise `null`. Used by the
 * `engine-restore-applied` deck-trace event to compare what the
 * restore *intended* against what landed in the DOM.
 *
 * `selectionApplied` carries flat offsets; the DOM Selection echo
 * here is the substrate's own view of the post-restore selection
 * (which goes through the focus / global-Selection path on active
 * cards). Returning a flat-offset pair keeps the two values
 * comparable.
 */
function readDomSelectionInside(
  view: EditorView | null,
): { start: number; end: number } | null {
  if (view === null) return null;
  // CM6 keeps `view.state.selection` in sync with the DOM Selection
  // when the view is the focused element; reading from it is the
  // canonical way to expose "what the substrate now believes is
  // selected" without fighting the contentDOM's `Selection` object
  // directly.
  const main = view.state.selection.main;
  return { start: main.from, end: main.to };
}

// HistoryEntry import is exercised through the historyStore.push
// shape above; keep the import-side only by re-exporting the type
// here — TypeScript drops the import otherwise and the dev-build
// import-checker complains.
export type { HistoryEntry };
