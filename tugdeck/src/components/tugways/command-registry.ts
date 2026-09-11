/**
 * command-registry.ts — the canonical table of user-invocable commands.
 *
 * One entry per command the user can invoke: its wire name, its display
 * title, how it dispatches, which native menu item it drives, and which
 * chords are bound to it by default. Every emitter — the Swift menu's
 * control frames, the key pipeline, buttons, the slash bridges — resolves
 * through this table and calls `dispatchCommand` ([P01], Spec S01).
 *
 * The table is pure data. It imports the action vocabulary and the content
 * width presets — both leaves that import nothing of Tug's — so the
 * dispatcher, the keymap registry, the menu-state mirror, and the Settings
 * panes can all read it without an import cycle.
 *
 * ## What is NOT in here
 *
 * - **tugcast data frames** (`spawn_session_ok`, `session_updated`, and
 *   the ~20 siblings). They are protocol, not commands: no title, no
 *   validity, no chord. They keep the raw `registerAction` handler path
 *   ([P03]).
 * - **Form-control currency** (`set-value`, `toggle`, `select-value`,
 *   `set-color`, `activate-color-well`, `set-property`). These travel
 *   between a control and its responder; they are not user intents.
 * - **Substrate text-editing bindings** (⌃U / ⌃W / ⌥F / ⌥B, the CM6
 *   keymaps). Movement and deletion only ever target the focused text
 *   input, so they stay substrate-local.
 */

import type { TugAction } from "./action-vocabulary";
import { TUG_ACTIONS } from "./action-vocabulary";
import type { ContentWidth, SidebarSide } from "@/lib/layout-imposer";
import {
  CONTENT_WIDTH_LABELS,
  CONTENT_WIDTH_PRESETS,
  DEFAULT_SIDEBAR_SIDE,
  IMPOSITION_KINDS,
  slotCount,
} from "@/lib/layout-imposer";
import { ARCS_CARD_ID } from "@/lib/arcs-card-id";
import { CARDS_CARD_ID } from "@/lib/cards-card-id";
import { JOTS_CARD_ID } from "@/lib/jots-card-id";
import { LAYOUT_CARD_ID } from "@/lib/layout-card-id";
import { OVERVIEW_CARD_ID } from "@/lib/overview-card-id";
import { TRIPWIRES_CARD_ID } from "@/lib/tripwires-card-id";

/* ---------------------------------------------------------------------------
 * Chords and bindings (Spec S02)
 * ------------------------------------------------------------------------- */

/**
 * A chord's identity is `KeyboardEvent.code` plus the exact state of the
 * four modifier flags — the rule the key pipeline already matches on.
 * `label` is display data only and never participates in matching, so it
 * can be corrected for a keyboard layout without changing what the chord
 * matches ([P09]).
 */
export interface Chord {
  /** KeyboardEvent.code — layout-independent. */
  readonly key: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
  /** The observed `event.key` at capture; US-authored for built-in defaults. */
  readonly label?: string;
}

/**
 * Where a binding is live — orthogonal to the command's `routing`, which
 * says how it dispatches ([P08]).
 *
 * - `global` — live wherever the app has focus.
 * - `responder` — live while the named responder is in the chain.
 * - `mode` — live while the named focus mode is pushed.
 */
export type BindingScope =
  | { readonly kind: "global" }
  | { readonly kind: "responder"; readonly responderId: string }
  | { readonly kind: "mode"; readonly modeId: string };

/** The global scope, which most bindings carry. */
export const GLOBAL_SCOPE: BindingScope = { kind: "global" };

export interface CommandBinding {
  readonly chord: Chord;
  readonly scope: BindingScope;
  readonly source: "default" | "user";
  /** Suppress the browser default when this chord matches. */
  readonly preventDefault?: boolean;
  /**
   * Eligible to carry the native menu key equivalent. An `NSMenuItem`
   * carries exactly one, so the Swift sweep applies the first eligible
   * binding and the rest live in the JS funnel only.
   */
  readonly menuEligible?: boolean;
}

/* ---------------------------------------------------------------------------
 * Entry shape (Spec S01)
 * ------------------------------------------------------------------------- */

/** How a command reaches its implementation ([P04]). */
export type CommandRouting =
  /** `sendToFirstResponderForContinuation`, continuation invoked immediately. */
  | "first-responder"
  /** `sendToKeyCard` — starts at the active card's card-content responder. */
  | "key-card"
  /** `sendToTarget(targetId, …)` — the target rides the dispatch payload. */
  | "target"
  /** The handler registered through `registerAction`. */
  | "registry"
  /** Represented for display and policy only; AppKit performs it. */
  | "native";

/**
 * The menu-relevant facts that live outside the responder chain: which card
 * is frontmost and what it is currently able to do, how the deck is shaped,
 * whether Open Quickly has a root.
 *
 * Structurally declared here rather than imported so the table keeps its one
 * dependency. Every field is already a fact the frontend had to publish for
 * the host to validate a menu at all — this is the same data, read by the
 * predicate that owns the item instead of by a hand-rolled case.
 */
export interface CommandMenuFacts {
  /** The focused pane's active card is a session card. */
  readonly sessionCardFrontmost: boolean;
  /** The frontmost session card's live state; null when none is frontmost. */
  readonly session: {
    readonly sessionBound: boolean;
    readonly canInterrupt: boolean;
    readonly canChangeSettings: boolean;
    readonly permissionMode: string;
    /**
     * The composite `model · effort · mode` line the AI chip shows, so the
     * Session menu's AI item can say what the AI is set to rather than only
     * that a setting exists. Empty before the card has published one, which
     * leaves the Swift item's static title standing.
     */
    readonly aiSummary: string;
    readonly hasAssistantMessage: boolean;
    readonly hasTurns: boolean;
    readonly changesVisible: boolean;
    readonly historyVisible: boolean;
    readonly commitReady: boolean;
    /**
     * The frontmost session card's pane wears the minimized form. Drives the
     * Minimize Session item's dynamic verb. An inline mirror of
     * `MenuStateSessionBlock`'s own field rather than an import of it, which
     * is how this block already stands — so the field is declared in three
     * places, and missing any of them is a type error rather than a silent
     * disagreement.
     */
    readonly minimized: boolean;
    /** The bound session carries a user-set name — there is one to clear. */
    readonly hasCustomName: boolean;
  } | null;
  /**
   * The frontmost Text card's File-menu gates, already reduced from its
   * block by the one function that owns that matrix; null when no Text card
   * is frontmost.
   */
  readonly fileGates: {
    readonly save: boolean;
    readonly saveAs: boolean;
    readonly saveACopy: boolean;
    readonly revert: boolean;
    readonly reload: boolean;
  } | null;
  /** Open Quickly has a search root. */
  readonly openQuickly: boolean;
  readonly paneCount: number;
  /** Cards in the focused pane; 0 when nothing is focused. */
  readonly focusedPaneCardCount: number;
  /**
   * Cards in the deck's lateral ring: every tab of every visible pane —
   * the front of each slot / rail stack plus the free panes, the sidebars
   * included. Gates Previous/Next Card, which walk exactly that ring.
   */
  readonly visibleCardCount: number;
  /** The focused pane's active card can be closed. */
  readonly focusedPaneActiveCardClosable: boolean;
  /** A card is selected — false on a deck deselected by a canvas click. */
  readonly selectionActive: boolean;
  /** How many panes share the focused pane's slot. */
  readonly stackDepth: number;
  /**
   * The focused pane's named width, and whether it has one to set at all.
   * `null` when the width commands do not apply — nothing selected, or the
   * focused pane holds a rail (a sidebar takes its width from the allocator,
   * never from a preset). Otherwise `preset` is the stamp `setPaneWidth`
   * left, and `null` there means the pane sits at a width the user dragged
   * by hand: settable, but at none of the three, so no row is checked.
   */
  readonly cardWidth: { readonly preset: ContentWidth | null } | null;
  /**
   * Whether the focused pane stands in bullseye. `null` when the command
   * does not apply — nothing selected, or the focused pane holds a rail —
   * which is the same pair of gates `cardWidth` uses, because both answer
   * "is there a content pane the selection is in".
   */
  readonly bullseye: { readonly on: boolean } | null;
  /**
   * How many slots the deck can center on — the kind's slot count under flow,
   * and 0 otherwise. Gates the Go to Slot row.
   *
   * It takes NONE of the selection gates above, and that is the point: the
   * other three answer "what could happen to the card I am in", while this one
   * moves the band the whole deck is seen through. A deselected deck can still
   * be sent to slot 4.
   */
  readonly reachableSlots: number;
  /**
   * What the column verbs could do to the card the layout selection resolves
   * to. `null` when none does — nothing selected, no cursor in the Cards list,
   * no content card fronted, or a deck with no imposition to hold a column.
   *
   * Unlike {@link cardWidth} and {@link bullseye}, this reads the layout
   * selection's full ladder rather than the focused pane, because that is what
   * the chords act on: a selection in the Cards card, else the row its list's
   * cursor stands on, else the first responder. A fact narrower than the verb
   * would dim an item whose chord still fires — and a dimmed item's key
   * equivalent is swallowed by AppKit before the web view ever sees it, so the
   * chord would stop firing to match ([P05]).
   */
  readonly column: {
    readonly canSplit: boolean;
    readonly canMoveUp: boolean;
    readonly canMoveDown: boolean;
  } | null;
  /**
   * Whether a directional focus move would act, per direction. `null` when none
   * would — no card holds the keyboard, or the card that does stands in no place
   * (a free pane), which is the same pair of gates the reckoning itself refuses
   * on.
   *
   * It reads the FIRST RESPONDER rather than the layout selection, unlike
   * {@link column}, because that is what the verb acts on: the gesture moves the
   * keyboard, so where the keyboard is IS the source. Same promotion argument
   * either way — AppKit resolves a key equivalent before the web view sees the
   * keydown, so an item this fact dims is a chord that stops firing, and a fact
   * narrower than the verb would take the chord down with the item ([P05]).
   */
  readonly focusTravel: {
    readonly left: boolean;
    readonly right: boolean;
    readonly above: boolean;
    readonly below: boolean;
  } | null;
  /**
   * Every registered sidebar card, keyed by component id — the registry's
   * set rather than whatever is open, so a hidden card still has an entry
   * and its row still has something to say. A component id absent from the
   * map is not a sidebar card, and its row's predicates read it as hidden.
   */
  readonly sidebars: Readonly<Record<string, SidebarMenuFact>>;
}

/**
 * One sidebar card's standing, as the Window menu's rows need to read it.
 *
 * The three fields are the three rungs of the ladder `sidebar-toggle.ts`
 * runs, taken apart: `showing` is presence (which IS the open state, [P02]),
 * `focused` narrows that to "and it holds the keyboard", and `side` is where
 * it stands. The toggle row's mark reads the first two together — hidden,
 * showing, showing-and-focused — and the Left / Right pair reads all three.
 *
 * `side` is answered for a hidden card too, because `sidebarSide` is total:
 * it is where the card WOULD stand, which is what the radios would check if
 * they were live.
 */
export interface SidebarMenuFact {
  readonly showing: boolean;
  readonly side: SidebarSide;
  readonly focused: boolean;
}

/** Nothing focused, nothing open — the answer before the first push. */
export const EMPTY_MENU_FACTS: CommandMenuFacts = {
  sessionCardFrontmost: false,
  session: null,
  fileGates: null,
  openQuickly: false,
  paneCount: 0,
  focusedPaneCardCount: 0,
  visibleCardCount: 0,
  focusedPaneActiveCardClosable: false,
  selectionActive: false,
  stackDepth: 0,
  cardWidth: null,
  bullseye: null,
  reachableSlots: 0,
  column: null,
  focusTravel: null,
  sidebars: {},
};

/**
 * What a validity or state predicate is allowed to ask: the chain's answers
 * and the published menu facts. Deliberately a narrow interface rather than
 * the whole chain manager — a predicate reads, it does not dispatch — and a
 * plain value rather than a store read, so every predicate is a pure
 * function of its inputs and unit-testable without mounting anything.
 */
export interface CommandValidationSource {
  validateAction(action: string): boolean;
  validateActionInKeyCard(action: string): boolean;
  queryActionState(action: string): boolean | string | undefined;
  queryActionStateInKeyCard(action: string): boolean | string | undefined;
  readonly menu: CommandMenuFacts;
}

export interface CommandEntry {
  /**
   * Canonical wire name: a `TUG_ACTIONS` value, a control-frame wire, or
   * a parameterized id of the form `<action>:<value>` ([P05]).
   */
  readonly id: string;
  /** Display name — menus, keymap UI, palette. The single source for labels. */
  readonly title: string;
  readonly routing: CommandRouting;
  /**
   * The chain action to dispatch. Defaults to `id` when `id` is itself a
   * `TUG_ACTIONS` value; required when it is not.
   */
  readonly action?: TugAction;
  /** Static `ActionEvent.value` carried by every dispatch of this command. */
  readonly payload?: unknown;
  /** The `NSMenuItem` identifier this command drives ([P02]). */
  readonly menuItemId?: string;
  /**
   * Publish this item's gate — enablement, check state, dynamic title — in
   * the menuState `commands` block, where the host's validator reads it
   * ahead of every hand-rolled case ([P13]).
   *
   * This is the migration switch, and it is per item on purpose. The host
   * still hand-rolls a validation tier for the items that have not moved
   * yet; an item is mirrored in the same change that deletes its tier, so
   * exactly one definition of its enablement is live at any moment. An
   * entry with no answer of its own must not be mirrored: a published
   * default-true gate would silently light an item its tier was gating.
   */
  readonly mirrored?: boolean;
  /** Default bindings — a list from day one ([P08]). */
  readonly bindings?: readonly CommandBinding[];
  /**
   * What becomes of this command's key equivalent while the command
   * validates disabled.
   *
   * A chord on a disabled menu item is eaten at the menu bar with a beep; it
   * does not fall through to the web view. So dimming an item is not the
   * whole decision — the chord has to be decided too, and the two answers
   * are genuinely different commands:
   *
   * - `"keep"` — the command owns the chord outright. Nothing else may have
   *   it, and the beep is honest feedback that the user pressed the right
   *   keys at the wrong moment. This is the default, and it is what every
   *   item built with a construction-time key equivalent already does.
   * - `"detach"` — the command claims the chord only while it is
   *   applicable. The gate publishes a `null` chord in the disabled state,
   *   which releases the key equivalent and lets the chord reach the JS
   *   funnel, where a scoped binding may still want it.
   *
   * `"detach"` is the answer for a command promoted from a scoped JS
   * binding to a menu item: the chord was shadowable before the promotion,
   * and detaching is what keeps it shadowable after.
   */
  readonly disabledChord?: "keep" | "detach";
  /**
   * Whether the command holds its menu key equivalent right now, asked
   * independently of whether the item is enabled.
   *
   * Most commands never need this: a chord follows the item, and
   * {@link disabledChord} says what happens when the item dims. Two do not.
   * Save As… is enabled whenever a Text card is frontmost and its chord must
   * come off when one is not, which is the *same* condition read twice only
   * because the item's own enablement is computed from a block that may be
   * absent. And the two slot-stack commands are equally enabled while the
   * stack has somewhere to go, with only ⌘R moving between them on a user
   * preference — an enablement predicate cannot express that, because
   * neither item is ever the disabled one.
   *
   * Absent means "attached whenever the item is enabled", which is what
   * every other command wants.
   */
  readonly chordActive?: (chain: CommandValidationSource) => boolean;
  /** Validity override; chain-routed entries default to the chain walk ([P06]). */
  readonly validate?: (chain: CommandValidationSource) => boolean;
  /** Checkmark / radio / toggle projection ([P07]). */
  readonly state?: (
    chain: CommandValidationSource,
  ) => boolean | string | undefined;
  /** Dynamic menu title (Show/Hide Changes, Undo <noun>). */
  readonly dynamicTitle?: (
    chain: CommandValidationSource,
  ) => string | undefined;
  /**
   * Payload set discovered at runtime — excluded from the menu-state
   * mirror, from the keymap UI's rebindable rows, and from the
   * door-coverage lint ([P05]).
   */
  readonly parameterized?: boolean;
  /**
   * No door by design: the entry exists so the command is named and
   * visible, but it has neither a `menuItemId` nor `bindings`. Every
   * `internal` entry carries a comment naming what blocks the door.
   */
  readonly internal?: boolean;
  /**
   * Its door is a control the active card contributes to its own chrome — a
   * `PaneTitleBarItem` (a standing button or a `…` row), or a segment in the
   * composer's route group — which the door-coverage lint cannot see because
   * that lint counts native menu items and key equivalents, the two doors the
   * host resolves.
   *
   * Distinct from `internal`, and the distinction is the point: `internal`
   * says *nothing* opens this yet, while `paneChrome` says a real door does and
   * names which. Collapsing the two would make `internal` mean two opposite
   * things, and the keymap pane would hide a command a user can already
   * invoke. A `paneChrome` entry is listed and rebindable there; a chord is
   * simply a second door it has not been granted yet.
   */
  readonly paneChrome?: boolean;
}

/* ---------------------------------------------------------------------------
 * The table
 * ------------------------------------------------------------------------- */

/** A default global binding, the shape most of the table's chords take. */
function chord(
  spec: Chord,
  options: { preventDefault?: boolean; menuEligible?: boolean } = {},
): CommandBinding {
  return {
    chord: spec,
    scope: GLOBAL_SCOPE,
    source: "default",
    ...(options.preventDefault === true ? { preventDefault: true } : {}),
    ...(options.menuEligible === true ? { menuEligible: true } : {}),
  };
}

/**
 * The activation scope named by the composer's own bindings.
 *
 * A scoped binding is live where its component registers it, and a card's
 * responder id is minted per card — so a table can only name the *surface*,
 * not the runtime id. `resolveChord` reads the live registration for
 * resolution and this name for display, which is what lets a scoped chord be
 * shown in the keymap pane without the table pretending to know where it is.
 */
export const COMPOSER_RESPONDER_SCOPE = "session-composer";

/* ---------------------------------------------------------------------------
 * Shared predicates
 *
 * The session card's command surfaces gate in two tiers — the frontmost card
 * must be a session card at all, and below that the specific command needs a
 * bound session, an interruptible turn, or a transcript with turns in it.
 * Naming the tiers keeps thirty-odd entries from each spelling the same
 * condition slightly differently.
 * ------------------------------------------------------------------------- */

/** A session card is frontmost — the card-type tier every Session item needs. */
function sessionCardFrontmost(chain: CommandValidationSource): boolean {
  return chain.menu.sessionCardFrontmost;
}

/** A session card is frontmost and bound to a session. */
function sessionBound(chain: CommandValidationSource): boolean {
  return (
    chain.menu.sessionCardFrontmost &&
    (chain.menu.session?.sessionBound ?? false)
  );
}

/**
 * The Mode / Model / Effort controls may be changed — the session is idle.
 * The whole Permission Mode submenu gates on this the same way the composer's
 * chips do, so a mode change can never race a running turn.
 */
function sessionSettingsChangeable(chain: CommandValidationSource): boolean {
  return (
    sessionBound(chain) && (chain.menu.session?.canChangeSettings ?? false)
  );
}

/**
 * A canvas-background click deselects the deck while leaving its panes
 * standing. The card and pane navigation commands stay live in that state so
 * the user can re-activate a card by keyboard or menu instead of having to
 * find one with the mouse.
 */
function deckDeselectedWithPanes(chain: CommandValidationSource): boolean {
  return !chain.menu.selectionActive && chain.menu.paneCount > 0;
}

/**
 * A session card is frontmost and its transcript has something to move
 * through. The transcript navigation commands are no-ops on an empty
 * transcript, and their menu items say so rather than offering a gesture
 * with nowhere to go.
 */
function transcriptNavigable(chain: CommandValidationSource): boolean {
  return (
    chain.menu.sessionCardFrontmost && (chain.menu.session?.hasTurns ?? false)
  );
}

/** Somewhere to navigate to: a lateral ring of at least two, or a deck to re-enter. */
function cardNavigationAvailable(chain: CommandValidationSource): boolean {
  return chain.menu.visibleCardCount > 1 || deckDeselectedWithPanes(chain);
}

/**
 * One entry per slash-command bridge. Each is an individually addressable
 * command — its own title, its own menu item, its own future validity —
 * dispatching the one `run-slash-command` action with a different name
 * ([P05]). The Swift items carry the same name in `representedObject`.
 */
type SlashBridge = readonly [
  name: string,
  title: string,
  menuItemId: string,
  /** Defaults to `sessionBound` — a bound session is what a slash command runs against. */
  validate?: (chain: CommandValidationSource) => boolean,
  /**
   * Live menu title, when the item is a state display rather than only a door
   * — `AI: Fable 5 · High · Auto…`. `undefined` leaves the Swift item's static
   * title standing, which is the right answer before the first push.
   *
   * The tuple carries it rather than the `ai` entry being hand-authored beside
   * the standalone commands: a standalone entry would have to restate
   * `routing`, `action`, `payload`, and `mirrored` by hand, and the next
   * bridge wanting a live title would face the same fork again.
   */
  dynamicTitle?: (chain: CommandValidationSource) => string | undefined,
];

/**
 * The slash bridges that carry a chord, by name.
 *
 * Most do not: a bridge is reachable by typing its name, which is the whole
 * point of the family, and a chord for each would spend the modifier bands on
 * a list that grows every time someone adds a slash command. The ones here
 * earned it by being reached often enough that typing the name is the slow
 * path.
 *
 * Menu-eligible, so AppKit's key-equivalent scan owns the chord and the
 * Session menu item renders it. The item's action round-trips to the same
 * `run-slash-command` dispatch the JS funnel would have made, so the two
 * doors do not differ in what they run — only in who catches the keystroke.
 */
const SLASH_BRIDGE_BINDINGS: Readonly<Record<string, readonly CommandBinding[]>> = {
  // ⌃⌘I for the AI mixer — I for the name it opens. It held Insert File until
  // this table took it; that command kept the letter and moved to ⇧⌘I. It sat
  // on the model picker until the three settings became one sheet.
  ai: [
    chord(
      { key: "KeyI", ctrl: true, meta: true, label: "i" },
      { preventDefault: true, menuEligible: true },
    ),
  ],
  // ⌃⌘U for the usage panel — U for Usage.
  usage: [
    chord(
      { key: "KeyU", ctrl: true, meta: true, label: "u" },
      { preventDefault: true, menuEligible: true },
    ),
  ],
};

const SLASH_BRIDGES: readonly SlashBridge[] = [
  // Export writes the transcript the card already holds, so it needs the
  // card and not a live session.
  ["export", "Export Session…", "file.exportTranscript", sessionCardFrontmost],
  [
    "copy",
    "Copy Last Response",
    "edit.copyLastResponse",
    (chain) =>
      chain.menu.sessionCardFrontmost &&
      (chain.menu.session?.hasAssistantMessage ?? false),
  ],
  ["clear", "Clear Session", "session.new"],
  ["resume", "Resume Session…", "session.resume"],
  ["rename", "Rename Session…", "session.rename"],
  // No ellipsis: it performs rather than opening a dialog. Gated on there
  // being a name to clear, so the item never sits enabled over nothing.
  [
    "unname",
    "Unname Session",
    "session.unname",
    (chain) => chain.menu.session?.hasCustomName ?? false,
  ],
  // The menu door means LAND, not enter. `/commit` and ⌃⌘C-on-an-empty-composer
  // are the two doors that put you into commit mode; by the time this item is
  // enabled you are already in it with a message written, so it performs rather
  // than opening — hence no ellipsis. Every gate is folded into `commitReady`
  // by `CommitModeController`, which is the only thing that sees all four.
  [
    "commit",
    "Commit Changes",
    "session.commit",
    (chain) => chain.menu.session?.commitReady ?? false,
  ],
  // One door for model, reasoning effort, and permission mode — and a state
  // display, since the gate pushes the title: the menu says what the AI is set
  // to, not just that a setting exists. Gated honestly on
  // `sessionSettingsChangeable`: the AI Model… item this replaces enabled on a
  // bare bound session and bounced mid-turn after the fact.
  [
    "ai",
    "AI…",
    "session.ai",
    sessionSettingsChangeable,
    (chain) =>
      chain.menu.session?.aiSummary
        ? `AI: ${chain.menu.session.aiSummary}…`
        : undefined,
  ],
  // The tool-permission RULES editor — a different surface from the AI mixer,
  // and it keeps its own row. Removing it would delete the rules editor from
  // the Keyboard Shortcuts sheet and the keymap UI too, which enumerate this
  // same table, leaving `/permissions` and the mixer's footer as its only
  // doors. A fourth row is cheap; deleting a door is a touch.
  ["permissions", "Permission Rules…", "session.permissionRules"],
  // Rewind needs somewhere to rewind to.
  [
    "rewind",
    "Rewind…",
    "session.rewind",
    (chain) => sessionBound(chain) && (chain.menu.session?.hasTurns ?? false),
  ],
  ["compact", "Compact Conversation", "session.compact"],
  ["add-dir", "Add Working Directory…", "session.addDir"],
  ["diff", "Show Project Diff", "session.diff"],
  ["context", "Show Context", "session.context"],
  ["usage", "Show Usage", "session.usage"],
  ["skills", "Skills…", "session.skills"],
  ["agents", "Agents…", "session.agents"],
  ["hooks", "Hooks…", "session.hooks"],
  ["memory", "Memory…", "session.memory"],
  // The shortcuts sheet is card documentation, not session work.
  [
    "help",
    "Keyboard Shortcuts & Commands",
    "help.shortcuts",
    sessionCardFrontmost,
  ],
];

const SLASH_BRIDGE_COMMANDS: readonly CommandEntry[] = SLASH_BRIDGES.map(
  ([name, title, menuItemId, validate, dynamicTitle]) => ({
    id: `${TUG_ACTIONS.RUN_SLASH_COMMAND}:${name}`,
    title,
    routing: "key-card" as const,
    action: TUG_ACTIONS.RUN_SLASH_COMMAND,
    payload: { name, args: "" },
    menuItemId,
    ...(SLASH_BRIDGE_BINDINGS[name] !== undefined
      ? { bindings: SLASH_BRIDGE_BINDINGS[name] }
      : {}),
    ...(dynamicTitle !== undefined ? { dynamicTitle } : {}),
    mirrored: true,
    validate: validate ?? sessionBound,
  }),
);

/**
 * ⌘1…⌘9 are nine distinct user-facing commands, not one command with a
 * number ([P05]) — the keymap UI has to show nine rows, and each one is
 * separately rebindable. The chord is the door; the Window menu is not.
 *
 * Deliberately unpromoted ([Q02]). Nine Window-menu items would move nine
 * digit chords out of the JS funnel and into AppKit's key-equivalent scan
 * at once, where they are claimed unconditionally — inside every text
 * surface, and above any responder that wants its digits. `pdf-view.tsx`
 * already declines ⌘1–⌘3 by hand precisely so the deck keeps them; a menu
 * item would take that choice away from it and from every surface after
 * it. Detaching on a `validate` would need the frontend to know "the
 * focused surface wants its digits", which is not a fact anything
 * publishes today.
 *
 * So the nine stay chord-only registry entries: fully visible to the
 * keymap UI and the shadowing view, and still shadowable by the surfaces
 * that need to shadow them.
 */
const SLOT_COMMANDS: readonly CommandEntry[] = Array.from(
  { length: 9 },
  (_, i) => {
    const n = i + 1;
    return {
      id: `${TUG_ACTIONS.MOVE_TO_SLOT}:${n}`,
      title: `Move Card to Slot ${n}`,
      routing: "first-responder" as const,
      action: TUG_ACTIONS.MOVE_TO_SLOT,
      payload: n,
      bindings: [chord({ key: `Digit${n}`, meta: true, label: String(n) })],
    };
  },
);

/**
 * ⌥⇧⌘[ / ⌥⇧⌘] — move the layout selection one slot along the arrangement.
 *
 * **The tier, derived** (tuglaws/chord-tiers.md): ⇧⌘[/] moves attention
 * laterally across the cards and ⌥⌘[/] moves it through one slot's stack; ⌥ is
 * the variant operator, so ⌥⇧⌘[/] reads as the same lateral verb with the
 * object altered — it moves the card itself rather than the attention on it.
 * Same keys, same axis, altered object. Plain ⌘[/] is left alone: the pool
 * reserves it for back/forward.
 *
 * The ⌥⌘[/] neighbours are menu-promoted, so whether AppKit would claim the
 * ⌥⇧⌘ press too was checked rather than assumed. It does not — the
 * key-equivalent scan matches modifier masks exactly, so a promoted chord
 * shadows itself and not its composed neighbours.
 *
 * Two entries rather than one signed command, for the same reason the width
 * row is three: each direction is separately rebindable and each is one row in
 * the keymap pane.
 *
 * **Unpromoted**, like ⌘1..9 and for the neighbouring reason ([Q02]): the
 * nudge acts on the layout selection, which is a fact about the Cards card's list
 * and not about the frontmost card, so there is nothing for a menu item's
 * `validate` to read that would tell a live nudge from a dead one. A menu item
 * that is always enabled and sometimes inert is worse than no menu item, and
 * an unpromoted chord keeps the refusal where the user can see it — on the
 * blocking pane's border.
 */
const NUDGE_SLOT_COMMANDS: readonly CommandEntry[] = [
  { dir: "left", delta: -1, key: "BracketLeft", label: "[" },
  { dir: "right", delta: 1, key: "BracketRight", label: "]" },
].map(({ dir, delta, key, label }) => ({
  id: `${TUG_ACTIONS.NUDGE_SLOT}:${dir}`,
  title: dir === "left" ? "Nudge Card Left" : "Nudge Card Right",
  routing: "first-responder" as const,
  action: TUG_ACTIONS.NUDGE_SLOT,
  payload: delta,
  bindings: [
    chord(
      { key, meta: true, alt: true, shift: true, label },
      { preventDefault: true },
    ),
  ],
}));

/**
 * ⌃⌘S, and ⌃⌘↑/↓ with ⌃⇧⌘↑/↓ — the split family: divide the slot the selection
 * stands in, and move a card within it.
 *
 * **The tier, derived** (tuglaws/chord-tiers.md): ⌃⌘ is Tug's own layout
 * vocabulary — ⌃⌘←/→ Show Rail, ⌃⌘B Bullseye, ⌃⌘1/2/3 card width — and a slot
 * dividing is a layout act, so it belongs there rather than on plain ⌘, which
 * R3 reserves for verbs hit many times an hour. Letter S is unoccupied in the
 * tier (only ⌘S and ⇧⌘S exist on KeyS) and is the obvious mnemonic.
 *
 * The arrows are R1-exempt (rule R2), and ⌃⌘ arrows are unbound in Tug and
 * absent from the macOS never-bind list, which reserves plain ⌃-arrows for
 * Spaces and not the ⌘ composition. ⌃⇧⌘↑/↓ is the counterpart set of a ⌃⌘
 * base: top and bottom are the ⇧-extreme of up and down, exactly the ⌃⇧⌘[/]
 * First/Last Turn pattern one key class over ([D184] moved that family to the
 * brackets; the shape it lends this one is unchanged).
 *
 * Four move entries rather than one signed command, for the same reason the
 * width row is three: each is separately rebindable and each is one row in the
 * keymap pane.
 *
 * **Promoted to the Window menu**, unlike ⌘1..9 and the nudge pair. The
 * objection that kept them off it was that a menu item's `validate` had
 * nothing to read: these act on the layout selection, which is a fact about
 * the Cards card's list rather than about the frontmost card. That was answerable,
 * and the answer costs a fact — `menu.column`, resolved through the same
 * ladder the handlers walk, so an item is live exactly when its chord would
 * act. The menu is where a chord is discovered, and a chord nobody can find is
 * a chord nobody uses.
 *
 * `disabledChord: "keep"`, matching the width family: a dimmed item holds its
 * key equivalent, so the beep is honest feedback that the user pressed the
 * right keys at a moment the column had no move to make. Nothing else in the
 * JS funnel wants ⌃⌘S or the ⌃⌘ arrows, so there is nothing for a detach to
 * hand them back to.
 *
 * The refusal stays where the user can see it — on the pane's own border —
 * for the gestures that still reach the handler.
 */
const COLUMN_SPLIT_COMMANDS: readonly CommandEntry[] = [
  {
    id: TUG_ACTIONS.TOGGLE_COLUMN_SPLIT,
    title: "Split or Stack Column",
    routing: "first-responder" as const,
    menuItemId: "window.columnSplit",
    mirrored: true,
    disabledChord: "keep",
    bindings: [
      chord(
        { key: "KeyS", meta: true, ctrl: true, label: "s" },
        { preventDefault: true, menuEligible: true },
      ),
    ],
    validate: (chain: CommandValidationSource) =>
      chain.menu.column?.canSplit === true,
  },
  ...(
    [
      {
        where: "up",
        title: "Move Card Up in Column",
        menuItemId: "window.columnMoveUp",
        key: "ArrowUp",
        shift: false,
      },
      {
        where: "down",
        title: "Move Card Down in Column",
        menuItemId: "window.columnMoveDown",
        key: "ArrowDown",
        shift: false,
      },
      {
        where: "top",
        title: "Move Card to Top of Column",
        menuItemId: "window.columnMoveTop",
        key: "ArrowUp",
        shift: true,
      },
      {
        where: "bottom",
        title: "Move Card to Bottom of Column",
        menuItemId: "window.columnMoveBottom",
        key: "ArrowDown",
        shift: true,
      },
    ] as const
  ).map(({ where, title, menuItemId, key, shift }) => ({
    id: `${TUG_ACTIONS.MOVE_IN_COLUMN}:${where}`,
    title,
    routing: "first-responder" as const,
    action: TUG_ACTIONS.MOVE_IN_COLUMN,
    payload: where,
    menuItemId,
    mirrored: true,
    disabledChord: "keep" as const,
    bindings: [
      chord({ key, meta: true, ctrl: true, shift, label: key }, {
        preventDefault: true,
        menuEligible: true,
      }),
    ],
    // Top and bottom read the same two fields as up and down: a member that
    // cannot step up is already at the top, and travelling to a place you
    // already stand is the refusal `moveInColumn` returns false for.
    validate: (chain: CommandValidationSource) =>
      where === "up" || where === "top"
        ? chain.menu.column?.canMoveUp === true
        : chain.menu.column?.canMoveDown === true,
  })),
];

/**
 * ⌃⌘1/2/3 — the focused card's width, as one of the three named presets.
 *
 * Three entries and not one cycling command, because the set is static and
 * the gesture is meant to be no-look: a cycle you must know your place in
 * is a cycle you have to look at. Each is separately rebindable and each is
 * one row in the keymap pane ([P05]).
 *
 * **Menu rows with no chord of their own.** The row held ⌃⌘1/2/3 and gave
 * them up: the Tug tier's digits now center a slot, which is a verb of the
 * reading hour, and setting a width is not — a card is given its size once
 * and read at it for the rest of the session. A chord is not a label for a
 * command's importance, it is a claim on a scarce row of keys, and the
 * scarce row goes to what the hand reaches for. The three rows keep their
 * Window-menu places and the title bar's width popup, which are the doors a
 * once-a-session verb wants; a user who disagrees can bind them in the
 * keymap pane, because `bindings: []` is a command with no DEFAULT chord and
 * not a command that refuses one.
 *
 * The Swift items are still constructed with EMPTY key equivalents, so
 * `applyCommandChords` writes whatever this table says — which is now
 * nothing, and the rows draw bare.
 */
const CARD_WIDTH_COMMANDS: readonly CommandEntry[] = CONTENT_WIDTH_PRESETS.map(
  (preset) => ({
    id: `${TUG_ACTIONS.SET_PANE_WIDTH}:${preset}`,
    title: CONTENT_WIDTH_LABELS[preset],
    routing: "first-responder" as const,
    action: TUG_ACTIONS.SET_PANE_WIDTH,
    payload: preset,
    menuItemId: `window.cardWidth.${preset}`,
    mirrored: true,
    bindings: [],
    // Both predicates read the published fact rather than walking the
    // chain: which pane is focused and what width it holds is deck state,
    // and the canvas answering "yes I handle set-pane-width" says nothing
    // about whether THIS pane has a width to set.
    validate: (chain: CommandValidationSource) => chain.menu.cardWidth !== null,
    // The radio's mark, and the one width that shows none: a pane the user
    // dragged to a size of its own has no preset stamped, so no row is
    // checked — the settled control shows what the geometry holds.
    state: (chain: CommandValidationSource) =>
      chain.menu.cardWidth?.preset === preset,
  }),
);

/**
 * The most slots any arrangement defines — six-up's six, read off the kinds
 * rather than written down, so a seventh kind would bring its own row.
 */
const MAX_SLOTS = Math.max(...IMPOSITION_KINDS.map(slotCount));

/**
 * ⌃⌘1…⌃⌘6 — take the reader to slot N.
 *
 * **Named for the destination, not the geometry.** The arithmetic centers and
 * then clamps, so the first and last slots come to rest flush against their end
 * of the strip rather than in the middle of the band — which is the right
 * answer (the strip is already showing everything it has that way) and makes
 * "Center Slot 1" a row that cannot do what it says. A reader who typed it and
 * watched slot 1 land at the left edge would conclude the command was broken.
 * "Go to" promises only arrival, which is the whole of what the verb owes.
 *
 * **The tier, derived** (tuglaws/chord-tiers.md): the digit row indexes an
 * ordered set and the tier says WHICH reading of it. ⌘n moves the card to a
 * place; ⌃⌘n moves the reader to a place. Same set, same digits, and the
 * modifier is the whole difference — which is the tier doc's amended reading
 * of the digit row working exactly as intended, and a better fit for ⌃⌘ than
 * the widths that held it, since a width is not an index into the deck at all.
 *
 * Six rather than nine, unlike the slot family: ⌘1..9 is bound in full so an
 * out-of-range digit is inert rather than beeping, but these are MENU rows, and
 * a row for a slot no arrangement can have is a permanently dark row.
 *
 * **Promoted to the Window menu**, for the reason the width row was and the
 * slot row was not ([Q02]): ⌘1–⌘9 stay chord-only because surfaces like
 * `pdf-view.tsx` decline them by hand to leave the digits with the deck, and a
 * menu item takes that choice away — AppKit's key-equivalent scan runs first
 * and claims them unconditionally. Nothing claims ⌃⌘ digits: no viewer, no text
 * surface, no CM6 keymap.
 *
 * The gate is the arrangement's, not the selection's. Travel moves the band
 * and touches no card, so it is live on a deselected deck — and dark under fit,
 * where every anchor is inside the band already and there is nothing to travel.
 */
const GO_TO_SLOT_COMMANDS: readonly CommandEntry[] = Array.from(
  { length: MAX_SLOTS },
  (_, i) => {
    const n = i + 1;
    return {
      id: `${TUG_ACTIONS.GO_TO_SLOT}:${n}`,
      title: `Go to Slot ${n}`,
      routing: "first-responder" as const,
      action: TUG_ACTIONS.GO_TO_SLOT,
      payload: n,
      menuItemId: `window.goToSlot.${n}`,
      mirrored: true,
      bindings: [
        chord(
          { key: `Digit${n}`, meta: true, ctrl: true, label: String(n) },
          { menuEligible: true },
        ),
      ],
      validate: (chain: CommandValidationSource) =>
        chain.menu.reachableSlots >= n,
    };
  },
);

/**
 * ⌥⌘←/→/↑/↓ — hand the keyboard to the card that is spatially in that
 * direction.
 *
 * **The band, derived** (tuglaws/chord-tiers.md, "Arrows are geometry, brackets
 * are series"): ⌃⌘ arrows move the FURNITURE — a rail on that side, a card up
 * its column — and ⌥⌘ arrows move the READER through that same geometry. On the
 * horizontal pair the two read as a pair: ⌃⌘← opens the left side, ⌥⌘← walks
 * into it. Arrows are R1-exempt under R2, and the mnemonic is the geometry
 * itself — the chord points where you are going, which is the rail pair's own
 * argument one tier up.
 *
 * **All four or none** ([B01]). The family's only mnemonic IS the geometry, and
 * a mnemonic with a hole in it is a list again. ⌥⌘←/→ were free; ⌥⌘↑/↓ came from
 * the turn family, which moved to the bracket row where a series belongs
 * ([D184]). The ⇧-extremes are deliberately NOT granted: `move-in-column` keeps
 * all four of its chords, so Focus Topmost / Bottommost are not commands and
 * ⌥⇧⌘↑/↓ stays free rather than being spent in the change that vacated it.
 *
 * **Promoted to the Window menu with empty Swift key equivalents** ([B10]).
 * R6 makes the placement half the grant, and the preemption is the point rather
 * than a cost: ⌥⌘ arrows are not text currency in any Tug surface (plain ⌥
 * arrows are word motion; the ⌘ composition is not), and deck-level focus is not
 * a surface's to decline. `disabledChord: "keep"`, as the split family does —
 * nothing else in the funnel wants these chords, so a detach has nothing to hand
 * them back to and the two answers would be indistinguishable here.
 *
 * **What a dark row actually does to the press was measured rather than
 * assumed**, and it is what makes the refusal flash ([B09]) reachable at all:
 * AppKit declines to fire a disabled item and leaves the keydown alone, so it
 * arrives at the web view's own funnel, where THIS entry's binding is still
 * standing — the handler resolves the move, gets `null`, and flashes the pane
 * that is not going anywhere. So the arrangement's edge answers twice, the dark
 * row before the press and the border after it, and
 * `at0547-directional-card-focus.test.ts` holds both together on a real menu
 * bar. (The general note on {@link CommandEntry.disabledChord} tells it the
 * other way, as a chord eaten with a beep; that reading predates this
 * measurement and is not what the four rows here do.)
 *
 * The gate reads the FIRST RESPONDER, not the layout selection, because the verb
 * moves the keyboard rather than a card — and it answers per direction, so an
 * item is live exactly when its chord would act ([P05]).
 */
const FOCUS_CARD_COMMANDS: readonly CommandEntry[] = (
  [
    ["left", "ArrowLeft", "Left"],
    ["right", "ArrowRight", "Right"],
    ["above", "ArrowUp", "Above"],
    ["below", "ArrowDown", "Below"],
  ] as const
).map(([direction, key, word]) => ({
  id: `${TUG_ACTIONS.FOCUS_CARD}:${direction}`,
  title: `Focus Card ${word}`,
  routing: "first-responder" as const,
  action: TUG_ACTIONS.FOCUS_CARD,
  payload: direction,
  menuItemId: `window.focusCard${word}`,
  mirrored: true,
  bindings: [
    chord(
      { key, alt: true, meta: true, label: key },
      { preventDefault: true, menuEligible: true },
    ),
  ],
  validate: (chain: CommandValidationSource) =>
    chain.menu.focusTravel?.[direction] === true,
  disabledChord: "keep" as const,
}));

/**
 * ⌃⌘← / ⌃⌘→ — show or hide a whole SIDE of the deck.
 *
 * **The rail is the entity, not the card standing on it.** Every sidebar card
 * also carries its own ⌃⌘⟨letter⟩ toggle, and the two families are different
 * questions rather than rivals: this pair addresses a SIDE of the deck, which
 * is geometry, while a letter addresses a CARD. The pair is also the set that
 * does not grow at all — six sidebar cards need the same two keys three do.
 *
 * **The tier, derived** (tuglaws/chord-tiers.md): a rail is layout vocabulary,
 * which is what ⌃⌘ carries, alongside ⌃⌘↑/↓ `move-in-column` — whose vertical
 * axis these complete horizontally. Arrows are R1-exempt under R2 and the
 * mnemonic is the geometry itself: the chord points at the edge it opens. The
 * macOS never-bind list reserves PLAIN ⌃-arrows for Spaces and Mission Control,
 * not the ⌘ composition, which is the argument the split family already made
 * for ⌃⌘↑/↓.
 *
 * `menuEligible` with empty Swift key equivalents, the discipline every sidebar
 * toggle already follows: `applyCommandChords` writes them from this table, so
 * both stay rebindable end to end.
 *
 * Ungated. A rail always has something to say — hide it if it is showing, show
 * it if it is not — and the side's membership is the deck's business rather
 * than the row's.
 */
const RAIL_TOGGLE_COMMANDS: readonly CommandEntry[] = (
  [
    { side: "left", title: "Show Left Rail", key: "ArrowLeft", label: "←" },
    { side: "right", title: "Show Right Rail", key: "ArrowRight", label: "→" },
  ] as const
).map(({ side, title, key, label }) => ({
  id: `${TUG_ACTIONS.TOGGLE_RAIL}:${side}`,
  title,
  routing: "first-responder" as const,
  action: TUG_ACTIONS.TOGGLE_RAIL,
  payload: side,
  menuItemId: `maker.${side}Rail`,
  mirrored: true,
  bindings: [
    chord({ key, meta: true, ctrl: true, label }, {
      preventDefault: true,
      menuEligible: true,
    }),
  ],
}));

/**
 * The six sidebar cards, in the order the Window menu lists them: the
 * component id the deck knows them by, the noun the rows name them with, the
 * toggle command each row sends, and the chord that runs it.
 *
 * The component ids come from their own leaf modules rather than as literals,
 * because they are persistence keys — the Arcs card's is still `"dashes"`
 * ([D141]) — and a menu that spelled one by hand would be a second copy free
 * to drift from the one the deck reads.
 *
 * **Alphabetical by the NOUN, which is not the same as by the id.** The Arcs
 * card's id is `dashes`, so ordering by id would put Cards first and read as
 * alphabetical while being wrong. The menu shows nouns, so the nouns order it.
 *
 * **⌃⌘⟨letter⟩ names a sidebar card, one letter per card** ([D172]). The set is
 * closed at six — registration is a boot step — so the grammar is complete
 * rather than open-ended. Four letters are initials; two are not. Cards takes W
 * against its coming rename to Workspaces, because C is the Changes shade, and
 * Arcs takes R — a letter of its own noun — because A goes back to Claim All
 * ([D175]). Jots reads as a pair with ⌘J New Jot: plain-⌘ captures, ⌃⌘ shows
 * the card that holds them.
 */
const SIDEBAR_MENU_CARDS = [
  {
    componentId: ARCS_CARD_ID,
    noun: "Arcs",
    toggle: TUG_ACTIONS.TOGGLE_ARCS,
    key: "KeyR",
    label: "r",
  },
  {
    componentId: CARDS_CARD_ID,
    noun: "Cards",
    toggle: TUG_ACTIONS.TOGGLE_CARDS,
    key: "KeyW",
    label: "w",
  },
  {
    componentId: JOTS_CARD_ID,
    noun: "Jots",
    toggle: TUG_ACTIONS.TOGGLE_JOTS,
    key: "KeyJ",
    label: "j",
  },
  {
    componentId: LAYOUT_CARD_ID,
    noun: "Layout",
    toggle: TUG_ACTIONS.TOGGLE_LAYOUT,
    key: "KeyL",
    label: "l",
  },
  {
    componentId: OVERVIEW_CARD_ID,
    noun: "Overview",
    toggle: TUG_ACTIONS.TOGGLE_OVERVIEW,
    key: "KeyO",
    label: "o",
  },
  {
    componentId: TRIPWIRES_CARD_ID,
    noun: "Tripwires",
    toggle: TUG_ACTIONS.TOGGLE_TRIPWIRES,
    key: "KeyT",
    label: "t",
  },
] as const;

/**
 * One card's standing, with an absent key reading as hidden.
 *
 * The map is keyed by the registry's sidebar cards, so a miss means the id
 * names no sidebar card at all — which is a hidden card as far as a row is
 * concerned, and the reading that leaves the predicates total.
 */
function sidebarFact(
  chain: CommandValidationSource,
  componentId: string,
): SidebarMenuFact {
  return (
    chain.menu.sidebars[componentId] ?? {
      showing: false,
      side: DEFAULT_SIDEBAR_SIDE,
      focused: false,
    }
  );
}

/**
 * Window ▸ ⟨Card⟩ — the toggle row and the Left / Right pair, per sidebar card.
 *
 * **The mark is the ladder read back** ([P07]). `sidebar-toggle.ts` runs three
 * rungs on one gesture, and the row shows which rung the next click is on: off
 * for a card with no instance, on for one that shows without holding the
 * keyboard, and `"mixed"` for the one that shows and IS the first-responder
 * card. A two-state check could not tell the last two apart, which is the
 * whole reason a visible card's row would otherwise lie about what a click
 * does.
 *
 * The toggle keeps the `toggle-<card>` command id it has always had, and only
 * its item moves — so the chord fires the same verb whether it comes from this
 * table or from a user's keymap override, and the title the row draws says
 * what that verb will do. **The chord needs no ladder of its own**: it reaches
 * `toggle-<card>`, which IS the ladder, so what the row displays and what the
 * chord does cannot come apart. It is always enabled: a card with no instance
 * has one to show, and a showing one has somewhere for the ladder to go.
 *
 * The side pair sends the `set-sidebar-side` the Layout card's own controls
 * send, so the two surfaces drive one store and cannot disagree. It is live
 * only while the card shows — the Layout card's set-the-side-then-show dance
 * is for a picker that offers a hidden card a side, and these rows do not.
 */
const SIDEBAR_CARD_COMMANDS: readonly CommandEntry[] =
  SIDEBAR_MENU_CARDS.flatMap(({ componentId, noun, toggle, key, label }): CommandEntry[] => [
    {
      id: toggle,
      title: `Show ${noun}`,
      routing: "registry",
      menuItemId: `window.sidebar.${componentId}.show`,
      mirrored: true,
      // ⌃⌘⟨letter⟩, one per card. `menuEligible` with an EMPTY Swift key
      // equivalent, the discipline every row in this menu follows:
      // `applyCommandChords` writes it from this table — recursing into the
      // card's submenu to reach it — so the chord stays rebindable end to end.
      bindings: [
        chord({ key, meta: true, ctrl: true, label }, {
          preventDefault: true,
          menuEligible: true,
        }),
      ],
      validate: () => true,
      state: (chain: CommandValidationSource) => {
        const fact = sidebarFact(chain, componentId);
        if (!fact.showing) return false;
        return fact.focused ? "mixed" : true;
      },
      // What the NEXT click does, which is the only honest title for a row
      // whose one gesture means three things.
      dynamicTitle: (chain: CommandValidationSource) => {
        const fact = sidebarFact(chain, componentId);
        if (!fact.showing) return `Show ${noun}`;
        return fact.focused ? `Hide ${noun}` : `Activate ${noun}`;
      },
    },
    ...(["left", "right"] as const).map((side): CommandEntry => ({
      id: `${TUG_ACTIONS.SET_SIDEBAR_SIDE}:${componentId}:${side}`,
      title: side === "left" ? "Left" : "Right",
      routing: "registry",
      action: TUG_ACTIONS.SET_SIDEBAR_SIDE,
      payload: { componentId, side },
      menuItemId: `window.sidebar.${componentId}.${side}`,
      mirrored: true,
      bindings: [],
      validate: (chain: CommandValidationSource) =>
        sidebarFact(chain, componentId).showing,
      state: (chain: CommandValidationSource) =>
        sidebarFact(chain, componentId).side === side,
    })),
  ]);

export const COMMANDS: readonly CommandEntry[] = [
  // ---- File ----
  {
    id: TUG_ACTIONS.NEW_TEXT_CARD,
    title: "New Text File",
    routing: "first-responder",
    menuItemId: "file.newTextCard",
  },
  {
    id: TUG_ACTIONS.OPEN_FILE,
    title: "Open File…",
    routing: "first-responder",
    menuItemId: "file.openFile",
  },
  {
    // Two gates, and they answer different questions. The predicate is
    // the one that matters: a search with no root cannot run, and the
    // chain cannot know that. The canvas's handler is what makes the
    // command reachable at all.
    id: TUG_ACTIONS.OPEN_QUICKLY,
    title: "Open Quickly…",
    routing: "first-responder",
    menuItemId: "file.openQuickly",
    mirrored: true,
    validate: (chain) => chain.menu.openQuickly,
  },
  {
    // Its door is the changeset card's pop-out affordance — a control, not
    // a menu item or a chord.
    id: TUG_ACTIONS.OPEN_DIFF,
    title: "Open Diff",
    routing: "registry",
    internal: true,
  },
  {
    // Its door is an Overview post's arc chip — a link, not a menu item or
    // a chord. Distinct from Show Arcs on purpose: a link reveals the rail,
    // where the toggle would take it away from a reader who had it open.
    id: "reveal-arcs",
    title: "Reveal Arcs",
    routing: "registry",
    internal: true,
  },
  {
    id: TUG_ACTIONS.CLEAR_RECENT_DOCUMENTS,
    title: "Clear Menu",
    routing: "first-responder",
    menuItemId: "file.openRecent.clear",
  },
  {
    id: TUG_ACTIONS.CLOSE,
    title: "Close",
    routing: "first-responder",
    menuItemId: "file.closeCard",
    bindings: [chord({ key: "KeyW", meta: true, label: "w" })],
    mirrored: true,
    validate: (chain) => chain.menu.focusedPaneActiveCardClosable,
  },
  {
    id: TUG_ACTIONS.CLOSE_ALL,
    title: "Close All Tabs",
    routing: "first-responder",
    menuItemId: "file.closeAllCardTabs",
    bindings: [chord({ key: "KeyW", meta: true, alt: true, label: "w" })],
    mirrored: true,
    validate: (chain) => chain.menu.focusedPaneCardCount > 1,
  },
  // The save family gates on the frontmost Text card's block, reduced by
  // the one function that owns that matrix ([P06]: the gate is asked of the
  // surface that would perform, and the block is that surface's answer).
  // Automatic-mode Save stays enabled whenever the card is writable — a
  // disabled item eats its own ⌘S with a beep rather than letting it
  // through.
  {
    id: TUG_ACTIONS.SAVE,
    title: "Save…",
    routing: "first-responder",
    menuItemId: "file.save",
    bindings: [
      chord({ key: "KeyS", meta: true, label: "s" }, { preventDefault: true }),
    ],
    mirrored: true,
    validate: (chain) => chain.menu.fileGates?.save ?? false,
  },
  {
    id: TUG_ACTIONS.SAVE_AS,
    title: "Save As…",
    routing: "first-responder",
    menuItemId: "file.saveAs",
    // ⇧⌘S is claimed only while a Text card is frontmost. Save As… on any
    // other card would have nothing to write, and a chord left on a dimmed
    // item is eaten at the menu bar with a beep instead of falling through —
    // so the chord comes off with the card rather than merely going dark.
    bindings: [
      chord(
        { key: "KeyS", meta: true, shift: true, label: "s" },
        { preventDefault: true, menuEligible: true },
      ),
    ],
    mirrored: true,
    validate: (chain) => chain.menu.fileGates?.saveAs ?? false,
    chordActive: (chain) => chain.menu.fileGates !== null,
  },
  {
    id: TUG_ACTIONS.SAVE_A_COPY,
    title: "Save a Copy…",
    routing: "first-responder",
    menuItemId: "file.saveACopy",
    mirrored: true,
    validate: (chain) => chain.menu.fileGates?.saveACopy ?? false,
  },
  {
    id: TUG_ACTIONS.REVERT_TO_SAVED,
    title: "Revert to Saved",
    routing: "first-responder",
    menuItemId: "file.revertToSaved",
    mirrored: true,
    validate: (chain) => chain.menu.fileGates?.revert ?? false,
  },
  {
    id: TUG_ACTIONS.RELOAD_FROM_DISK,
    title: "Reload from Disk",
    routing: "first-responder",
    menuItemId: "file.reloadFromDisk",
    mirrored: true,
    validate: (chain) => chain.menu.fileGates?.reload ?? false,
  },
  // The two verbs a document card contributes to its PANE's title bar, each
  // as a standing button there. That button is a real door — every press is
  // dispatched through this table, and the registry answers for its title,
  // its enablement, and its chord — but it is a door the door-coverage lint
  // cannot see, because it counts only native menu items and key
  // equivalents. So both say `paneChrome`, which names the door they have
  // rather than claiming they have none: `internal` would be a lie here, and
  // a lie that hides them from the keymap pane. Both are listed there,
  // unbound, because a chord is a door neither has been asked for yet.
  //
  // Enablement is the chain's, not the card's: a Text card that computed its
  // own `disabled` for these would be the second opinion [L30] forbids.
  //
  // KEY-CARD routed, not first-responder. Both mean "the card this title bar
  // belongs to", and pressing a title-bar button promotes the PANE as first
  // responder — so a first-responder walk starts ABOVE the card and never
  // enters it. Key-card dispatch starts at the active card's card-content
  // responder, which is where a card's own verbs belong.
  {
    id: TUG_ACTIONS.REVEAL_CARD_FILE,
    title: "Reveal in Finder",
    routing: "key-card",
    paneChrome: true,
  },
  {
    id: TUG_ACTIONS.SHOW_CARD_SETTINGS,
    title: "Card Settings…",
    routing: "key-card",
    paneChrome: true,
  },

  // ---- Edit ----
  //
  // Cut / Copy / Paste / Delete / Select All are `NSApp.sendAction` to the
  // `NSText` selectors: AppKit performs them against whatever the native
  // responder chain holds, and no control frame is sent. They are
  // represented here so they are nameable and visible to the keymap UI
  // rather than being commands the user cannot find ([P04]).
  //
  // AppKit performs them, but the chain decides whether they are available:
  // a native-routed entry has no responder to defer to, so each names the
  // chain query explicitly. This is the same answer `validateAction` gives
  // the Edit block today, asked by the item that needs it.
  {
    id: TUG_ACTIONS.CUT,
    title: "Cut",
    routing: "native",
    menuItemId: "edit.cut",
    bindings: [
      chord({ key: "KeyX", meta: true, label: "x" }, { preventDefault: true }),
    ],
    mirrored: true,
    validate: (chain) => chain.validateAction(TUG_ACTIONS.CUT),
  },
  {
    id: TUG_ACTIONS.COPY,
    title: "Copy",
    routing: "native",
    menuItemId: "edit.copy",
    bindings: [
      chord({ key: "KeyC", meta: true, label: "c" }, { preventDefault: true }),
    ],
    mirrored: true,
    validate: (chain) => chain.validateAction(TUG_ACTIONS.COPY),
  },
  {
    id: TUG_ACTIONS.PASTE,
    title: "Paste",
    routing: "native",
    menuItemId: "edit.paste",
    bindings: [
      chord({ key: "KeyV", meta: true, label: "v" }, { preventDefault: true }),
    ],
    mirrored: true,
    validate: (chain) => chain.validateAction(TUG_ACTIONS.PASTE),
  },
  {
    id: TUG_ACTIONS.DELETE,
    title: "Delete",
    routing: "native",
    menuItemId: "edit.delete",
    mirrored: true,
    validate: (chain) => chain.validateAction(TUG_ACTIONS.DELETE),
  },
  {
    id: TUG_ACTIONS.SELECT_ALL,
    title: "Select All",
    routing: "native",
    menuItemId: "edit.selectAll",
    bindings: [
      chord({ key: "KeyA", meta: true, label: "a" }, { preventDefault: true }),
    ],
    mirrored: true,
    validate: (chain) => chain.validateAction(TUG_ACTIONS.SELECT_ALL),
  },
  // Undo and Redo are deliberately NOT mirrored: when a native text control
  // is focused the host validates them from the web view's own
  // NSUndoManager, which is live AppKit state the registry cannot see. The
  // one item whose truth is not the frontend's keeps its host-side case.
  {
    id: TUG_ACTIONS.UNDO,
    title: "Undo",
    routing: "first-responder",
    menuItemId: "edit.undo",
    bindings: [chord({ key: "KeyZ", meta: true, label: "z" })],
  },
  {
    id: TUG_ACTIONS.REDO,
    title: "Redo",
    routing: "first-responder",
    menuItemId: "edit.redo",
    bindings: [chord({ key: "KeyZ", meta: true, shift: true, label: "z" })],
  },
  {
    id: TUG_ACTIONS.COPY_AS_PLAIN_TEXT,
    title: "Copy as Plain Text",
    routing: "first-responder",
    menuItemId: "edit.copyAsPlainText",
    bindings: [
      chord(
        { key: "KeyC", meta: true, shift: true, alt: true, label: "c" },
        { preventDefault: true },
      ),
    ],
    mirrored: true,
    // Shares Copy's gate: both need a selection, and a surface that offers
    // one offers the other.
    validate: (chain) => chain.validateAction(TUG_ACTIONS.COPY),
  },
  {
    id: TUG_ACTIONS.PASTE_AS_QUOTE,
    title: "Paste as Quote",
    routing: "first-responder",
    menuItemId: "edit.pasteAsQuote",
    bindings: [
      chord(
        { key: "KeyV", meta: true, alt: true, label: "v" },
        { preventDefault: true },
      ),
    ],
    mirrored: true,
    // Both paste variants share Paste's gate: an editable surface is the
    // whole requirement.
    validate: (chain) => chain.validateAction(TUG_ACTIONS.PASTE),
  },
  {
    id: TUG_ACTIONS.PASTE_AS_PLAIN_TEXT,
    title: "Paste as Plain Text",
    routing: "first-responder",
    menuItemId: "edit.pasteAsPlainText",
    bindings: [
      chord(
        { key: "KeyV", meta: true, shift: true, alt: true, label: "v" },
        { preventDefault: true },
      ),
    ],
    mirrored: true,
    validate: (chain) => chain.validateAction(TUG_ACTIONS.PASTE),
  },
  // The case pair carries no predicate: first-responder routing asks the
  // editable surface itself, which answers on its writability — the same
  // gate Delete gets, at the same granularity (focus, not caret), and for
  // the same reason: a selection-granular answer would be stale by the time
  // the menu opened. Each handler no-ops on a collapsed selection.
  //
  // ⌥⌘U / ⌥⌘L are the user's grant and are recorded as an anomaly in
  // chord-tiers.md: ⌥ composes on no base here (neither ⌘U nor ⌘L is
  // bound), so the pair is a mnemonic — U for upper, L for lower — rather
  // than a derivation. `menuEligible` with an empty Swift key equivalent,
  // so `applyCommandChords` writes both and both stay rebindable.
  {
    id: TUG_ACTIONS.MAKE_UPPERCASE,
    title: "Make Uppercase",
    routing: "first-responder",
    menuItemId: "edit.makeUppercase",
    bindings: [
      chord(
        { key: "KeyU", meta: true, alt: true, label: "u" },
        { preventDefault: true, menuEligible: true },
      ),
    ],
    mirrored: true,
  },
  {
    id: TUG_ACTIONS.MAKE_LOWERCASE,
    title: "Make Lowercase",
    routing: "first-responder",
    menuItemId: "edit.makeLowercase",
    bindings: [
      chord(
        { key: "KeyL", meta: true, alt: true, label: "l" },
        { preventDefault: true, menuEligible: true },
      ),
    ],
    mirrored: true,
  },
  // The Find items carry no predicate: they are first-responder-routed, so
  // the default chain walk asks the focused surface directly — which is
  // exactly the question, and the answer stays false until a find-capable
  // surface is focused.
  {
    id: TUG_ACTIONS.FIND,
    title: "Find…",
    routing: "first-responder",
    menuItemId: "edit.find",
    bindings: [
      chord({ key: "KeyF", meta: true, label: "f" }, { preventDefault: true }),
    ],
    mirrored: true,
  },
  {
    id: TUG_ACTIONS.FIND_NEXT,
    title: "Find Next",
    routing: "first-responder",
    menuItemId: "edit.findNext",
    bindings: [chord({ key: "KeyG", meta: true, label: "g" })],
    mirrored: true,
  },
  {
    id: TUG_ACTIONS.FIND_PREVIOUS,
    title: "Find Previous",
    routing: "first-responder",
    menuItemId: "edit.findPrevious",
    bindings: [chord({ key: "KeyG", meta: true, shift: true, label: "g" })],
    mirrored: true,
  },
  {
    // ⌘E out of the plain-⌘ free pool, which reserved the slot for exactly
    // this ("claimable with honest use: Find-adjacent", chord-tiers.md): the
    // slot's convention IS Use Selection for Find, and R1 offers no composed
    // alternative — a ⇧/⌥ twist of ⌘F would have to read as a variant of
    // opening the find bar, which this is not.
    //
    // No predicate, like its siblings: the chain walk asks the focused
    // surface, and a surface that registered the handler is one that can
    // search for a selection. It deliberately does NOT gate on there BEING a
    // selection — a gate is computed when the menuState is pushed and a drag
    // pushes nothing, so a selection-granular answer would go stale exactly
    // when it mattered and AppKit would eat ⌘E at the menu bar. An empty
    // selection is a no-op at the responder instead.
    id: TUG_ACTIONS.FIND_SELECTION,
    title: "Use Selection for Find",
    routing: "first-responder",
    menuItemId: "edit.useSelectionForFind",
    bindings: [
      chord({ key: "KeyE", meta: true, label: "e" }, { preventDefault: true }),
    ],
    mirrored: true,
  },

  // ---- Session ----
  {
    id: TUG_ACTIONS.FOCUS_PROMPT,
    title: "Focus Prompt",
    routing: "key-card",
    menuItemId: "session.focusPrompt",
    bindings: [
      chord({ key: "KeyK", meta: true, label: "k" }, { preventDefault: true }),
    ],
    mirrored: true,
    // The composer exists on any session card, bound or not.
    validate: sessionCardFrontmost,
  },
  {
    // Routed first-responder so the prompt entry holding the caret is the
    // one that receives the path — including the gallery's, which no
    // card-level predicate would reach. The session card answers it too,
    // from its card-content responder, so the command is live anywhere in
    // the card rather than only while the composer is the seat of focus;
    // the chain walk that finds either is the item's gate. The host runs
    // the open panel before dispatching, so the dispatch carries the path.
    id: TUG_ACTIONS.INSERT_FILE,
    title: "Insert File…",
    routing: "first-responder",
    menuItemId: "session.insertFile",
    // Menu-eligible on purpose: the panel that produces the path is the
    // host's, so the chord has to reach the menu item rather than the JS
    // funnel, where the command would dispatch with no file chosen.
    //
    // ⇧⌘I, not ⌃⌘I — the ⌃ seat went to AI Model, and the I stayed here for
    // Insert. The two share a letter on purpose: both are composer gestures
    // reached from the same seat, and neither has a better initial.
    bindings: [
      chord(
        { key: "KeyI", meta: true, shift: true, label: "i" },
        { preventDefault: true, menuEligible: true },
      ),
    ],
    mirrored: true,
  },
  {
    id: TUG_ACTIONS.INTERRUPT_SESSION,
    title: "Stop",
    routing: "key-card",
    menuItemId: "session.stop",
    mirrored: true,
    validate: (chain) =>
      chain.menu.sessionCardFrontmost &&
      (chain.menu.session?.canInterrupt ?? false),
  },
  {
    id: TUG_ACTIONS.CYCLE_PERMISSION_MODE,
    title: "Cycle Permission Mode",
    routing: "key-card",
    menuItemId: "session.permissionMode.cycle",
    bindings: [
      chord(
        { key: "KeyP", ctrl: true, alt: true, meta: true, label: "p" },
        { preventDefault: true },
      ),
    ],
    mirrored: true,
    validate: sessionSettingsChangeable,
  },
  {
    id: TUG_ACTIONS.TOGGLE_CHANGES_VIEW,
    title: "Show Session Changes",
    routing: "key-card",
    menuItemId: "session.toggleChanges",
    bindings: [
      chord(
        { key: "KeyC", ctrl: true, meta: true, label: "c" },
        { preventDefault: true },
      ),
    ],
    mirrored: true,
    validate: sessionBound,
    // One command, two verbs: the item says what the gesture will do, so
    // the title follows the Shade's live visibility.
    dynamicTitle: (chain) =>
      (chain.menu.session?.changesVisible ?? false)
        ? "Hide Session Changes"
        : "Show Session Changes",
  },
  {
    id: TUG_ACTIONS.TOGGLE_HISTORY_VIEW,
    title: "Show Commit History",
    routing: "key-card",
    menuItemId: "session.toggleHistory",
    bindings: [
      chord(
        { key: "KeyH", ctrl: true, meta: true, label: "h" },
        { preventDefault: true },
      ),
    ],
    mirrored: true,
    validate: sessionBound,
    dynamicTitle: (chain) =>
      (chain.menu.session?.historyVisible ?? false)
        ? "Hide Commit History"
        : "Show Commit History",
  },
  {
    // The card-scoped minimize ([B04], [P02]). Its three doors are the button
    // ahead of Z4A, this item, and ⌥⌘M — one action, so the state the doors
    // read and the commit they land are the same one ([L11]).
    //
    // ⌥ is the variant operator (`tuglaws/chord-tiers.md`): ⌘M minimizes the
    // window, ⌥⌘M minimizes the card. `menuEligible` puts the match at the
    // menu bar, so the item's gate is what answers the chord too — a non-
    // Session key card disables the item and beeps the chord, which is honest
    // about a verb that has nothing to act on.
    //
    // Gated on a BOUND session, not merely on a Session card being frontmost.
    // An unbound card renders `SessionProjectPicker` rather than
    // `SessionCardBody`, and the responder that answers this command — along
    // with the masthead, the Z2 row and the bar the minimized form IS — lives
    // in the body. Validating on the card type alone would leave the item
    // enabled and the chord live over a card that can do nothing with either.
    id: TUG_ACTIONS.TOGGLE_SESSION_MINIMIZED,
    title: "Minimize Session",
    routing: "key-card",
    menuItemId: "session.minimize",
    bindings: [
      chord(
        { key: "KeyM", alt: true, meta: true, label: "m" },
        { preventDefault: true, menuEligible: true },
      ),
    ],
    mirrored: true,
    validate: sessionBound,
    // One command, two verbs — the item says what the gesture will do, the
    // shape the two shade toggles above already take.
    dynamicTitle: (chain) =>
      (chain.menu.session?.minimized ?? false)
        ? "Show Transcript"
        : "Minimize Session",
  },
  ...SLASH_BRIDGE_COMMANDS,

  // ---- View ----
  // The focus ring's two directions, promoted out of the raw Tab listener into
  // the table ([L30]) — they were user-invocable commands with no row and no
  // discoverable door. Both are deliberately chordless HERE: ⇥ / ⇧⇥ stay with
  // the focus walk in `responder-chain-provider`, which owns a precedence
  // ladder (a surface consuming Tab keeps it; an empty walk yields to native
  // Tab) that a menu key equivalent would sit above and destroy. Same bargain
  // `interrupt-session` takes with Escape: the chord routes in JS, the menu
  // item is the discoverable face.
  //
  // View rather than Session on purpose: the ring is deck-wide, and the
  // Session menu's premise is that its items dim without a frontmost session
  // card.
  {
    id: TUG_ACTIONS.PREVIOUS_KEYBOARD_FOCUS,
    title: "Previous Keyboard Focus",
    routing: "registry",
    menuItemId: "view.previousKeyboardFocus",
  },
  {
    id: TUG_ACTIONS.NEXT_KEYBOARD_FOCUS,
    title: "Next Keyboard Focus",
    routing: "registry",
    menuItemId: "view.nextKeyboardFocus",
  },
  {
    // The theme submenu's membership is a filesystem scan, so the payload
    // set is only known at runtime.
    id: "set-theme",
    title: "Theme",
    routing: "registry",
    parameterized: true,
  },
  {
    // ⇧⌘T. The Tripwires card holds ⌃⌘T, and a theme is the weaker claim on
    // that letter: the sidebar cards are a closed set with a mnemonic each,
    // while Next Theme has no ⌘T base to be a variant of and so is free to sit
    // anywhere (chord-tiers.md). ⇧⌘T is free of AppKit's Show Tab Bar only
    // because Tug sets `allowsAutomaticWindowTabbing = false`.
    //
    // Menu-eligible, so the chord resolves at the native menu layer where the
    // item already lives; the binding is what makes it visible to the keymap
    // pane and rebindable at all. `menuChords()` claims a menu item for a
    // non-`mirrored` entry too, so no gate work is needed to publish it. The
    // Swift construction literal moves with this, because `rebuildViewMenu`
    // re-runs that constructor on every View menu open.
    id: "next-theme",
    title: "Next Theme",
    routing: "registry",
    menuItemId: "view.nextTheme",
    bindings: [
      chord(
        { key: "KeyT", shift: true, meta: true, label: "t" },
        { preventDefault: true, menuEligible: true },
      ),
    ],
  },
  // The three zoom commands state their chords here and take their
  // enablement from the host: the predicate reads `window.currentPageZoom`,
  // which is the host's own property and changes as these very commands run.
  // The gate carries the chord alone, and the host's tier keeps the bounds.
  {
    // Two bindings, one command: ⌘+ is what the menu shows, ⌘= is Safari's
    // no-shift ergonomic alias. An `NSMenuItem` carries one key equivalent,
    // so the menu takes the first and the hidden `view.zoomInAlias` item
    // keeps ⌘= as its constructed literal.
    id: TUG_ACTIONS.ZOOM_IN,
    title: "Zoom In",
    routing: "first-responder",
    menuItemId: "view.zoomIn",
    bindings: [
      chord(
        { key: "Equal", meta: true, shift: true, label: "+" },
        { preventDefault: true, menuEligible: true },
      ),
      chord({ key: "Equal", meta: true, label: "=" }, { preventDefault: true }),
    ],
  },
  {
    id: TUG_ACTIONS.ZOOM_OUT,
    title: "Zoom Out",
    routing: "first-responder",
    menuItemId: "view.zoomOut",
    bindings: [
      chord(
        { key: "Minus", meta: true, label: "-" },
        { preventDefault: true, menuEligible: true },
      ),
    ],
  },
  {
    id: TUG_ACTIONS.ZOOM_ACTUAL,
    title: "Actual Size",
    routing: "first-responder",
    menuItemId: "view.actualSize",
    bindings: [
      chord(
        { key: "Digit0", meta: true, label: "0" },
        { preventDefault: true, menuEligible: true },
      ),
    ],
  },

  // ---- Window / deck ----
  {
    // The pane list is rebuilt per open, so the payload set is runtime.
    id: TUG_ACTIONS.FOCUS_PANE,
    title: "Focus Pane",
    routing: "first-responder",
    parameterized: true,
  },
  {
    id: TUG_ACTIONS.PREVIOUS_TAB,
    title: "Previous Card",
    routing: "first-responder",
    menuItemId: "window.previousCard",
    bindings: [
      chord({ key: "BracketLeft", meta: true, shift: true, label: "[" }),
    ],
    mirrored: true,
    validate: cardNavigationAvailable,
  },
  {
    id: TUG_ACTIONS.NEXT_TAB,
    title: "Next Card",
    routing: "first-responder",
    menuItemId: "window.nextCard",
    bindings: [
      chord({ key: "BracketRight", meta: true, shift: true, label: "]" }),
    ],
    mirrored: true,
    validate: cardNavigationAvailable,
  },
  // The depth axis of card navigation: rotate the focused pane's slot stack
  // front to back (⌥⌘] ) or back to front (⌥⌘[ ) — the ⌥-variant of the
  // lateral pair on the same bracket keys, per the chord algebra. The three
  // stack items take no deselected-deck escape hatch: they act on a SPECIFIC
  // pane's stack, and with nothing selected there is no such pane.
  {
    id: TUG_ACTIONS.PREVIOUS_STACK_CARD,
    title: "Previous Card in Stack",
    routing: "first-responder",
    menuItemId: "window.previousCardInStack",
    bindings: [
      chord({ key: "BracketLeft", meta: true, alt: true, label: "[" }),
    ],
    mirrored: true,
    validate: (chain) => chain.menu.stackDepth > 1,
  },
  {
    id: TUG_ACTIONS.NEXT_STACK_CARD,
    title: "Next Card in Stack",
    routing: "first-responder",
    menuItemId: "window.nextCardInStack",
    bindings: [
      chord({ key: "BracketRight", meta: true, alt: true, label: "]" }),
    ],
    mirrored: true,
    validate: (chain) => chain.menu.stackDepth > 1,
  },
  // Reveal Stack detaches ⌘R when the stack has nowhere to go — a chord on
  // a dimmed item is eaten at the menu bar with a beep, and ⌘R dead
  // everywhere is a worse answer than ⌘R inapplicable here.
  {
    id: TUG_ACTIONS.REVEAL_STACK,
    title: "Reveal Stack",
    routing: "first-responder",
    menuItemId: "window.revealStack",
    bindings: [
      chord(
        { key: "KeyR", meta: true, label: "r" },
        { preventDefault: true, menuEligible: true },
      ),
    ],
    mirrored: true,
    validate: (chain) => chain.menu.stackDepth > 1,
    disabledChord: "detach",
  },
  ...GO_TO_SLOT_COMMANDS,
  ...FOCUS_CARD_COMMANDS,
  ...RAIL_TOGGLE_COMMANDS,
  ...CARD_WIDTH_COMMANDS,
  // ⌃⌘B — bullseye: put the focused card in a centered, comfy-width reading
  // posture with every other surface receded, and take it back out.
  //
  // **The tier, derived** (tuglaws/chord-tiers.md): a card's posture on the
  // deck is Tug's own layout machinery, so it takes the Tug tier ⌃⌘
  // alongside ⌃⌘←/→ Show Rail, ⌃⌘T Next Theme, and the ⌃⌘1..6 Go to Slot
  // row directly above. Plain ⌘ is out under R3 — a deliberate posture change is
  // not a many-times-an-hour verb — and the composed sets are out under R1,
  // because there is no ⌘B base for this to be a variant or counterpart of
  // (⌘B is held in reserve for bold, and Tug renders markdown).
  //
  // **Promoted to the Window menu**, which under R6 makes the grant total:
  // the item preempts every scoped binding on ⌃⌘B, and that is intended —
  // bullseye is a deck-level posture, so no surface should be able to
  // decline it. The Swift item is constructed with an EMPTY key equivalent
  // so `applyCommandChords` writes the chord from this table and it stays
  // rebindable end to end, the discipline the width row follows.
  {
    id: TUG_ACTIONS.TOGGLE_BULLSEYE,
    title: "Bullseye",
    routing: "first-responder",
    action: TUG_ACTIONS.TOGGLE_BULLSEYE,
    menuItemId: "window.bullseye",
    mirrored: true,
    bindings: [
      chord({ key: "KeyB", meta: true, ctrl: true }, { menuEligible: true }),
    ],
    // Both predicates read the published fact for the same reason the width
    // row's do: which pane is focused, and whether it stands in bullseye, is
    // deck state — the canvas answering "yes I handle toggle-bullseye" says
    // nothing about whether THIS pane can hold the posture.
    validate: (chain) => chain.menu.bullseye !== null,
    state: (chain) => chain.menu.bullseye?.on === true,
  },
  ...SLOT_COMMANDS,
  ...NUDGE_SLOT_COMMANDS,
  ...COLUMN_SPLIT_COMMANDS,
  // ⌃⌥⌘R — Resize Sidebars to Fit: stand every rail's cards at the heights
  // their content asks for, once ([B07], [B08]).
  //
  // **The tier, and the anomaly it is recorded as** (tuglaws/chord-tiers.md):
  // ⌃⌥⌘ is the advanced form of a Tug-tier command, and ⌃⌘R is the Arcs card
  // rather than a base this varies — so the grant is the tier's second
  // resident with a reading of its own, R for *Resize*, on the tier reserved
  // for deck-shaping verbs a user reaches for deliberately.
  //
  // `menuEligible`, so the Window row's key equivalent preempts every scoped
  // binding: the rails are the deck's own geometry and no focused surface
  // should be able to decline a verb about them. The Swift item is built with
  // an EMPTY key equivalent, so `applyCommandChords` writes the chord from
  // this table and it stays rebindable end to end.
  //
  // Ungated. A rail with two members always has a division to write, and one
  // with fewer has nothing to divide either way — a dimmed row would be
  // reporting a fact about the rails that the rails themselves already show.
  {
    id: TUG_ACTIONS.RESIZE_SIDEBARS_TO_FIT,
    title: "Resize Sidebars to Fit",
    routing: "registry",
    menuItemId: "window.resizeSidebarsToFit",
    mirrored: true,
    bindings: [
      chord(
        { key: "KeyR", meta: true, ctrl: true, alt: true, label: "r" },
        { preventDefault: true, menuEligible: true },
      ),
    ],
    validate: () => true,
  },
  {
    // Its door is the pane's close box — a targeted control, invisible to
    // a lint that can only see menu items and chords.
    id: TUG_ACTIONS.CLOSE_PANE,
    title: "Close Pane",
    routing: "target",
    internal: true,
  },

  {
    // Its door is the Layout card's kind picker.
    id: "set-imposition",
    title: "Set Imposition",
    routing: "registry",
    internal: true,
  },
  {
    // Its door is the Layout card's sidebar positions group — one
    // control per registered sidebar card, so the payload set is runtime.
    id: TUG_ACTIONS.SET_SIDEBAR_SIDE,
    title: "Set Sidebar Side",
    routing: "registry",
    internal: true,
  },
  {
    // Its door is the Layout card's per-card row: Off hides the
    // card, a side segment shows a hidden one. The componentId set is the
    // registry's, so the payload set is runtime.
    id: TUG_ACTIONS.SET_SIDEBAR_OPEN,
    title: "Set Sidebar Open",
    routing: "registry",
    internal: true,
  },
  {
    // Its door is the Layout card's Slot Window row. Internal for the
    // reason the rows around it are: the two widths are a segmented choice
    // whose answer is only legible beside the rows it redraws, so a palette
    // entry reading "Set Slot Window" would be a verb with no picture.
    id: TUG_ACTIONS.SET_SLOT_WINDOW,
    title: "Set Slot Window",
    routing: "registry",
    internal: true,
  },
  {
    // Its doors are the stack badge menu, the Layout card's per-slot
    // column row, and ⌃⌘S; the slot set is the deck's, so the payload set is
    // runtime.
    id: TUG_ACTIONS.SET_COLUMN_MODE,
    title: "Set Column Mode",
    routing: "registry",
    internal: true,
  },
  {
    // Its door is the stack badge menu.
    id: TUG_ACTIONS.EQUALIZE_COLUMN,
    title: "Equalize Column Heights",
    routing: "registry",
    internal: true,
  },
  {
    // Its door is the pane title bar's width popup.
    id: TUG_ACTIONS.SET_CARD_WIDTH,
    title: "Set Card Width",
    routing: "registry",
    internal: true,
  },
  {
    // Its doors are `toggle-session-minimized` and the minimize control at Z2's
    // leading edge — both card-addressed gestures, and this is the one write
    // path they share.
    id: TUG_ACTIONS.SET_CARD_MINIMIZED,
    title: "Set Card Minimized",
    routing: "registry",
    internal: true,
  },
  {
    // Its doors are the pane title bar's target button and `toggle-bullseye`,
    // which resolves "the pane I am in" and hands off here.
    id: TUG_ACTIONS.SET_BULLSEYE,
    title: "Set Bullseye",
    routing: "registry",
    internal: true,
  },
  {
    // Its door is the Layout card's Card Width group.
    id: TUG_ACTIONS.SET_CONTENT_WIDTH,
    title: "Set Content Width",
    routing: "registry",
    internal: true,
  },
  {
    // Its door is the Layout card's Layout group.
    id: TUG_ACTIONS.SET_IMPOSITION_LAYOUT,
    title: "Set Imposition Layout",
    routing: "registry",
    internal: true,
  },
  {
    // The slot set follows the active imposition, so the payload set is
    // runtime; its door is the Cards card's row slot pickers.
    id: "assign-slot",
    title: "Assign Slot",
    routing: "registry",
    parameterized: true,
  },
  {
    // The relative sibling of `assign-slot`, and its own entry because the two
    // differ in what success looks like: an absolute assign always flashes,
    // while a nudge that took has moved the deck and needs no receipt beyond
    // the motion. Its only door is the ⌃⌘ bracket pair.
    id: "nudge-slot-selection",
    title: "Nudge Slot Selection",
    routing: "registry",
    internal: true,
  },
  {
    // Its door is a session monitor row in the Cards card.
    id: "focus-session-card",
    title: "Focus Session Card",
    routing: "registry",
    internal: true,
  },

  // ---- Jots ----
  {
    // ⌘J — plain-⌘ tier, earned by frequency: capture is something you reach
    // for mid-thought, and a jot you have to open a card to write is a jot you
    // don't write. Menu-eligible so the chord fires even when the native title
    // bar holds focus.
    id: TUG_ACTIONS.NEW_JOT,
    title: "New Jot",
    routing: "first-responder",
    menuItemId: "file.newJot",
    bindings: [
      chord(
        { key: "KeyJ", meta: true, label: "j" },
        { preventDefault: true, menuEligible: true },
      ),
    ],
  },
  // ---- Sidebar cards ----
  // The six toggles and their side pairs, generated together because one
  // fact answers all three rows of a card.
  ...SIDEBAR_CARD_COMMANDS,

  // ---- App level ----
  {
    // ⌃⌘K — the keyboard's own card, reached from the keyboard. ⌘, belongs to
    // Settings and ⌘K is taken, so this sits a modifier away from both: the
    // one card whose subject is chords should not be the one card you can only
    // open with the mouse.
    id: TUG_ACTIONS.SHOW_KEYBOARD_SHORTCUTS,
    title: "Keyboard Shortcuts…",
    routing: "first-responder",
    menuItemId: "app.keyboardShortcuts",
    bindings: [
      chord(
        { key: "KeyK", ctrl: true, meta: true, label: "k" },
        { preventDefault: true, menuEligible: true },
      ),
    ],
  },
  {
    // The app menu's About and New Session items both send this wire with
    // different components; per-value rows are a later menu decision.
    id: "show-card",
    title: "Show Card",
    routing: "registry",
    parameterized: true,
  },
  // ---- Performed by AppKit ----
  //
  // Represented so the keymap UI can show them and the locked policy can
  // name them; never routed through JS ([P04]).
  {
    id: "hide-application",
    title: "Hide Tug",
    routing: "native",
    menuItemId: "app.hide",
    bindings: [chord({ key: "KeyH", meta: true, label: "h" })],
  },
  {
    id: "hide-others",
    title: "Hide Others",
    routing: "native",
    menuItemId: "app.hideOthers",
    bindings: [chord({ key: "KeyH", meta: true, alt: true, label: "h" })],
  },
  {
    id: "show-all",
    title: "Show All",
    routing: "native",
    menuItemId: "app.showAll",
  },
  {
    id: "services",
    title: "Services",
    routing: "native",
    menuItemId: "app.services",
  },
  {
    id: "quit-application",
    title: "Quit Tug",
    routing: "native",
    menuItemId: "app.quit",
    bindings: [chord({ key: "KeyQ", meta: true, label: "q" })],
  },
  {
    id: "minimize",
    title: "Minimize",
    routing: "native",
    menuItemId: "window.minimize",
    bindings: [chord({ key: "KeyM", meta: true, label: "m" })],
  },
  {
    id: "zoom-window",
    title: "Zoom",
    routing: "native",
    menuItemId: "window.zoom",
  },
  {
    id: "toggle-full-screen",
    title: "Enter Full Screen",
    routing: "native",
    menuItemId: "window.enterFullScreen",
    bindings: [chord({ key: "KeyF", ctrl: true, meta: true, label: "f" })],
  },
  {
    id: "configure-tug",
    title: "Configure Tug…",
    routing: "registry",
    menuItemId: "app.configureTug",
  },
  {
    id: "logout",
    title: "Log Out…",
    routing: "registry",
    menuItemId: "app.logout",
  },
  {
    id: "reload",
    title: "Reload",
    routing: "registry",
    menuItemId: "maker.reload",
  },
  {
    // No menu item drives this: Maker ▸ Source Tree… runs its NSOpenPanel
    // in the host and never sends the wire. The registered handler reaches
    // the same picker through the `sourceTree` script-message bridge, so
    // the command works — nothing sends it.
    //
    // Stays `registry` with the other app-level singletons. Its whole body
    // is one post to a host script-message handler: no deck state, no
    // responder that owns it, and no validity anything could be asked
    // for. A chain identity would give it a home that has no relationship
    // to what it does.
    id: "source-tree",
    title: "Source Tree…",
    routing: "registry",
    internal: true,
  },
  {
    id: TUG_ACTIONS.SHOW_COMPONENT_GALLERY,
    title: "New Component Gallery Card",
    routing: "first-responder",
    menuItemId: "maker.galleryCard",
  },
  {
    id: TUG_ACTIONS.ADD_CARD_TO_ACTIVE_PANE,
    title: "New Card in Active Pane",
    routing: "first-responder",
    menuItemId: "maker.newCardInPane",
    bindings: [chord({ key: "KeyT", meta: true, label: "t" })],
    mirrored: true,
    validate: (chain) => chain.menu.paneCount > 0,
  },

  // ---- Named, but not yet doored ----
  //
  // Every entry below is `internal`: it exists so the command has a name
  // the table can see, and its comment says exactly what stands between it
  // and a door. Menu placement for these is a design judgment, not a
  // mechanical one, so it is made where menu real estate is decided — not
  // here, where the job is only to end the anonymity.
  {
    // Its door is the Cards card's rows' center affordance.
    id: TUG_ACTIONS.CENTER_PANE,
    title: "Center Pane",
    routing: "first-responder",
    internal: true,
  },
  {
    // Its door is a rail's pin affordance.
    id: TUG_ACTIONS.PIN_SIDEBAR,
    title: "Pin Sidebar",
    routing: "first-responder",
    internal: true,
  },
  {
    // The shipped door is a Show ⟨card⟩ item, which toggles; the explicit
    // halves exist so a caller that means one of them can say so.
    id: TUG_ACTIONS.SHOW_SIDEBAR_PANE,
    title: "Show Sidebar Pane",
    routing: "first-responder",
    internal: true,
  },
  {
    id: TUG_ACTIONS.HIDE_SIDEBAR_PANE,
    title: "Hide Sidebar Pane",
    routing: "first-responder",
    internal: true,
  },
  {
    // Its door is a drag, which is a gesture rather than a command door.
    id: TUG_ACTIONS.MOVE_PANE,
    title: "Move Pane",
    routing: "first-responder",
    internal: true,
  },
  {
    // Its doors are the Changes sheet's Cancel and the Escape ladder.
    id: TUG_ACTIONS.EXIT_COMMIT_MODE,
    title: "Exit Commit Mode",
    routing: "key-card",
    internal: true,
  },
  {
    // Its door is the Changes sheet's Commit button.
    id: TUG_ACTIONS.LAND_COMMIT,
    title: "Commit",
    routing: "key-card",
    internal: true,
  },
  {
    // ⌃⌘M, live only while the composer is in commit mode — the keyboard
    // twin of the pencil-sparkles button.
    //
    // The chord is stated here so the keymap pane and every hint can read it;
    // *where* it is live is decided by where the composer registers it, which
    // is the [P08] split between a binding's scope and a command's routing.
    // The declared scope names the surface rather than a runtime responder
    // id, because a card's responder id is minted per card and a table cannot
    // name it — `resolveChord` reads the live registration for resolution and
    // this declaration for display.
    id: TUG_ACTIONS.COMMIT_AUTO_MESSAGE,
    title: "Generate a Commit Message",
    routing: "first-responder",
    bindings: [
      {
        chord: { key: "KeyM", ctrl: true, meta: true, label: "m" },
        scope: { kind: "responder", responderId: COMPOSER_RESPONDER_SCOPE },
        source: "default",
        preventDefault: true,
      },
    ],
  },
  {
    // ⌃⌘A — Claim All, in one mnemonic neighbourhood with ⌃⌘C (the shade) and
    // ⌃⌘M (the message). [D172] had evicted it to ⌃⌥⌘A because the Arcs card's
    // Window row held ⌃⌘A, and a menu-eligible chord becomes an AppKit key
    // equivalent that AppKit resolves before the web view sees the keydown —
    // so a scoped binding underneath one reaches nothing even inside its own
    // surface. Arcs moved to ⌃⌘R, which takes the promoted chord off these
    // keys and lets the scoped binding be live again ([D175]).
    //
    // Live only while the composer is in commit mode, which is what raising
    // the Changes shade means. Composite on purpose: the shade wires the
    // unattributed and orphaned buckets as two buttons, and the chord claims
    // both at once. The buttons remain the granular path.
    //
    // Registered by the composer (the surface that holds focus while the
    // passive shade is up) and handled by the session card (the component
    // that holds `changesController`); the composer's unclaimed
    // first-responder action falls through to the card below it.
    id: TUG_ACTIONS.CLAIM_ALL_CHANGES,
    title: "Claim All Changes",
    routing: "first-responder",
    bindings: [
      {
        chord: { key: "KeyA", ctrl: true, meta: true, label: "a" },
        scope: { kind: "responder", responderId: COMPOSER_RESPONDER_SCOPE },
        source: "default",
        preventDefault: true,
      },
    ],
  },
  {
    // ⌃⇧⌘A — Disclaim All, the ⇧-counterpart of Claim All: same key, opposite
    // sense, one finger from its pair. NOT ⌃⌘D, which is macOS Look Up and on
    // the never-bind list — and live in a text field, which is exactly the
    // surface this binding is scoped to. The ⇧ carries "the opposite bulk verb
    // of this shade", not set inversion: ⌃⌘A acts on what is not yet this
    // session's, this one on what is. R1 promises a shared key and an opposite
    // sense and never promised more ([D175]).
    id: TUG_ACTIONS.DISCLAIM_ALL_CHANGES,
    title: "Disclaim All Changes",
    routing: "first-responder",
    bindings: [
      {
        chord: { key: "KeyA", ctrl: true, shift: true, meta: true, label: "a" },
        scope: { kind: "responder", responderId: COMPOSER_RESPONDER_SCOPE },
        source: "default",
        preventDefault: true,
      },
    ],
  },
  {
    // Its doors are the PDF viewer's context menu items.
    id: `${TUG_ACTIONS.ZOOM_TO_FIT}:width`,
    title: "Zoom to Fit Width",
    routing: "first-responder",
    action: TUG_ACTIONS.ZOOM_TO_FIT,
    payload: "width",
    internal: true,
  },
  {
    id: `${TUG_ACTIONS.ZOOM_TO_FIT}:page`,
    title: "Zoom to Fit Page",
    routing: "first-responder",
    action: TUG_ACTIONS.ZOOM_TO_FIT,
    payload: "page",
    internal: true,
  },
  {
    id: `${TUG_ACTIONS.SET_PAGE_MODE}:continuous`,
    title: "Continuous Pages",
    routing: "first-responder",
    action: TUG_ACTIONS.SET_PAGE_MODE,
    payload: "continuous",
    internal: true,
  },
  {
    id: `${TUG_ACTIONS.SET_PAGE_MODE}:single`,
    title: "Single Page",
    routing: "first-responder",
    action: TUG_ACTIONS.SET_PAGE_MODE,
    payload: "single",
    internal: true,
  },
  {
    id: `${TUG_ACTIONS.SET_PAGE_MODE}:two`,
    title: "Two Pages",
    routing: "first-responder",
    action: TUG_ACTIONS.SET_PAGE_MODE,
    payload: "two",
    internal: true,
  },
  {
    // Window ▸ Cascade and Window ▸ Tile are the shipped doors for
    // rearranging the canvas; this name has no separate implementation.
    id: TUG_ACTIONS.RESET_LAYOUT,
    title: "Reset Layout",
    routing: "first-responder",
    internal: true,
  },
  {
    // A card-level maximize does not exist; Window ▸ Zoom is the window's
    // own command, and no responder registers this one.
    id: TUG_ACTIONS.MAXIMIZE,
    title: "Maximize Card",
    routing: "first-responder",
    internal: true,
  },
  {
    // No responder registers a handler, so a door would lead nowhere.
    id: TUG_ACTIONS.SELECT_NONE,
    title: "Deselect All",
    routing: "first-responder",
    internal: true,
  },
  {
    // ⇥ / ⇧⇥ belong to the provider's focus walk, which owns them before
    // any binding could; a chord here would never be reached.
    id: TUG_ACTIONS.FOCUS_NEXT,
    title: "Focus Next",
    routing: "first-responder",
    internal: true,
  },
  {
    id: TUG_ACTIONS.FOCUS_PREVIOUS,
    title: "Focus Previous",
    routing: "first-responder",
    internal: true,
  },
  {
    // There is no closed-tab history to reopen from.
    id: TUG_ACTIONS.REOPEN_TAB,
    title: "Reopen Closed Tab",
    routing: "first-responder",
    internal: true,
  },
  {
    // The session card handles it, but nothing dispatches it: no chord is
    // assigned to the ⌃⌘ band and no menu item names it.
    id: TUG_ACTIONS.INSERT_SLASH_COMMAND,
    title: "Insert Slash Command",
    routing: "key-card",
    internal: true,
  },

  // ---- Chord-only ----
  //
  // Working commands with no menu door yet. Their chords are what makes
  // them reachable, and what makes them visible to the keymap UI.
  {
    // One command, two doors: the app menu's item and ⌘,. Both dispatch
    // through the chain to the canvas's find-or-create-then-focus handler.
    id: TUG_ACTIONS.SHOW_SETTINGS,
    title: "Settings…",
    routing: "first-responder",
    menuItemId: "app.settings",
    bindings: [chord({ key: "Comma", meta: true, label: "," })],
  },
  {
    id: TUG_ACTIONS.CANCEL_DIALOG,
    title: "Cancel",
    routing: "first-responder",
    bindings: [
      chord({ key: "Period", meta: true, label: "." }),
      chord({ key: "Escape", label: "Escape" }),
    ],
  },
  {
    id: TUG_ACTIONS.SHOW_DEVTOOLS,
    title: "Show DevTools",
    routing: "first-responder",
    menuItemId: "maker.devTools",
    bindings: [
      chord(
        { key: "Slash", meta: true, alt: true, label: "/" },
        { preventDefault: true, menuEligible: true },
      ),
    ],
    mirrored: true,
    // The canvas handles it unconditionally, so the default chain walk
    // answers true and the item never dims — which is why it can keep its
    // chord attached without ever eating one.
    disabledChord: "keep",
  },
  {
    id: TUG_ACTIONS.OPEN_COMMAND_PICKER,
    title: "Open Command Picker",
    routing: "key-card",
    menuItemId: "session.commandPicker",
    bindings: [
      chord(
        { key: "Slash", meta: true, label: "/" },
        { preventDefault: true, menuEligible: true },
      ),
    ],
    mirrored: true,
    // No predicate: the key-card walk asks the frontmost card whether it has
    // a command picker, which is the whole question.
    disabledChord: "detach",
  },
  {
    // NOT promoted. ⌃⌘P selects the composer's Prompt route — the route
    // chips are its door, and the Changes route already has a Session-menu
    // item in the Show/Hide Changes toggle. A second item for the other
    // half would name a control's internal state as a menu command, and
    // promoting the chord would take it out of the JS funnel for a gesture
    // whose surface is two clicks away.
    //
    // ⌃⌘ is the Tug tier (chord-tiers.md): route selection is Tug's own
    // machinery, and ⇧ was carrying nothing here — there is no ⌘P base of
    // which Prompt Route is the counterpart.
    id: `${TUG_ACTIONS.SELECT_COMPOSER_ROUTE}:prompt`,
    title: "Prompt Route",
    routing: "key-card",
    action: TUG_ACTIONS.SELECT_COMPOSER_ROUTE,
    payload: "prompt",
    bindings: [
      chord(
        { key: "KeyP", ctrl: true, meta: true, label: "p" },
        { preventDefault: true },
      ),
    ],
  },
  {
    // A menu item with a DECORATIVE chord ([P11]). KBF mode is now a deck-wide
    // mode rather than one card's affordance, so it earns a place in the View
    // menu — but its chord stays out of AppKit's key-equivalent scan, which is
    // why the binding below still carries no `menuEligible`. A real key
    // equivalent is scanned above every surface that wants a modified Tab, the
    // Settings ▸ Keyboard chord capture among them, and ⌥⇥ has to keep
    // resolving in JS. The item renders the glyph as title text instead — the
    // same bargain Previous / Next Keyboard Focus take with ⇥.
    id: TUG_ACTIONS.CYCLE_FOCUS_MODE,
    title: "Cycle Focus Mode",
    // Registry-routed, not `key-card`, because the gesture has a deck-level
    // meaning when no card claims it — see the handler in `action-dispatch`,
    // which asks the key card first and falls back to the global toggle.
    // Plain `key-card` routing made ⌥⇥ a dead key on every surface whose card
    // registers no handler.
    routing: "registry",
    menuItemId: "view.keyboardFocus",
    bindings: [chord({ key: "Tab", alt: true, label: "Tab" }, { preventDefault: true })],
  },
  {
    // ⌃⌘[ / ⌃⌘] and ⌃⇧⌘[ / ⌃⇧⌘] — step the transcript's turns, and jump to
    // its ends.
    //
    // **The key class, derived** ([D184], tuglaws/chord-tiers.md § "Arrows are
    // geometry, brackets are series"): a bracket steps a series and an arrow
    // points at a place. A transcript is an ordered run of turns and nothing
    // about moving through it is spatial, so the family belongs on the bracket
    // row beside the lateral card ring (⇧⌘[/]), the stack ring (⌥⌘[/]) and the
    // slot nudge (⌥⇧⌘[/]) — `[` back and `]` forward in all four. It sat on
    // ⌥⌘↑/↓ and ⌥⇧⌘↑/↓ until directional card focus took the whole ⌥⌘ arrow
    // band, which is the band that moves the READER through the deck's
    // geometry; the arrow shape here was carrying a resemblance rather than a
    // meaning. ⌃⇧⌘ is the ⇧-extreme sharing its base's key, which satisfies R1
    // outright instead of leaning on R2's arrows exemption.
    //
    // **⌃⌘ and ⌃⇧⌘ brackets clear CodeMirror, and that is load-bearing.**
    // `defaultKeymap` binds `Mod-[` / `Mod-]` to `indentLess` / `indentMore`
    // and Tug installs it in both the composer and the text card, so plain
    // ⌘[/] would be destructive promoted and dead in the composer — the one
    // surface turn stepping is used from, since a reader steps back through
    // turns with the caret still in the prompt. These compositions are
    // untouched by it, so the chords keep the property the arrows had.
    //
    // The ⇧ pair RENDERS as ⌃⌘{ / ⌃⌘} because a shifted-pair key spends its ⇧
    // on the character, the rule Previous Card (⌘{) and Zoom In (⌘+) read by.
    id: TUG_ACTIONS.PREVIOUS_TURN,
    title: "Previous Turn",
    routing: "key-card",
    menuItemId: "session.previousTurn",
    bindings: [
      chord(
        { key: "BracketLeft", ctrl: true, meta: true, label: "[" },
        { preventDefault: true, menuEligible: true },
      ),
    ],
    mirrored: true,
    validate: transcriptNavigable,
    disabledChord: "detach",
  },
  {
    id: TUG_ACTIONS.NEXT_TURN,
    title: "Next Turn",
    routing: "key-card",
    menuItemId: "session.nextTurn",
    bindings: [
      chord(
        { key: "BracketRight", ctrl: true, meta: true, label: "]" },
        { preventDefault: true, menuEligible: true },
      ),
    ],
    mirrored: true,
    validate: transcriptNavigable,
    disabledChord: "detach",
  },
  {
    id: TUG_ACTIONS.FIRST_TURN,
    title: "First Turn",
    routing: "key-card",
    menuItemId: "session.firstTurn",
    bindings: [
      chord(
        {
          key: "BracketLeft",
          ctrl: true,
          shift: true,
          meta: true,
          label: "[",
        },
        { preventDefault: true, menuEligible: true },
      ),
    ],
    mirrored: true,
    validate: transcriptNavigable,
    disabledChord: "detach",
  },
  {
    id: TUG_ACTIONS.LAST_TURN,
    title: "Last Turn",
    routing: "key-card",
    menuItemId: "session.lastTurn",
    bindings: [
      chord(
        {
          key: "BracketRight",
          ctrl: true,
          shift: true,
          meta: true,
          label: "]",
        },
        { preventDefault: true, menuEligible: true },
      ),
    ],
    mirrored: true,
    validate: transcriptNavigable,
    disabledChord: "detach",
  },
];

/* ---------------------------------------------------------------------------
 * Locking policy (Spec S05)
 * ------------------------------------------------------------------------- */

/**
 * Commands the user may not rebind.
 *
 * This is **policy, not mechanism** ([P12]). Every entry in the table is
 * mechanically rebindable; these are the ones where doing so would break a
 * macOS convention the user relies on to get out of trouble — Quit, Hide,
 * the clipboard verbs. Changing the policy is an edit to this array and
 * nothing else, which is why lockedness is not a field on the entry.
 */
export const NATIVE_LOCKED: readonly string[] = [
  "hide-application",
  "hide-others",
  "show-all",
  "quit-application",
  "services",
  TUG_ACTIONS.CUT,
  TUG_ACTIONS.COPY,
  TUG_ACTIONS.PASTE,
  TUG_ACTIONS.DELETE,
  TUG_ACTIONS.SELECT_ALL,
  "minimize",
  "zoom-window",
  "toggle-full-screen",
];

const NATIVE_LOCKED_SET: ReadonlySet<string> = new Set(NATIVE_LOCKED);

/**
 * Whether a command's bindings are the user's to change. Read by the
 * keymap UI (which renders a locked row without a capture affordance) and
 * by the override store's validator (which rejects the write).
 */
export function isCommandLocked(id: string): boolean {
  return NATIVE_LOCKED_SET.has(id);
}

/* ---------------------------------------------------------------------------
 * Derived lookups
 * ------------------------------------------------------------------------- */

export const COMMANDS_BY_ID: ReadonlyMap<string, CommandEntry> = new Map(
  COMMANDS.map((entry) => [entry.id, entry]),
);

export const COMMANDS_BY_MENU_ITEM_ID: ReadonlyMap<string, CommandEntry> =
  new Map(
    COMMANDS.filter((entry) => entry.menuItemId !== undefined).map((entry) => [
      entry.menuItemId as string,
      entry,
    ]),
  );

/** The entry for a command id, or `undefined` if the id names no command. */
export function commandEntry(id: string): CommandEntry | undefined {
  return COMMANDS_BY_ID.get(id);
}

/** Whether an incoming wire name is a registry command rather than a data frame. */
export function isCommandId(id: string): boolean {
  return COMMANDS_BY_ID.has(id);
}

const TUG_ACTION_VALUES: ReadonlySet<string> = new Set(
  Object.values(TUG_ACTIONS),
);

/**
 * The wire name behind an entry, which for a parameterized id is the part
 * before the colon — `<action>:<value>` is the id form [P05] mints, so the
 * base is recoverable without a second field. This is the key the
 * `registry` routing target looks the entry's handler up by.
 */
export function commandWire(entry: CommandEntry): string {
  const colon = entry.id.indexOf(":");
  return colon === -1 ? entry.id : entry.id.slice(0, colon);
}

/**
 * The chain action an entry dispatches: its explicit `action`, or its `id`
 * when the id is itself a `TUG_ACTIONS` value. `null` for entries with no
 * chain action at all — `registry` bodies and `native` rows.
 */
export function commandAction(entry: CommandEntry): TugAction | null {
  if (entry.action !== undefined) return entry.action;
  if (TUG_ACTION_VALUES.has(entry.id)) return entry.id as TugAction;
  return null;
}

/* ---------------------------------------------------------------------------
 * Validity and state
 * ------------------------------------------------------------------------- */

/**
 * Whether a command is applicable right now ([P06]).
 *
 * An explicit `validate` predicate wins. Otherwise a chain-routed command is
 * validated by the chain — walked from the same node it would dispatch to,
 * so a key-card command answers from the key card rather than from wherever
 * focus happens to sit. A `registry` entry with no predicate has no
 * responder to ask and answers enabled; a `native` entry is AppKit's to
 * validate, never ours.
 *
 * This lives beside the table rather than beside the dispatcher because it
 * is the table's own answer: every surface that shows a command — the menu
 * mirror, buttons, context menus — asks this one function, which is what
 * keeps a button and its menu item from disagreeing.
 */
export function validateCommand(
  entry: CommandEntry,
  chain: CommandValidationSource,
): boolean {
  if (entry.validate !== undefined) return entry.validate(chain);

  const action = commandAction(entry);
  if (action === null) return true;

  switch (entry.routing) {
    case "key-card":
      return chain.validateActionInKeyCard(action);
    case "first-responder":
    case "target":
      return chain.validateAction(action);
    case "registry":
    case "native":
      return true;
  }
}

/**
 * A command's state projection — a checkmark, a radio selection, a toggle
 * ([P07]). `undefined` means the command does not participate in a check
 * column at all.
 */
export function queryCommandState(
  entry: CommandEntry,
  chain: CommandValidationSource,
): boolean | string | undefined {
  if (entry.state !== undefined) return entry.state(chain);

  const action = commandAction(entry);
  if (action === null) return undefined;

  switch (entry.routing) {
    case "key-card":
      return chain.queryActionStateInKeyCard(action);
    case "first-responder":
    case "target":
      return chain.queryActionState(action);
    case "registry":
    case "native":
      return undefined;
  }
}

/** Validity for a command named by id; unknown ids are not applicable. */
export function validateCommandId(
  id: string,
  chain: CommandValidationSource,
): boolean | undefined {
  const entry = COMMANDS_BY_ID.get(id);
  return entry === undefined ? undefined : validateCommand(entry, chain);
}

/* ---------------------------------------------------------------------------
 * Table lint
 * ------------------------------------------------------------------------- */

/**
 * Every invariant the table must hold, as a list of violations rather than
 * a throw, so a test can report all of them at once.
 *
 * The door-coverage rule is the load-bearing one: a command with neither a
 * menu item nor a chord is invocable by nobody, which is the state this
 * whole table exists to make visible. An entry that legitimately has no
 * door says so with `internal: true`.
 */
export function lintCommandTable(
  entries: readonly CommandEntry[] = COMMANDS,
): string[] {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  const seenMenuItemIds = new Map<string, string>();

  for (const entry of entries) {
    if (seenIds.has(entry.id)) {
      problems.push(`duplicate command id: ${entry.id}`);
    }
    seenIds.add(entry.id);

    if (entry.menuItemId !== undefined) {
      const owner = seenMenuItemIds.get(entry.menuItemId);
      if (owner !== undefined) {
        problems.push(
          `menu item ${entry.menuItemId} is claimed by both ${owner} and ${entry.id}`,
        );
      }
      seenMenuItemIds.set(entry.menuItemId, entry.id);
    }

    if (entry.routing !== "native" && commandAction(entry) === null) {
      if (entry.routing !== "registry") {
        problems.push(
          `${entry.id}: ${entry.routing} routing needs a chain action (its id is not a TUG_ACTIONS value, so it must name one)`,
        );
      }
    }

    const hasDoor =
      entry.menuItemId !== undefined ||
      (entry.bindings !== undefined && entry.bindings.length > 0) ||
      entry.paneChrome === true;
    if (!hasDoor && !entry.parameterized && !entry.internal) {
      problems.push(
        `${entry.id}: no menu item and no binding — no way to invoke it`,
      );
    }
  }

  return problems;
}

/**
 * Action names that are deliberately not commands.
 *
 * A `TUG_ACTIONS` value is either a user intent — which belongs in the
 * table — or it is currency: something a control says to its responder, or
 * a substrate says to its text field. The distinction is the whole point of
 * the table, so it is written down rather than left to be inferred from
 * absence, and `lintActionCoverage` holds every name to one side or the
 * other.
 */
export const ACTIONS_OUTSIDE_THE_TABLE: ReadonlySet<string> = new Set<string>([
  // Form-control currency: a control reporting its own value to whoever
  // owns it. Not invocable, not bindable, not nameable in a menu.
  TUG_ACTIONS.SET_VALUE,
  TUG_ACTIONS.TOGGLE,
  TUG_ACTIONS.SELECT_VALUE,
  TUG_ACTIONS.INCREMENT_VALUE,
  TUG_ACTIONS.DECREMENT_VALUE,
  TUG_ACTIONS.SET_COLOR,
  TUG_ACTIONS.ACTIVATE_COLOR_WELL,
  TUG_ACTIONS.SET_PROPERTY,
  TUG_ACTIONS.SELECT_TAB,
  TUG_ACTIONS.CLOSE_TAB,
  TUG_ACTIONS.ADD_TAB,
  TUG_ACTIONS.TOGGLE_SECTION,
  TUG_ACTIONS.SUBMIT,
  TUG_ACTIONS.REMOVE_ATTACHMENT,
  TUG_ACTIONS.REQUEST_TRASH_SESSION,
  TUG_ACTIONS.CONFIRM_DIALOG,
  TUG_ACTIONS.DISMISS_POPOVER,
  TUG_ACTIONS.SHOW_SLASH_COMMAND_NOTICE,
  TUG_ACTIONS.SCROLL_DOCUMENT,

  // Substrate text-editing currency. Movement and deletion only ever
  // target the focused text field, so the chain abstraction — and a
  // rebindable command — would add nothing.
  TUG_ACTIONS.DELETE_TO_LINE_START,
  TUG_ACTIONS.DELETE_WORD_BACKWARD,
  TUG_ACTIONS.MOVE_WORD_FORWARD,
  TUG_ACTIONS.MOVE_WORD_BACKWARD,

  // Context-menu verbs over a sampled target. Each one means "the thing
  // the right-click landed on", which a chord or a menu-bar item has no
  // way to name.
  TUG_ACTIONS.COPY_COMMAND,
  TUG_ACTIONS.COPY_COMMAND_AS_PLAIN_TEXT,
  TUG_ACTIONS.COPY_ANNOTATION_VALUE,
  TUG_ACTIONS.COPY_ANNOTATION_ATOM,
  TUG_ACTIONS.COPY_COPYABLE,
  TUG_ACTIONS.COPY_SESSION_ATOM,
  TUG_ACTIONS.COPY_SESSION_CITATION,
  TUG_ACTIONS.COPY_SESSION_ID,
  TUG_ACTIONS.COPY_SESSION_DESCRIPTION,
  TUG_ACTIONS.COPY_SESSION_ACTIVITY,
  TUG_ACTIONS.SHOW_SESSION,
  TUG_ACTIONS.RESUME_SESSION,
  TUG_ACTIONS.TOGGLE_COMMIT_DETAIL,
  TUG_ACTIONS.COPY_COMMIT_HASH,
  TUG_ACTIONS.COPY_COMMIT_SHORT_HASH,
  TUG_ACTIONS.COPY_COMMIT_HEADER,
  TUG_ACTIONS.COPY_COMMIT_RECORD,
  // The arc row's rare verbs. Each means "the arc this row is", which no
  // chord and no menu-bar item can name — and the discard is a "request",
  // arming the lane's confirm rather than performing anything.
  TUG_ACTIONS.BIND_ARC,
  TUG_ACTIONS.UNBIND_ARC,
  TUG_ACTIONS.REQUEST_DISCARD_ARC,
  TUG_ACTIONS.REQUEST_REPLAY_ARC,
  // Sent card-to-card by a surface showing that card's arc, never typed:
  // the reader already has ⌃⌘C for their own card's shade, and a chord that
  // meant "reveal somebody else's" would have no way to name whose.
  TUG_ACTIONS.REVEAL_CHANGES,
  TUG_ACTIONS.INSERT_INTO_PROMPT,
  TUG_ACTIONS.REVEAL_IN_FINDER,
  TUG_ACTIONS.OPEN_IMAGE_PREVIEW,
  // The selection the right-click landed on, handed to the system
  // dictionary. It carries the sampled text AND the point its panel
  // anchors to, neither of which a chord or a menu-bar item could supply.
  TUG_ACTIONS.LOOK_UP_IN_DICTIONARY,
  TUG_ACTIONS.DUPLICATE,
]);

/**
 * Every action name is either a command wire or explicitly outside the
 * table. A name in neither set is the state this plan exists to end: a
 * verb nobody can find, in a vocabulary that claims to be canonical.
 */
export function lintActionCoverage(
  entries: readonly CommandEntry[] = COMMANDS,
): string[] {
  const wires = new Set(entries.map(commandWire));
  return Object.values(TUG_ACTIONS)
    .filter(
      (action) => !wires.has(action) && !ACTIONS_OUTSIDE_THE_TABLE.has(action),
    )
    .map(
      (action) =>
        `${action} is neither a command nor declared outside the table`,
    );
}

/**
 * The locked policy names commands, so a renamed or deleted entry must not
 * leave a lock pointing at nothing — a lock nobody enforces reads as
 * "rebindable" to every consumer.
 */
export function lintNativeLocked(
  entries: readonly CommandEntry[] = COMMANDS,
): string[] {
  const ids = new Set(entries.map((entry) => entry.id));
  return NATIVE_LOCKED.filter((id) => !ids.has(id)).map(
    (id) => `NATIVE_LOCKED names ${id}, which is not a command`,
  );
}

if (import.meta.env?.DEV) {
  const problems = [
    ...lintCommandTable(),
    ...lintNativeLocked(),
    ...lintActionCoverage(),
  ];
  if (problems.length > 0) {
    throw new Error(`command-registry: ${problems.join("; ")}`);
  }
}
