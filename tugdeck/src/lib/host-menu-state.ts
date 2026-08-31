/**
 * Host menu state — the aggregator behind the `menuState` WKScriptMessage
 * push.
 *
 * The Swift host validates its menu bar from a cached snapshot of
 * frontend state (`AppDelegate.swift`, `MenuState` struct +
 * `validateMenuItem(_:)`). This module owns the frontend half of that
 * wire contract: it projects the deck store into the menu-relevant
 * shape, diffs, coalesces, and posts to
 * `webkit.messageHandlers.menuState`. Keep the payload fields in sync
 * with the Swift parser.
 *
 * Why an aggregator module rather than a push inside
 * `DeckManager.notify()`: menu enablement depends on more than deck
 * structure — the session card's session state (bound, can-interrupt,
 * permission mode) changes without any deck mutation, so a second
 * publisher has to feed the same channel. One module owning the merged
 * payload keeps one wire channel and one diff.
 *
 * Why diff + coalesce: deck notifications fire on every mutation and
 * session stores emit on every streaming token, but the menu-relevant
 * projection changes far less often. Posting only when the serialized
 * projection changes — coalesced on a microtask — keeps WKScriptMessage
 * traffic proportional to menu-relevant change, not store churn.
 *
 * No React consumer reads this state; it mirrors stores outward to the
 * host and never drives render.
 */

import type { DeckState } from "../layout-tree";
import { bullseyePaneIdOf, slotStackOf } from "../deck-store-selectors";
import { paneTitleBarTextFor } from "./pane-title";
import { cardTitleStore } from "./card-title-store";
import { TUG_ACTIONS } from "../components/tugways/action-vocabulary";
import { cardSessionBindingStore } from "./card-session-binding-store";
import { visibleCardCount } from "./card-ring";
import { isSidebarCard } from "../card-registry";
import {
  impositionLayout,
  slotCount,
  type ContentWidth,
} from "./layout-imposer";
import { BASE_THEME_NAME } from "../theme-constants";
import {
  COMMANDS,
  EMPTY_MENU_FACTS,
  queryCommandState,
  validateCommand,
} from "../components/tugways/command-registry";
import { keymapRegistry } from "../components/tugways/keymap-registry";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";
import { chordCaptureState } from "../components/tugways/chord-capture-state";
import { getSettings, lastKnownMakerMode } from "./maker-mode-bridge";
import { resolveColumnMenuFact } from "./layout-selection";
import {
  cardsSelectionStore,
  subscribeLayoutCursorCard,
} from "../components/cards/cards-selection-store";
import type { IDeckManagerStore } from "../deck-manager-store";
import type {
  CommandEntry,
  CommandMenuFacts,
  CommandValidationSource,
} from "../components/tugways/command-registry";

/**
 * Edit-menu capability block: per-action enablement for the native
 * Edit menu (and the Find submenu), derived from the responder chain's
 * `validateAction` — the suite's single source of truth for whether the
 * focused surface handles an edit action (design decision D05). Each
 * flag is `true` iff a focused responder currently handles that action;
 * `false` when nothing in focus does (e.g. only the Settings card is
 * up), which is exactly when the menu item should be disabled.
 *
 * The Swift host validates the Edit items against this block, the same
 * pull-based way it validates the close items against `panes`. The
 * clipboard actions still execute natively (Swift re-dispatches the
 * AppKit selector) so the system pasteboard and the in-gesture clipboard
 * path are preserved — for those, this block governs *enablement only*.
 *
 * Undo / Redo are here AND card-specific. The platform's NSUndoManager
 * (which AppKit would otherwise validate `undo:` against) is per-web-view:
 * it accumulates the whole view's edit history and knows nothing about
 * card activation, so a deactivated card's undo state would keep leaking
 * into the menu. The responder chain is card-scoped by construction — the
 * first responder lives inside the active card — so undo/redo ride this
 * block like the other edit actions, with the depth-accuracy supplied by
 * each editor's `validateAction` (CM6 reports `undoDepth`/`redoDepth` of
 * its own per-instance history).
 *
 * Native `<input>`/`<textarea>` take the third path: their undo stack is
 * the browser's (JS-opaque), reachable through the web view's
 * NSUndoManager. When the focused element is a native text control,
 * `nativeUndoToken` is non-zero and the Swift side validates Undo/Redo
 * LIVE from `webView.undoManager.canUndo`/`canRedo` and executes the
 * native `undo:`/`redo:` selectors. The token changes whenever the
 * focused native control changes (and drops to 0 on blur); the host
 * clears the web view's undo stack on every token change, so the
 * per-web-view stack never outlives focus in one control — that is what
 * keeps the native path card-safe.
 *
 * A chord whose menu item validates DISABLED is eaten at the menu bar
 * with a beep (standard macOS) — it does NOT fall through to the web
 * view. That is why the native path must light the item: a dark Undo
 * means a dead ⌘Z.
 */
export interface MenuStateEditBlock {
  cut: boolean;
  copy: boolean;
  paste: boolean;
  delete: boolean;
  selectAll: boolean;
  undo: boolean;
  redo: boolean;
  /** Menu-title noun for Undo ("Typing", "Paste", …); "" → plain "Undo". */
  undoLabel: string;
  /** Menu-title noun for Redo; "" → plain "Redo". */
  redoLabel: string;
  /**
   * Non-zero iff the focused element is an editable native text control
   * (`<input>`/`<textarea>`). Changes value when the focused control
   * changes. Drives the Swift side's NSUndoManager undo path and its
   * clear-on-blur.
   */
  nativeUndoToken: number;
  find: boolean;
  findNext: boolean;
  findPrevious: boolean;
}

/** All-disabled default — nothing focused handles any edit action. */
export const EMPTY_EDIT_CAPABILITIES: MenuStateEditBlock = {
  cut: false,
  copy: false,
  paste: false,
  delete: false,
  selectAll: false,
  undo: false,
  redo: false,
  undoLabel: "",
  redoLabel: "",
  nativeUndoToken: 0,
  find: false,
  findNext: false,
  findPrevious: false,
};

/** Minimal slice of the responder chain the cap computation needs. */
export interface EditCapabilitySource {
  validateAction(action: string): boolean;
}

/**
 * Compute the edit-menu capability block from the responder chain.
 * Pure (given the chain's current focus) — exported for unit tests.
 * Each flag mirrors `chain.validateAction(<action>)`, which returns
 * false when no focused responder handles the action.
 */
export function computeEditCapabilities(
  chain: EditCapabilitySource,
): MenuStateEditBlock {
  return {
    cut: chain.validateAction(TUG_ACTIONS.CUT),
    copy: chain.validateAction(TUG_ACTIONS.COPY),
    paste: chain.validateAction(TUG_ACTIONS.PASTE),
    delete: chain.validateAction(TUG_ACTIONS.DELETE),
    selectAll: chain.validateAction(TUG_ACTIONS.SELECT_ALL),
    undo: chain.validateAction(TUG_ACTIONS.UNDO),
    redo: chain.validateAction(TUG_ACTIONS.REDO),
    // Filled in by the publisher (responder-chain provider): labels come
    // from the focused editor's registry entry, the token from the
    // focused-native-control tracker.
    undoLabel: "",
    redoLabel: "",
    nativeUndoToken: 0,
    find: chain.validateAction(TUG_ACTIONS.FIND),
    findNext: chain.validateAction(TUG_ACTIONS.FIND_NEXT),
    findPrevious: chain.validateAction(TUG_ACTIONS.FIND_PREVIOUS),
  };
}

// ---------------------------------------------------------------------------
// The per-command menu gate mirror ([P13], Spec S03)
// ---------------------------------------------------------------------------

/**
 * A chord in the host's alphabet. Declared where the conversion that
 * produces it lives, so the wire shape and the only function that can fill
 * it are never two separate opinions.
 */
import type { ChordSpec } from "@/components/tugways/chord-format";
export type { ChordSpec };

/**
 * One menu item's gate: everything the host needs to present the item,
 * keyed on the wire by the item's `NSUserInterfaceItemIdentifier` ([P02]).
 *
 * All four facts change together and are read by the same two host sites —
 * the validator for enablement, state, and title; the chord sweep for the
 * key equivalent — so they ride as one object rather than four blocks.
 */
export interface MenuCommandGate {
  /**
   * Absent means the command has no opinion on enablement and the host's own
   * tier still owns the item.
   *
   * The two halves of a gate move independently: an item's *chord* can be
   * the registry's while its *enablement* is not. View ▸ Zoom In is the
   * case — its predicate reads `window.currentPageZoom`, host state the
   * frontend cannot see — and publishing `enabled: true` for it would light
   * an item its own tier was gating. So a chord-only gate says nothing about
   * enablement rather than guessing at it.
   */
  readonly enabled?: boolean;
  /** Checkmark; absent means "this item does not participate in the check column". */
  readonly state?: boolean;
  /** Dynamic title; absent means "keep the title the host constructed". */
  readonly title?: string;
  /**
   * Three-state, and all three are load-bearing: absent means "leave the
   * constructed key equivalent alone", `null` means "detach it", and a spec
   * means "apply it".
   */
  readonly chord?: ChordSpec | null;
}

/**
 * The chain half of a predicate's world. The publisher owns the facts half
 * and joins the two at flush time, so a predicate never reaches for a store
 * itself.
 */
export interface MenuValidationChain {
  validateAction(action: string): boolean;
  validateActionInKeyCard(action: string): boolean;
  queryActionState(action: string): boolean | string | undefined;
  queryActionStateInKeyCard(action: string): boolean | string | undefined;
}

/** A chain that answers "nobody handles anything" — the pre-mount state. */
const NO_CHAIN: MenuValidationChain = {
  validateAction: () => false,
  validateActionInKeyCard: () => false,
  queryActionState: () => undefined,
  queryActionStateInKeyCard: () => undefined,
};

/** Whether an entry's *enablement* rides the mirror. */
function isMirroredEntry(entry: CommandEntry): boolean {
  return (
    entry.mirrored === true &&
    entry.menuItemId !== undefined &&
    entry.parameterized !== true
  );
}

/**
 * The `chord` half of one item's gate, as a spreadable fragment so the three
 * wire states stay three ([P10], Spec S03).
 *
 * *Absent* is the answer for every command whose chord the host still owns:
 * the key equivalent it was constructed with stays put. *Null* releases the
 * chord, and it is a distinct sentence from "the item is dark" — a chord left
 * on a dimmed item is eaten at the menu bar with a beep rather than falling
 * through to the web view, so a command that wants to be shadowable while
 * inapplicable has to hand the chord back. *A spec* applies it.
 *
 * Two conditions release a chord, and they are different questions. A
 * `disabledChord: "detach"` command releases it while its own item validates
 * dark. A `chordActive` command releases it while some other condition says
 * the chord is not its right now — which is how ⌘R moves between the two
 * slot-stack items and how ⇧⌘S follows the frontmost Text card.
 */
function chordField(
  entry: CommandEntry,
  chain: CommandValidationSource,
  enabled: boolean | undefined,
  chords: Record<string, ChordSpec | null>,
  menuItemId: string,
): { chord?: ChordSpec | null } {
  if (!(menuItemId in chords)) return {};
  const detachedByGate = enabled === false && entry.disabledChord === "detach";
  const claimed = entry.chordActive?.(chain) ?? true;
  return { chord: detachedByGate || !claimed ? null : chords[menuItemId] };
}

/**
 * Project the registry's mirrored entries into the per-item gate block the
 * host validates from.
 *
 * Enablement comes from the entry's own `validate` when it has one, and
 * otherwise from the chain walk that matches its routing ([P06]) — validity
 * is asked of the object that would perform, which is the idiom the chain
 * already implements and the registry defers to rather than duplicates.
 *
 * State narrows to a boolean here because a per-value entry turns "the
 * current value is X" into "this item is checked"; the hook keeps the wider
 * return type for the off-menu readers that want the value itself.
 *
 * An entry that is not mirrored still gets a gate when the keymap has
 * claimed its item's chord, carrying the chord alone: enablement and chord
 * migrate on their own schedules, and View ▸ Zoom In — registry chord, host
 * predicate — is permanently in that state rather than passing through it.
 *
 * Pure given the chain's current answers — exported for unit tests.
 */
export function computeCommandCapabilities(
  chain: CommandValidationSource,
  entries: readonly CommandEntry[] = COMMANDS,
  chords: Record<string, ChordSpec | null> = keymapRegistry.menuChords(),
): Record<string, MenuCommandGate> {
  const gates: Record<string, MenuCommandGate> = {};
  for (const entry of entries) {
    const mirrored = isMirroredEntry(entry);
    const menuItemId = entry.menuItemId;
    if (menuItemId === undefined) continue;
    if (!mirrored && !(menuItemId in chords)) continue;
    // A throwing predicate loses its own item's gate and nothing else. The
    // whole block is computed inside the payload flush, so letting one
    // predicate escape would abort the push and freeze every menu fact the
    // host has — the item that falls back to its own default is a far
    // smaller failure than a menu bar stuck on a stale snapshot.
    try {
      const enabled = mirrored ? validateCommand(entry, chain) : undefined;
      const rawState = mirrored ? queryCommandState(entry, chain) : undefined;
      const title = mirrored ? entry.dynamicTitle?.(chain) : undefined;
      gates[menuItemId] = {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(typeof rawState === "boolean" ? { state: rawState } : {}),
        ...(title !== undefined ? { title } : {}),
        ...chordField(entry, chain, enabled, chords, menuItemId),
      };
    } catch (error) {
      tugDevLogStore.error(
        "menu-state",
        `command "${entry.id}" threw while computing its menu gate`,
        { error: String(error) },
      );
    }
  }
  return gates;
}

// ---------------------------------------------------------------------------
// Undo/redo menu-label registry
// ---------------------------------------------------------------------------

/** Menu-title nouns for an editor's next undo/redo steps. */
export interface EditUndoLabels {
  undo: string;
  redo: string;
}

/**
 * Per-editor undo/redo label registry, keyed by a DOM element inside the
 * editor (CM6 registers `view.dom`). The publisher resolves the focused
 * responder's element and picks the entry contained within it, so labels
 * are only ever shown for the editor that actually owns the lit Undo —
 * a registry keyed by element (not a single "current" slot) is what keeps
 * two mounted editors from leaking titles into each other.
 */
const editUndoLabelRegistry = new Map<Element, EditUndoLabels>();

/** Publish (or clear, with null) an editor's undo/redo menu labels. */
export function setEditUndoLabels(el: Element, labels: EditUndoLabels | null): void {
  if (labels === null) {
    editUndoLabelRegistry.delete(el);
  } else {
    editUndoLabelRegistry.set(el, labels);
  }
}

/**
 * Resolve the labels for the editor inside (or at) the given responder
 * element. Returns empty labels when no registered editor is in scope.
 */
export function editUndoLabelsWithin(scope: Element): EditUndoLabels {
  for (const [el, labels] of editUndoLabelRegistry) {
    if (scope === el || scope.contains(el)) return labels;
  }
  return { undo: "", redo: "" };
}

/** One pane entry, z-order topmost first (matches the Swift reader). */
export interface MenuStatePaneEntry {
  id: string;
  title: string;
  focused: boolean;
  cardCount: number;
  closable: boolean;
}

/** The focused pane's active card; null when the deck has no panes. */
export interface MenuStateActiveCard {
  component: string;
  closable: boolean;
}

/**
 * Session-card session block, published by the session card's menu-state
 * effect. Rides the payload only while its card is the focused pane's
 * active card.
 */
export interface MenuStateSessionBlock {
  cardId: string;
  /** A session binding exists for the card. */
  sessionBound: boolean;
  /** The session's turn can be interrupted (Stop enablement). */
  canInterrupt: boolean;
  /**
   * The Mode / Model / Effort settings may be changed — the session is idle
   * (`canSubmit`). Gates the Permission Mode submenu the same way the Z4B
   * chips gate on it, so a mode change never races a running turn.
   */
  canChangeSettings: boolean;
  /** Effective mode: live metadata ?? persisted ?? "default". */
  permissionMode: string;
  /**
   * The composite `model · effort · mode` line the AI chip shows — the same
   * `formatAiConfigSummary` output, so the Session menu's AI item and the chip
   * cannot word the same state differently. Empty when nothing is known yet.
   */
  aiSummary: string;
  /** The transcript holds at least one assistant message. */
  hasAssistantMessage: boolean;
  /** The transcript holds at least one completed turn (rewind gate). */
  hasTurns: boolean;
  /**
   * The Changes Shade is showing ([P05], Spec S04). Drives the Swift Session
   * menu's dynamic verb — "Hide Changes" when true, "Show Changes" when false.
   */
  changesVisible: boolean;
  /** The History Shade is showing — drives the "Show/Hide History" verb. */
  historyVisible: boolean;
  /**
   * Commit mode is active, the session is idle, the changeset is non-empty and
   * a message is written — every gate Session ▸ Commit Changes needs. Folded
   * into one boolean by `CommitModeController`, which owns all four facts;
   * spreading them across the payload would invite a second opinion here.
   */
  commitReady: boolean;
  /**
   * The bound session carries a user-set name, so there is something to clear.
   * Gates Session ▸ Unname Session: an item that does nothing is its own small
   * lie.
   */
  hasCustomName: boolean;
}

/**
 * Text-card block, published by the Text card's menu-state effect. Rides
 * the payload only while its card is the focused pane's
 * active card, exactly like the dev block. Gates the classic File menu
 * items (Save / Save As… / Save a Copy… / Revert / Reload).
 */
export interface MenuStateFileBlock {
  cardId: string;
  /** Save contract — automatic Save is always live; manual gates on dirty. */
  mode: "manual" | "automatic";
  /** Unsaved changes (manual). Automatic mode is always `false`. */
  dirty: boolean;
  /** Untitled buffer (manual, `path === null`) — Save runs the panel. */
  untitled: boolean;
  readOnly: boolean;
  /** A disk file is bound — gates Revert / Reload. */
  hasPath: boolean;
  /** An unresolved external-change conflict — Save disabled until resolved. */
  conflict: boolean;
}

/**
 * A document surface that owns zoom for itself — today the viewer card's PDF
 * branch. Its presence is what tells the host to route View ▸ Zoom In / Zoom
 * Out / Actual Size into the deck instead of scaling the whole web view.
 *
 * The host owns those chords: AppKit resolves a menu key equivalent before
 * the WKWebView sees a keydown, so a deck-side binding for the same chord
 * can never fire and no amount of `preventDefault` reaches it. Publishing
 * this block is therefore the only way a card can claim ⌘+ / ⌘- / ⌘0.
 */
export interface MenuStateDocumentBlock {
  cardId: string;
}

/** Per-item enablement for the File menu, derived from a block. */
export interface FileMenuGates {
  save: boolean;
  saveAs: boolean;
  saveACopy: boolean;
  revert: boolean;
  reload: boolean;
}

/**
 * Compute the File menu enablement from a block. Pure; exported
 * to unit-test the gate matrix the Swift `validateMenuItem` mirrors —
 * notably that automatic-mode Save stays enabled (else its ⌘S would beep
 * instead of flushing) while a clean titled manual card disables it.
 *
 * A manual-mode conflict ENABLES Save rather than gating it off: the user
 * may have cancelled the conflict sheet (the badge state), and Save is
 * then the re-entry — it re-issues the conditional write, which
 * re-adjudicates against the current disk and re-presents the sheet. With
 * Save gated off there, "Save Anyway" would be unreachable after a Cancel.
 * Automatic mode keeps the conflict gate: its flush no-ops on conflict, so
 * an enabled Save would be a live shortcut to a stub.
 */
export function computeFileMenuGates(block: MenuStateFileBlock): FileMenuGates {
  return {
    save:
      !block.readOnly &&
      (block.mode === "automatic"
        ? !block.conflict
        : block.dirty || block.untitled || block.conflict),
    saveAs: true,
    saveACopy: true,
    revert: block.dirty && block.hasPath,
    reload: block.hasPath,
  };
}

/** Deck-derived half of the payload (everything except the dev block). */
export interface MenuStateDeckProjection {
  panes: MenuStatePaneEntry[];
  activeCard: MenuStateActiveCard | null;
  /**
   * Whether a card is selected — `activePaneId` is set. A canvas-background
   * click deselects (clears it); the host enables the card / pane navigation
   * commands when this is `false` (with panes present) so a deselected deck
   * can re-activate a card by keyboard or menu.
   */
  selectionActive: boolean;
  /**
   * Panes sharing the focused pane's slot. 0 when the focused pane holds no
   * slot (free pane or Lens) and when nothing is selected. Gates the
   * Window menu's three stack items, enabled iff this exceeds 1.
   */
  stackDepth: number;
  /**
   * Cards in the deck's lateral ring — every tab of every visible pane,
   * sidebars included (see `lib/card-ring.ts`). Gates Window ▸
   * Previous/Next Card.
   */
  visibleCardCount: number;
  /**
   * Id of the focused pane's active card — used by the publisher to
   * select which dev block rides the payload. Module-internal: never
   * serialized onto the wire.
   */
  focusedActiveCardId: string | null;
  /**
   * The focused pane's named width, gating and check-marking Window ▸
   * Slim / Comfy / Wide. Null when the commands do not apply; a null
   * `preset` inside means a hand-dragged width (see
   * {@link CommandMenuFacts.cardWidth}). Module-internal: the mirror
   * carries the gates, so this never rides the wire.
   */
  cardWidth: { preset: ContentWidth | null } | null;
  /**
   * Whether the focused pane stands in bullseye, gating and check-marking
   * Window ▸ Bullseye. Null when the command does not apply — the same two
   * gates {@link MenuStateDeckProjection.cardWidth} uses. Module-internal:
   * the mirror carries the gates, so this never rides the wire.
   */
  bullseye: { on: boolean } | null;
  /**
   * How many slots the deck can travel to — `slotCount(kind)` under flow, and 0
   * otherwise. Gates Window ▸ Go to Slot 1…6: a slot the arrangement does not
   * have is nothing to travel to, and under FIT nothing travels at all, since
   * every slot's anchor is already inside the band. Module-internal: the
   * mirror carries the gates, so this never rides the wire.
   */
  reachableSlots: number;
}

/** The full wire payload posted to `webkit.messageHandlers.menuState`. */
export interface MenuStatePayload {
  panes: MenuStatePaneEntry[];
  activeCard: MenuStateActiveCard | null;
  /** Whether a card is selected (see {@link MenuStateDeckProjection.selectionActive}). */
  selectionActive: boolean;
  /** Focused pane's slot-stack depth (see {@link MenuStateDeckProjection.stackDepth}). */
  stackDepth: number;
  /** Session-card session block; null unless the active card is a session card. */
  session: MenuStateSessionBlock | null;
  /** Text-card block; null unless the active card is a Text card. */
  file: MenuStateFileBlock | null;
  /**
   * Document-surface block; null unless the active card hosts a surface that
   * owns its own zoom. Routes the host's zoom commands into the deck.
   */
  document: MenuStateDocumentBlock | null;
  /** Edit-menu capabilities of the current first responder. */
  edit: MenuStateEditBlock;
  /**
   * Per-menu-item gates projected from the command registry, keyed by the
   * item's `NSUserInterfaceItemIdentifier` ([P13]). The host reads this
   * ahead of its hand-rolled validation cases; an item absent from the
   * block falls through to whichever case still owns it.
   */
  commands: Record<string, MenuCommandGate>;
  /**
   * Recent-document paths (newest first) for File ▸ Open Recent. The host
   * filters to files that still exist and caps the visible list.
   */
  recentDocuments: string[];
  /**
   * The active theme's name, for the Theme submenu's checkmark. The
   * submenu's *membership* is still discovered from disk by the host — it
   * is genuinely dynamic — but which one is current is the frontend's fact,
   * and the frontend changes it by paths the host never sees.
   */
  activeTheme: string;
  /**
   * Whether Open Quickly is available. Always true: the frontmost card's
   * project is the search root when there is one, and the user's default
   * project directory is the root when there is not — so there is no deck
   * state in which the command has nowhere to look. Gates File ▸ Open
   * Quickly, which keeps the field so the host contract is unchanged.
   */
  openQuickly: boolean;
  /**
   * A chord-capture surface is armed: the Keyboard pane is recording a
   * chord, and every key the user presses is an answer rather than a
   * command. While true, the host parks every key equivalent in the menu
   * bar (restoring them on disarm), so a chord that currently means
   * something falls through to the web view to be recorded instead of
   * firing — AppKit's key-equivalent scan runs before the web view sees a
   * keydown, and detaching is the only way through it. A chord on an item
   * the host never releases this way (there are none today) would be eaten,
   * not recorded.
   */
  captureArmed: boolean;
}

/**
 * Project the deck store snapshot into the menu-relevant shape.
 *
 * Exported for unit tests. The pane projection (focused = last pane in
 * z-order, reverse to topmost-first) carries the exact semantics the host's
 * close-item validation and pane-list menu were built against.
 *
 * Pane names come from {@link paneTitleBarTextFor} — the same string the
 * pane's own title bar renders — so the Window menu, the slot-stack picker,
 * and the title bar cannot disagree about what a pane is called. That read
 * folds in the live `cardTitleStore` override, which is not deck state; the
 * publisher wiring below subscribes to that store as well as to the deck, so
 * a card that renames itself renames its menu entry.
 */
export function projectDeckState(state: DeckState): MenuStateDeckProjection {
  const stacks = state.panes;
  const cardsById = new Map(state.cards.map((c) => [c.id, c]));
  const focusedStack = stacks.length > 0 ? stacks[stacks.length - 1] : null;
  const focusedId = focusedStack ? focusedStack.id : null;
  const panes = stacks
    .map((s) => {
      const activeCard = cardsById.get(s.activeCardId);
      return {
        id: s.id,
        title: paneTitleBarTextFor(s, cardsById),
        focused: s.id === focusedId,
        cardCount: s.cardIds.length,
        closable: activeCard?.closable ?? false,
      };
    })
    .reverse();

  const focusedActiveCard = focusedStack
    ? cardsById.get(focusedStack.activeCardId)
    : undefined;
  const activeCard: MenuStateActiveCard | null = focusedActiveCard
    ? {
        component: focusedActiveCard.componentId,
        closable: focusedActiveCard.closable,
      }
    : null;

  // How many panes share the focused pane's slot.
  //
  // The two "focused"s here are not the same concept, so the invariant is
  // worth stating: `focusedStack` is `panes[panes.length - 1]` (z-order top),
  // while the chord this gates dispatches to the FIRST RESPONDER, which is
  // `activePaneId`'s pane. They agree because every raise path moves the pane
  // to the end of the array and writes `activePaneId` in the same commit, so
  // whenever `activePaneId` is set its pane IS the last element. The
  // `undefined` guard covers the one state where they part — a deselected
  // deck, where the array still has a last element and no pane is the first
  // responder. Reveal Stack acts on a specific pane's stack; with nothing
  // selected there is no such pane, and a command that silently picks one for
  // the user is the non-obvious-target failure.
  const stackDepth =
    state.activePaneId === undefined
      ? 0
      : slotStackOf(state, focusedStack?.slot).length;

  // The focused pane's width, on the same two gates the title bar's width
  // popup already renders itself behind: a pane is width-settable when one
  // is selected and it is not a rail. Reading the same conditions here is
  // what keeps the menu's three rows and the popup's three rows from ever
  // disagreeing about which is checked.
  const focusedIsRail =
    focusedStack?.cardIds.some((cid) => {
      const card = cardsById.get(cid);
      return card !== undefined && isSidebarCard(card.componentId);
    }) ?? false;
  const cardWidth =
    state.activePaneId === undefined || focusedStack === null || focusedIsRail
      ? null
      : { preset: focusedStack.widthPreset ?? null };

  // Bullseye rides ONE of the width row's gates — "is there a pane the
  // selection is in" — and not the rail gate. A rail has no width preset to
  // set, which is why `cardWidth` refuses it; it does have a posture, and it
  // keeps its place on the edge while it holds one. `on` reads the DERIVED
  // id, so the menu's check mark can never disagree with the geometry — one
  // rule answers both.
  const bullseye =
    state.activePaneId === undefined || focusedStack === null
      ? null
      : { on: bullseyePaneIdOf(state) === focusedStack.id };

  // Centering is a fact about the ARRANGEMENT, not about the selection, so it
  // takes none of the gates above: it moves the band, and the band is the
  // deck's. Under fit the strip does not exist and no slot has anywhere to
  // travel to, which is why the count is the kind's only under flow.
  const reachableSlots =
    state.imposition.kind === undefined ||
    impositionLayout(state.imposition) !== "flow"
      ? 0
      : slotCount(state.imposition.kind);

  return {
    panes,
    activeCard,
    selectionActive: state.activePaneId !== undefined,
    stackDepth,
    visibleCardCount: visibleCardCount(state),
    focusedActiveCardId: focusedActiveCard?.id ?? null,
    cardWidth,
    bullseye,
    reachableSlots,
  };
}

/**
 * Diff-and-coalesce publisher. Holds the latest inputs, schedules a
 * microtask flush on any change, and posts through the injected sink
 * only when the serialized payload differs from the last one sent.
 *
 * The sink is injected so unit tests can observe posts directly; the
 * production sink is {@link postToHost}.
 */
export class HostMenuStatePublisher {
  private readonly post: (payload: MenuStatePayload) => void;
  private deckProjection: MenuStateDeckProjection = {
    panes: [],
    activeCard: null,
    selectionActive: false,
    stackDepth: 0,
    visibleCardCount: 0,
    focusedActiveCardId: null,
    cardWidth: null,
    bullseye: null,
    reachableSlots: 0,
  };
  /**
   * Per-card dev blocks. Every mounted session card publishes its own
   * block unconditionally; the flush (not the card) decides which one
   * rides the payload, by checking the focused pane's active card.
   */
  private readonly sessionBlocks = new Map<string, MenuStateSessionBlock>();
  /**
   * Per-card File blocks, same rider discipline as {@link sessionBlocks}:
   * every mounted Text card publishes its own; the flush picks the one
   * whose card is the focused pane's active card.
   */
  private readonly fileBlocks = new Map<string, MenuStateFileBlock>();
  /**
   * Per-card document-surface blocks, same rider discipline. Published by
   * the surface that owns zoom rather than by the card, so a viewer card
   * claims the host's zoom chords only while it is actually showing a
   * document that can be zoomed.
   */
  private readonly documentBlocks = new Map<string, MenuStateDocumentBlock>();
  /**
   * Edit-menu capabilities of the current first responder. A single
   * publisher (the responder-chain provider) feeds this; defaults to
   * all-disabled until the first push.
   */
  private editCapabilities: MenuStateEditBlock = EMPTY_EDIT_CAPABILITIES;
  /**
   * The chain the command predicates ask. Registered by the responder-chain
   * provider at mount; until then the gates compute against a chain that
   * handles nothing, which is the truth before anything is mounted.
   */
  private validationChain: MenuValidationChain = NO_CHAIN;
  /** The facts the last flush computed its gates from. */
  private lastFacts: CommandMenuFacts = EMPTY_MENU_FACTS;
  /**
   * What the column verbs could do right now, asked rather than stored.
   *
   * A source and not a value because the fact reads the layout selection's
   * ladder, whose lower rungs are not deck state: the Cards list's cursor is a
   * module variable nothing subscribes to. Reading it at flush time means the
   * answer is as fresh as whatever triggered the flush, and the two inputs
   * that move on their own — the selection store and the cursor — schedule one
   * (see {@link initHostMenuState}).
   */
  private columnFactSource: (() => CommandMenuFacts["column"]) | null = null;
  /** Recent-document MRU, mirrored outward for the Open Recent submenu. */
  private recentDocuments: string[] = [];
  /** The active theme, for the Theme submenu's checkmark. */
  private activeTheme: string = BASE_THEME_NAME;
  /** Whether a chord capture is armed (see {@link MenuStatePayload.captureArmed}). */
  private captureArmed = false;
  /** The gates of the last flush, for {@link lastGateFor}. */
  private lastGates: Record<string, MenuCommandGate> = {};
  private lastSent: string | null = null;
  private flushScheduled = false;

  constructor(post: (payload: MenuStatePayload) => void) {
    this.post = post;
  }

  /** Register the closure the flush asks for {@link CommandMenuFacts.column}. */
  setColumnFactSource(source: () => CommandMenuFacts["column"]): void {
    this.columnFactSource = source;
    this.scheduleFlush();
  }

  setDeckProjection(projection: MenuStateDeckProjection): void {
    this.deckProjection = projection;
    this.scheduleFlush();
  }

  setSessionBlock(cardId: string, block: MenuStateSessionBlock): void {
    this.sessionBlocks.set(cardId, block);
    this.scheduleFlush();
  }

  clearSessionBlock(cardId: string): void {
    if (!this.sessionBlocks.delete(cardId)) return;
    this.scheduleFlush();
  }

  setDocumentBlock(cardId: string, block: MenuStateDocumentBlock): void {
    this.documentBlocks.set(cardId, block);
    this.scheduleFlush();
  }

  clearDocumentBlock(cardId: string): void {
    if (!this.documentBlocks.delete(cardId)) return;
    this.scheduleFlush();
  }

  setFileBlock(cardId: string, block: MenuStateFileBlock): void {
    this.fileBlocks.set(cardId, block);
    this.scheduleFlush();
  }

  clearFileBlock(cardId: string): void {
    if (!this.fileBlocks.delete(cardId)) return;
    this.scheduleFlush();
  }

  setEditCapabilities(caps: MenuStateEditBlock): void {
    this.editCapabilities = caps;
    this.scheduleFlush();
  }

  setValidationChain(chain: MenuValidationChain | null): void {
    this.validationChain = chain ?? NO_CHAIN;
    this.scheduleFlush();
  }

  setCaptureArmed(armed: boolean): void {
    this.captureArmed = armed;
    this.scheduleFlush();
  }

  /**
   * The gate an item carried in the last flush, for readers outside the
   * push — the native layer of `resolveChord` joins each menu chord claim
   * to the enablement its own mirror computed, so the pane's shadowing
   * answer and the menu bar cannot disagree about the same item.
   */
  lastGateFor(menuItemId: string): MenuCommandGate | undefined {
    return this.lastGates[menuItemId];
  }

  /**
   * Recompute and republish because something the gates read outside this
   * publisher changed — today, a keymap binding. The flush is already
   * coalesced and diffed, so a call that changes nothing costs nothing.
   */
  refresh(): void {
    this.scheduleFlush();
  }

  setActiveTheme(theme: string): void {
    this.activeTheme = theme;
    this.scheduleFlush();
  }

  setRecentDocuments(paths: string[]): void {
    this.recentDocuments = paths;
    this.scheduleFlush();
  }

  /**
   * Join the registered chain to the flush's facts into the one value a
   * predicate reads.
   *
   * Delegating call by call rather than spreading the chain: the manager is
   * a class instance, so its methods live on the prototype and an object
   * spread would silently produce a source whose every query is undefined.
   */
  /**
   * The source as of the last flush, for in-page surfaces that show the
   * same commands the menu bar does. The facts are a snapshot; the chain
   * queries are live, which is what an in-page menu wants — it samples at
   * open time, and open time is after the flush that set the facts.
   */
  currentValidationSource(): CommandValidationSource {
    return this.validationSource(this.lastFacts);
  }

  private validationSource(menu: CommandMenuFacts): CommandValidationSource {
    const chain = this.validationChain;
    return {
      validateAction: (action) => chain.validateAction(action),
      validateActionInKeyCard: (action) => chain.validateActionInKeyCard(action),
      queryActionState: (action) => chain.queryActionState(action),
      queryActionStateInKeyCard: (action) => chain.queryActionStateInKeyCard(action),
      menu,
    };
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  private flush(): void {
    const {
      panes,
      activeCard,
      selectionActive,
      stackDepth,
      visibleCardCount,
      focusedActiveCardId,
      cardWidth,
      bullseye,
      reachableSlots,
    } = this.deckProjection;
    const session =
      activeCard?.component === "session" && focusedActiveCardId !== null
        ? (this.sessionBlocks.get(focusedActiveCardId) ?? null)
        : null;
    const file =
      activeCard?.component === "text" && focusedActiveCardId !== null
        ? (this.fileBlocks.get(focusedActiveCardId) ?? null)
        : null;
    // Keyed by card rather than by component id: the block is published by
    // the surface that owns zoom, so the card only claims the chords while
    // that surface is actually mounted (a viewer card showing an image does
    // not).
    const document =
      focusedActiveCardId !== null
        ? (this.documentBlocks.get(focusedActiveCardId) ?? null)
        : null;
    // Open Quickly always has a root: the frontmost card's project, or the
    // default project directory when no card is bound.
    const openQuickly = true;
    const focusedPane = panes.find((pane) => pane.focused);
    // The gates are computed here, at the one place that holds both halves
    // of what a predicate needs: the chain, and the merged blocks. The
    // predicates then stay pure functions of their inputs, and the
    // recompute rides the flush that is already coalesced and diffed rather
    // than firing on every chain notification.
    const facts: CommandMenuFacts = {
      sessionCardFrontmost: activeCard?.component === "session",
      session:
        session === null
          ? null
          : {
              sessionBound: session.sessionBound,
              canInterrupt: session.canInterrupt,
              canChangeSettings: session.canChangeSettings,
              permissionMode: session.permissionMode,
              aiSummary: session.aiSummary,
              hasAssistantMessage: session.hasAssistantMessage,
              hasTurns: session.hasTurns,
              changesVisible: session.changesVisible,
              historyVisible: session.historyVisible,
              commitReady: session.commitReady,
              hasCustomName: session.hasCustomName,
            },
      fileGates: file === null ? null : computeFileMenuGates(file),
      openQuickly,
      paneCount: panes.length,
      focusedPaneCardCount: focusedPane?.cardCount ?? 0,
      visibleCardCount,
      focusedPaneActiveCardClosable: focusedPane?.closable ?? false,
      selectionActive,
      stackDepth,
      cardWidth,
      bullseye,
      reachableSlots,
      column: this.columnFactSource?.() ?? null,
    };
    this.lastFacts = facts;
    const commands = computeCommandCapabilities(this.validationSource(facts));
    this.lastGates = commands;
    const payload: MenuStatePayload = {
      panes,
      activeCard,
      selectionActive,
      stackDepth,
      session,
      file,
      document,
      edit: this.editCapabilities,
      commands,
      recentDocuments: this.recentDocuments,
      activeTheme: this.activeTheme,
      openQuickly,
      captureArmed: this.captureArmed,
    };
    const serialized = JSON.stringify(payload);
    if (serialized === this.lastSent) return;
    this.lastSent = serialized;
    this.post(payload);
  }
}

/**
 * Production sink: post to the Swift host. No-op outside a WKWebView
 * (browser dev mode), same guard the old per-notify push used.
 */
function postToHost(payload: MenuStatePayload): void {
  const webkit = (globalThis as unknown as Record<string, unknown>).webkit as
    | Record<string, unknown>
    | undefined;
  const messageHandlers = webkit?.messageHandlers as Record<string, unknown> | undefined;
  const handler = messageHandlers?.menuState as
    | { postMessage: (v: unknown) => void }
    | undefined;
  if (!handler) return;
  handler.postMessage(payload);
}

/** The boot-time singleton behind the module-level publish functions. */
let activePublisher: HostMenuStatePublisher | null = null;

/**
 * The validity source as of the last flush — the same value the menu gates
 * were computed from, so an in-page surface that asks it cannot disagree
 * with the native menu about the same command.
 *
 * Returns an all-negative source before the first flush, which is the truth
 * at that point: nothing is focused and no card is frontmost.
 */
export function commandValidationSource(): CommandValidationSource {
  return activePublisher?.currentValidationSource() ?? {
    ...NO_CHAIN,
    menu: EMPTY_MENU_FACTS,
  };
}

/**
 * Wire the aggregator to the deck store. Called once at boot
 * (`main.tsx`) right after the DeckManager is constructed; publishes
 * the initial state immediately so the host's menu validation never
 * runs against a stale cache.
 */
export function initHostMenuState(deck: IDeckManagerStore): void {
  const publisher = new HostMenuStatePublisher(postToHost);
  activePublisher = publisher;
  const push = (): void => {
    publisher.setDeckProjection(projectDeckState(deck.getSnapshot()));
  };
  deck.subscribe(push);
  // The column verbs act on the layout selection, so the fact that gates their
  // menu items is asked at flush time rather than projected from deck state
  // ([P05]). Its two non-deck inputs push a flush themselves: the selection
  // store, and the Cards list's cursor.
  publisher.setColumnFactSource(() => resolveColumnMenuFact(deck));
  cardsSelectionStore.subscribe(() => {
    publisher.refresh();
  });
  subscribeLayoutCursorCard(() => {
    publisher.refresh();
  });
  // Session bindings appear/disappear without a deck mutation, and Open
  // Quickly's gate reads them — re-project so the flush recomputes it.
  cardSessionBindingStore.subscribe(push);
  // Pane names are the title bar's own text, which folds in a card's live
  // title override; that override is not deck state either, so a Session card
  // binding to a project would otherwise keep its stale Window-menu entry
  // until some unrelated deck mutation came along. The publisher already
  // diffs the serialized payload, so a push that changes nothing costs
  // nothing.
  cardTitleStore.subscribe(push);
  // Every chord the host applies is projected from the keymap registry, so a
  // rebind has to republish or the menu bar keeps the chord the user just
  // moved away.
  keymapRegistry.subscribe(() => {
    publisher.refresh();
  });
  // Arming a chord capture rides the same push: the host parks every key
  // equivalent while the pane records, so a bound chord falls through to be
  // captured instead of firing ([P15] — AppKit resolves ahead of the web
  // view, and detaching is the only way through its scan).
  chordCaptureState.subscribe(() => {
    publisher.setCaptureArmed(chordCaptureState.isArmed());
  });
  // The native layer of `resolveChord`, joined from the registry's menu
  // claims and this publisher's own last-computed gates ([P15]). An item
  // whose enablement is not mirrored reads as enabled — the claim exists
  // because the item carries the chord, and "probably fires" is the honest
  // default for an item this mirror does not gate. Maker-menu items claim
  // only while the menu is visible; its hidden chords fall through.
  keymapRegistry.setEnvironment({
    nativeChords: () =>
      keymapRegistry.menuClaims().map((claim) => ({
        ...claim,
        enabled: publisher.lastGateFor(claim.menuItemId)?.enabled ?? true,
        claims: claim.menuItemId.startsWith("maker.")
          ? lastKnownMakerMode() === true
          : true,
      })),
  });
  // Settle the maker-mode fact the claims above read. Fire-and-forget: the
  // reply lands through the bridge's cache, and maker mode cannot change
  // without a page reload, so one round trip answers for the page's life.
  void getSettings();
  push();
}

/**
 * Publish (or refresh) a session card's session block. Called by the dev
 * card's menu-state effect on every relevant store change; a no-op
 * before {@link initHostMenuState} runs (browser-dev edge — the boot
 * sequence wires the publisher before any card mounts in-app).
 */
export function publishSessionMenuState(cardId: string, block: MenuStateSessionBlock): void {
  activePublisher?.setSessionBlock(cardId, block);
}

/** Drop a session card's session block (card unmount / services teardown). */
export function clearSessionMenuState(cardId: string): void {
  activePublisher?.clearSessionBlock(cardId);
}

/**
 * Publish (or refresh) a Text card's menu block. Called by the
 * Text card's menu-state effect on every relevant snapshot change; a
 * no-op before {@link initHostMenuState} runs.
 */
export function publishFileMenuState(cardId: string, block: MenuStateFileBlock): void {
  activePublisher?.setFileBlock(cardId, block);
}

/**
 * Publish a document surface's claim on the host's zoom commands. Called by
 * the surface that owns zoom; a no-op before {@link initHostMenuState} runs.
 */
export function publishDocumentMenuState(
  cardId: string,
  block: MenuStateDocumentBlock,
): void {
  activePublisher?.setDocumentBlock(cardId, block);
}

/** Drop a document surface's zoom claim (surface unmount). */
export function clearDocumentMenuState(cardId: string): void {
  activePublisher?.clearDocumentBlock(cardId);
}

/** Drop a Text card's menu block (card unmount). */
export function clearFileMenuState(cardId: string): void {
  activePublisher?.clearFileBlock(cardId);
}

/**
 * Publish the current first responder's edit-menu capabilities. Called
 * by the responder-chain provider on every validation change (focus /
 * register / unregister); a no-op before {@link initHostMenuState} runs.
 */
export function publishEditMenuState(caps: MenuStateEditBlock): void {
  activePublisher?.setEditCapabilities(caps);
}

/**
 * Register (or clear, with null) the chain the command predicates ask.
 * Called by the responder-chain provider at mount; a no-op before
 * {@link initHostMenuState} runs.
 */
export function registerMenuValidationChain(chain: MenuValidationChain | null): void {
  activePublisher?.setValidationChain(chain);
}

/**
 * Recompute-and-publish hook for menu-capability changes that the chain's
 * validation version cannot see. Focus / register / unregister all bump
 * the version, but a capability can flip *within* a focused responder —
 * the canonical case is an editor's undo/redo depth changing as the user
 * types. The responder-chain provider registers its publish closure here;
 * substrates call {@link requestMenuStateRefresh} when such a flip
 * happens. Deliberately NOT a validationVersion bump: that would re-render
 * every chain-subscribed component on each keystroke. The publisher's
 * serialized diff suppresses no-op posts, so over-calling is cheap.
 *
 * The closure republishes the edit block and the command gates together —
 * one walk of the chain answers both, and a caller that could refresh one
 * without the other would be able to make them disagree.
 */
let menuCapsRefresher: (() => void) | null = null;

/** Register (or clear, with null) the provider's recompute-and-publish closure. */
export function registerMenuCapsRefresher(refresh: (() => void) | null): void {
  menuCapsRefresher = refresh;
}

/** Ask the provider to recompute and republish the menu capabilities. */
export function requestMenuStateRefresh(): void {
  menuCapsRefresher?.();
}

/**
 * Publish the recent-document list to the host (File ▸ Open Recent). A
 * no-op before {@link initHostMenuState} runs; the recents module calls
 * it at boot and on every list change.
 */
export function publishRecentDocuments(paths: string[]): void {
  activePublisher?.setRecentDocuments(paths);
}

/**
 * Publish the active theme (View ▸ Theme's checkmark). Called by the theme
 * provider on mount and on every change; a no-op before
 * {@link initHostMenuState} runs.
 *
 * The host used to read this from tugbank on every menu open — a subprocess
 * read inside `menuNeedsUpdate`, on the path that has to finish before the
 * menu can draw. It read tugbank because the frontend changes the theme by
 * paths the host never sees (Next Theme, the Settings pane), and a value
 * cached at selection time would go stale. Pushing it closes that gap
 * without the read: the frontend tells the host every time it changes.
 */
export function publishActiveTheme(theme: string): void {
  activePublisher?.setActiveTheme(theme);
}
