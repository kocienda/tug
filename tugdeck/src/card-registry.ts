/**
 * Card Registry Module
 *
 * Single-call card registration API for the deck card system.
 *
 * **Authoritative reference:** design-system-concepts.md [D04] Single-call card
 * registration, CardRegistration interface, Registry API.
 *
 * ## Usage
 *
 * ```typescript
 * import { registerCard, getRegistration, getAllRegistrations } from "./card-registry";
 *
 * registerCard({
 *   componentId: "hello",
 *   contentFactory: () => <HelloCardContent />,
 *   defaultMeta: { title: "Hello", closable: true },
 * });
 * ```
 *
 * @module card-registry
 */

import type React from "react";
import type { FeedIdValue } from "./protocol";
import type { CardState } from "./layout-tree";
import type { FeedStoreFilter } from "./lib/feed-store";

/**
 * Fallback filter used by `CardHost` while a card is still unbound — i.e.,
 * before the `spawn_session_ok` CONTROL ack has populated
 * `cardSessionBindingStore` with the card's canonical `workspace_key`.
 * Requires only that the field is present; does not match against any
 * specific value. Once `useCardWorkspaceKey(cardId)` returns a bound key,
 * the host switches to an exact value-check predicate.
 *
 * Consumers: `CardHost` (via `useCardWorkspaceKey` in card-host.tsx) and
 * `GalleryPromptInput` (see gallery-prompt-input.tsx). Accepts any
 * present `workspace_key` until the card is fully bound.
 */
export const presentWorkspaceKey: FeedStoreFilter = (_feedId, decoded) =>
  typeof decoded === "object" && decoded !== null && "workspace_key" in decoded;

/**
 * Size policy for a card type. Governs default sizing of new cards and
 * resize clamping in TugPane.
 *
 * - `min`: hard floor for resize (content can report a larger min, but not smaller).
 * - `max`: hard ceiling for resize (omit for unbounded).
 * - `preferred`: size for new cards with no saved state.
 */
export interface CardSizePolicy {
  min: { width: number; height: number };
  max?: { width: number; height: number };
  preferred: { width: number; height: number };
}

/**
 * Default size policy applied when a card registration omits `sizePolicy`.
 */
export const DEFAULT_SIZE_POLICY: CardSizePolicy = {
  min: { width: 250, height: 180 },
  preferred: { width: 400, height: 300 },
};

/**
 * How the layout system treats a card type: an arranged content card, or a
 * card that pins to a deck edge and insets the band the content cards live in.
 * See {@link CardRegistration.layoutRole}.
 */
export type LayoutRole = "content" | "sidebar";

/** The role a registration gets when it declares none. */
export const DEFAULT_LAYOUT_ROLE: LayoutRole = "content";

/**
 * Metadata describing a card's default appearance and behavior.
 *
 * **Authoritative reference:** CardMeta.
 */
export interface CardMeta {
  title: string;
  icon?: string;
  closable?: boolean;
  /**
   * Whether closing the pane requires user confirmation through the
   * close-confirm popover. Drives single-card panes only — a multi-card
   * pane always confirms regardless of any per-card value (the host
   * resolves the rule as `cards.length > 1 || activeMeta.confirmClose`).
   *
   * Defaults to `false`: a single-card pane's X-button click and Cmd-W
   * close the pane immediately. Card types whose contents are not
   * trivially recoverable (transcripts, drafts, etc.) opt in by setting
   * this to `true` and pay the two-step close as a guard.
   */
  confirmClose?: boolean;
}

/**
 * A single entry in the card registry.
 *
 * **Authoritative reference:** CardRegistration interface.
 *
 * DeckCanvas renders `CardHost` for every card (single-tab and
 * multi-tab alike) and uses `contentFactory` to get card-specific content.
 */
export interface CardRegistration {
  /** Unique identifier for this card type. e.g. "hello", "terminal", "git". */
  componentId: string;
  /**
   * Returns the content component (e.g. `<HelloCardContent />`) without
   * the pane chrome. DeckCanvas uses this
   * to get card-specific content.
   */
  contentFactory: (cardId: string) => React.ReactNode;
  /** Default title, icon, and closable for this card type. */
  defaultMeta: CardMeta;
  /**
   * The feeds this card's content reads through the host-managed, per-card
   * (workspace-key-filtered) FeedStore, surfaced via `useCardData`. The host
   * also gates the card behind "Loading…" until at least one of these feeds
   * delivers a frame. Omit or pass `[]` when the card manages its own data
   * (e.g. reads an app-level singleton store): the card then renders
   * immediately with no per-card feed subscription. Defaults to `[]`.
   */
  cardFeedIds?: readonly FeedIdValue[];
  /** Card type family (e.g. "standard", "maker"). Defaults to "standard". */
  family?: string;
  /** Families this card can host in its type picker. Defaults to `["standard"]`. */
  acceptsFamilies?: readonly string[];
  /**
   * Default cards to seed a new stack with when `addCard` is called against
   * this registration. Each entry is a template: `componentId`, `title`, and
   * `closable` are copied, but a fresh UUID is assigned as the card `id`.
   * When omitted, a single card is created from `defaultMeta`.
   */
  defaultCards?: readonly CardState[];
  /** Default card-level title (e.g. "Component Gallery"). Defaults to `""`. */
  defaultTitle?: string;
  /** Size policy for this card type. Falls back to DEFAULT_SIZE_POLICY when omitted. */
  sizePolicy?: CardSizePolicy;
  /**
   * The policy this card type takes while its pane is FOLDED ([P04]).
   *
   * A folded card is a different card for sizing purposes: its floor is
   * what the open form needed only because the open form has a transcript and
   * a composer in it, and a wall of folded cards cannot pack at all while
   * every member still claims that floor. So the folded form declares its
   * own policy rather than having the open one relaxed — the open card's floor
   * is still the truth about the open card.
   *
   * Declared with `min.height === max.height`, which is how a registration
   * already says "exactly one correct size" and what `TugPane` reads as
   * `heightPinned`. The width is left unbounded: a folded card is as wide
   * as the slot it stands in.
   *
   * Omitted by every card type that has no folded form, in which case
   * `getStackSizePolicy({ folded: true })` falls back to that card's
   * ordinary policy — the aggregate over a mixed stack is then the honest
   * answer rather than a tier the other card cannot live at.
   */
  foldedSizePolicy?: CardSizePolicy;
  /**
   * The policy this card type takes while the card is nothing but the sheet it
   * exists to raise ([P02], [B04]).
   *
   * `foldedSizePolicy`'s model, one condition further on, and the same shape:
   * a form this card type has, declared as a whole policy rather than as a
   * number the deck has to know what to do with. A card type whose OPEN form
   * has a tall floor because of surfaces that are not on screen yet — the
   * Session card's transcript and composer behind its 600px floor — may say
   * here what it is worth while it is only its sheet.
   *
   * **How it differs from the folded policy is the whole of [B01]:** this one
   * declares a `min.height` and NO `max.height`. A folded card is a band and
   * says so with `min.height === max.height`; an unbound card is a member that
   * knows what it needs and takes more when its column has more to give. A
   * `max.height` declared here would be the dead band the one-rule change
   * removed, so do not declare one.
   *
   * Read through {@link getStackSizePolicy}'s `unbound` form selector, and
   * directly by `addCard` off the registration it already has in hand — the
   * deck names no componentId and imports nothing from `cards/`. What `addCard`
   * writes from it is read by `placeMembers` as one contributor to the member's
   * FLOOR, and the member keeps its weight.
   *
   * Omitted by every card type with no such condition, which is every type but
   * the Session card today, in which case {@link getUnboundSizePolicy} falls
   * back to that card's ordinary policy exactly as the folded accessor does.
   */
  unboundSizePolicy?: CardSizePolicy;
  /**
   * Where a fresh pane for this card type opens on the canvas.
   * `"cascade"` (the default) walks the standard cascade origin;
   * `"center"` centers the pane in the live canvas — for app-level
   * dialog-like cards (e.g. the About box).
   */
  placement?: "cascade" | "center";
  /**
   * Category this card belongs to in the type picker menu of a multi-tab
   * host. Registrations sharing a `category.label` are grouped together in
   * the [+] popup, ordered by first-encountered appearance in the registry.
   * Unsectioned registrations fall through as top-level items.
   *
   * This field is how type-picker grouping is declared — TugTabBar never
   * hardcodes category IDs.
   */
  category?: { label: string; icon?: string };
  /**
   * Which group this card's pane rows file under in the Cards card.
   * `"none"` keeps the card out of that list entirely.
   *
   * Read only by `resolveCardsGroup` (in
   * `components/cards/cards-groups.ts`), which falls back to the
   * `category` label and then to `"tools"` — so omitting this is a valid
   * declaration, not an oversight. A unit test walks every registration and
   * pins the resolved group, so a new card type cannot be born without a
   * home in the list.
   */
  cardsGroup?: "sessions" | "files" | "tools" | "none";
  /**
   * Hide this registration from the type-picker [+] menu while keeping it
   * fully registered (seedable by `componentId`, resolvable by
   * `getRegistration`). For cards that exist only as app-test fixtures or
   * narrow internal demos — they clutter the human-facing gallery menu but
   * must stay in the registry so tests can seed them. The menu builder in
   * `tug-tab-bar` filters these out; everything else treats them normally.
   * @default false
   */
  hidden?: boolean;
  /**
   * Engine classification for the activation pipeline.
   *
   * When set to `"em"` (engine-managed), the card's content factory
   * owns its own focus + selection lifecycle through `useCardStatePreservation`'s
   * `onCardActivated` callback. `resolveActivationTarget` (in
   * `focus-transfer.ts`) returns `dispatch-activated` for these cards
   * regardless of whether `bag.content` is populated yet — fresh
   * never-saved EM cards still activate via the factory dispatch path
   * rather than falling through to the generic `default-focus` walk
   * that would land focus on the first focusable descendant (often a
   * toolbar button before the contenteditable).
   *
   * Omit (or leave undefined) for DOM-authority "FC" cards — generic
   * forms, gallery components without an embedded engine, etc. Those
   * route through `bag.focus` snapshots and the
   * {@link DEFAULT_FOCUS_SELECTORS} fallback chain.
   */
  engineKind?: "em";
  /**
   * How the layout system treats this card type.
   *
   * `"content"` (the default) is a card the deck arranges: it takes an N-Up
   * slot, answers ⌘1..⌘N, and follows the content width presets.
   *
   * `"sidebar"` is a card that pins to a deck edge and insets the imposition
   * band instead of living inside it — the rail and Jots. Sidebar cards take no
   * slot, are refused by `assignCardToSlot`, and carry a `{ side, pinned }`
   * entry in the deck's imposition record rather than a position in the N-Up.
   *
   * The taxonomy constrains the layout system; it does not sort every card into
   * two boxes. Utility cards — settings, keyboard, devtools, gallery, about —
   * are ordinary content cards and declare nothing.
   */
  layoutRole?: LayoutRole;
  /**
   * True when this card opens at the deck's content-width default rather than
   * at a width of its own: the reading cards — Session, Text, File, Diff,
   * DevTools — and the full-surface configurators, Settings and Keyboard
   * Shortcuts, whose `preferred.width` only ever meant "the width content cards
   * share". A new pane for one of them resolves its width from
   * `imposition.contentWidth` and is stamped with that preset, so the first card
   * of a session opens at the width the deck is set to rather than at a number
   * frozen into a registration.
   *
   * The registered `preferred.width` stays as the fallback for any path with no
   * deck to ask (and `min`/`max` still bound the resolved width, which is what
   * keeps About's 320 lock true).
   *
   * Cards with a width of their own — About's fixed card, the gallery demos —
   * declare nothing and keep it.
   */
  takesContentWidth?: boolean;
  /**
   * Whether this card type auto-engages **KBF mode** (keyboard-focus mode)
   * while it is the key card — Class B of the mode derivation ([P10]).
   *
   * `true` for the cards whose whole content is engine focus stops the
   * keyboard walks: the rail, Jots, Settings and its bodies, Keyboard, About,
   * Overview, Activity, DevTools. Their rings and arrow movement are the interface,
   * so the mode is on the moment the card is key and no ⌥⇥ is needed.
   *
   * Omit (the default) for a card whose resting state is a caret in a text
   * surface — Session, Text, File view, Hello — and for a card that registers
   * no focus stops at all: engaging a surface with nothing to ring is a mode
   * pointing at no ring.
   */
  kbfAtRest?: boolean;
  /**
   * How greedy this card is for space when an allocator shares some out:
   * **lower is greedier** — fed first when there is surplus, drained last when
   * there is a deficit.
   *
   * One rank, read on both axes. Across the deck it orders the rails competing
   * for WIDTH; down a place it orders the members competing for the RUN — who
   * takes fit's slack whole when the run is long ([B06]). It decides nothing
   * while a member is still short of its own natural: that run is divided
   * evenly ([B03]).
   *
   * The six sidebar cards are ranked as a single order rather than left tied,
   * because a tie leaves the slack rule with nobody to give to: Overview 1 (the
   * only stream), then the lists by how fast their content grows — Jots 2,
   * Cards 3, Arcs 4, Tripwires 5 — and fixed-content Layout 6. Anything else
   * takes {@link DEFAULT_GREED_RANK}. A rail carrying several cards is as
   * greedy as its greediest member (`deck-manager.ts` folds the members with
   * `Math.min`), so a prose reader stacked with a modest card keeps the prose
   * reader's standing.
   *
   * Read only through {@link getGreedRank}, by the folds that build the
   * allocators' inputs. The allocators themselves see numbers and know nothing
   * about cards.
   */
  greedRank?: number;
  /**
   * The narrowest width this card's rail is COMFORTABLE at, as distinct from
   * `sizePolicy.min.width`, which is the narrowest it can be painted at all.
   *
   * The two floors answer different questions. The hard floor is a fact about
   * rendering — below it the card's contents clip — and it is what the user's
   * own resize drag clamps to (`tug-pane.tsx`). The comfort floor is a
   * preference about quality — for the Overview, the narrowest measure a post
   * still reads as prose. The space allocator respects the comfort floor
   * unless surrendering it removes overlap from the deck's chain entirely:
   * showing the user's cards un-occluded outranks a rail's comfortable
   * measure, but not the rail's ability to paint.
   *
   * Omit when a card has no comfort band — {@link getComfortWidth} then
   * answers with its hard floor, which makes the two-tier drain a no-op for
   * that rail. A rail carrying several cards takes the LARGEST comfort width
   * among its members (`deck-manager.ts` folds with `Math.max`), exactly as it
   * takes the largest hard floor.
   *
   * Read only through {@link getComfortWidth}, by the rail fold that builds
   * the allocator's input.
   */
  comfortWidth?: number;
}

/**
 * The greed rank a card gets when its registration declares none — hungrier
 * than nothing, greedier than nothing else either. Every sidebar card that
 * cares declares a rank below this, so the default is simply "last fed, first
 * drained", which is the right standing for a rail nobody has reasoned about.
 */
export const DEFAULT_GREED_RANK = 9;

/** Module-level registry map. Keyed by componentId. */
const registry = new Map<string, CardRegistration>();

/**
 * Register a card type.
 *
 * Calling with a duplicate `componentId` logs a warning and overwrites the
 * existing registration.
 *
 * **Authoritative reference:** Registry API.
 */
export function registerCard(registration: CardRegistration): void {
  if (registry.has(registration.componentId)) {
    console.warn(
      `[card-registry] Duplicate registration for componentId "${registration.componentId}". Overwriting.`,
    );
  }
  registry.set(registration.componentId, registration);
}

/**
 * Retrieve a registered card by componentId.
 *
 * Returns `undefined` if no card is registered under that id.
 *
 * **Authoritative reference:** Registry API.
 */
export function getRegistration(componentId: string): CardRegistration | undefined {
  return registry.get(componentId);
}

/**
 * Return all registered cards.
 *
 * **Authoritative reference:** Registry API.
 */
export function getAllRegistrations(): Map<string, CardRegistration> {
  return registry;
}

/**
 * Return the size policy for a registered card type.
 *
 * Returns the registration's `sizePolicy` if set, otherwise `DEFAULT_SIZE_POLICY`.
 * Returns `DEFAULT_SIZE_POLICY` when the componentId is not registered.
 */
export function getSizePolicy(componentId: string): CardSizePolicy {
  return registry.get(componentId)?.sizePolicy ?? DEFAULT_SIZE_POLICY;
}

/**
 * The size policy for a registered card type in its FOLDED form ([P04]).
 *
 * Falls back to {@link getSizePolicy} — the card's ordinary policy — for a
 * card type that declares no folded form, which is every type but the
 * Session card today. The fallback is what keeps a mixed stack honest: a pane
 * hosting a Session tab and a Text tab is one box, and the box still has to
 * fit the Text card.
 */
export function getFoldedSizePolicy(componentId: string): CardSizePolicy {
  const registration = registry.get(componentId);
  return (
    registration?.foldedSizePolicy ??
    registration?.sizePolicy ??
    DEFAULT_SIZE_POLICY
  );
}

/**
 * The size policy for a registered card type in its UNBOUND form ([P02],
 * [B04]).
 *
 * {@link getFoldedSizePolicy}'s twin, with the same fallback and for the same
 * reason: a card type that declares no unbound form reads as its ordinary
 * self, and a pane hosting an unbound Session tab beside a Text tab is still
 * one box that has to fit the Text card.
 */
export function getUnboundSizePolicy(componentId: string): CardSizePolicy {
  const registration = registry.get(componentId);
  return (
    registration?.unboundSizePolicy ??
    registration?.sizePolicy ??
    DEFAULT_SIZE_POLICY
  );
}

/**
 * Aggregate size policy for a TugPane hosting a stack of cards.
 *
 * A pane is one box shared by all its tabs, so it must satisfy every
 * hosted card kind at once. `getSizePolicy` answers for a single
 * card type; a pane that consults only its active tab would let a
 * narrow tab's policy float the resize floor below what a wider tab
 * needs, clipping that tab's content on the next tab switch. This
 * helper resolves the whole stack:
 *
 *  - `min` — element-wise MAX of the cards' mins. The pane fits the
 *    widest / tallest minimum, so no hosted card ever clips.
 *  - `max` — element-wise MIN of the cards' *defined* maxes. An
 *    unbounded card imposes no ceiling; when every card is unbounded
 *    the result omits `max`.
 *  - `preferred` — the first card's, floored to the aggregated `min`
 *    so the result stays a well-formed policy (`preferred >= min`).
 *    TugPane does not read `preferred` — only `addCard` does, and it
 *    sizes one card at a time, never a stack — so the carried value
 *    is immaterial to pane sizing.
 *
 * Each id resolves through `getSizePolicy`, so unknown ids contribute
 * `DEFAULT_SIZE_POLICY`. An empty list returns `DEFAULT_SIZE_POLICY`.
 *
 * `options.folded` resolves each id through {@link getFoldedSizePolicy}
 * instead ([P04]). Everything else is unchanged, including the aggregation —
 * a pane is still one box, and a folded Session card sharing a pane with a
 * Text tab still has to fit the Text tab.
 *
 * `options.unbound` does the same through {@link getUnboundSizePolicy}
 * ([P02]). The two are forms of one card rather than independent flags, so
 * `folded` wins when both are named — a folded card is not showing the sheet
 * its unbound form was declared for, which is the same precedence
 * `placeMembers`' branch order takes.
 */
export function getStackSizePolicy(
  componentIds: readonly string[],
  options: { folded?: boolean; unbound?: boolean } = {},
): CardSizePolicy {
  if (componentIds.length === 0) return DEFAULT_SIZE_POLICY;
  const forForm =
    options.folded === true
      ? getFoldedSizePolicy
      : options.unbound === true
        ? getUnboundSizePolicy
        : getSizePolicy;
  const policies = componentIds.map(forForm);

  let minWidth = 0;
  let minHeight = 0;
  let maxWidth = Infinity;
  let maxHeight = Infinity;
  for (const policy of policies) {
    minWidth = Math.max(minWidth, policy.min.width);
    minHeight = Math.max(minHeight, policy.min.height);
    if (policy.max !== undefined) {
      maxWidth = Math.min(maxWidth, policy.max.width);
      maxHeight = Math.min(maxHeight, policy.max.height);
    }
  }

  const aggregated: CardSizePolicy = {
    min: { width: minWidth, height: minHeight },
    preferred: {
      width: Math.max(policies[0].preferred.width, minWidth),
      height: Math.max(policies[0].preferred.height, minHeight),
    },
  };
  // PER-AXIS, not both-or-nothing. `CardSizePolicy.max` requires both numbers,
  // so a policy bounded on ONE axis declares the other `Infinity` — and the
  // both-finite gate this replaced would then drop the whole `max`, taking the
  // bounded axis down with the unbounded one. That is exactly the folded
  // policy's shape ([P04]: pinned height, unbounded width), and under the old
  // gate `heightPinned` would silently never fire.
  //
  // `Infinity` on the surviving axis is safe at every reader: each one passes
  // `max.width` / `max.height` into a clamp (`resolveContentWidthPx` at three
  // sites in `deck-manager.ts`, the resize clamp's `maxSizeRef`, the bullseye
  // width), where an infinite bound is a no-op. And `max.width === min.width`
  // stays false for an infinite width, so nothing reads it as a pin.
  if (Number.isFinite(maxWidth) || Number.isFinite(maxHeight)) {
    aggregated.max = { width: maxWidth, height: maxHeight };
  }
  return aggregated;
}

/**
 * True when the card type is registered and declares
 * `engineKind: "em"` — i.e., its content factory owns its own focus
 * via `useCardStatePreservation`'s `onCardActivated` callback. Used by
 * `resolveActivationTarget` to route fresh (never-saved) EM cards
 * through the dispatch path instead of the generic default-focus
 * walk. Returns `false` for unregistered componentIds and for
 * DOM-authority cards.
 */
export function isEngineManagedCard(componentId: string): boolean {
  return registry.get(componentId)?.engineKind === "em";
}

/**
 * The resolved layout role for a card type: what the registration declares, or
 * `"content"` when it declares nothing. An unregistered componentId resolves to
 * `"content"` as well — the layout system's default treatment, not a special
 * case, so a card seeded before its registration lands is arranged rather than
 * silently pinned to an edge.
 */
export function getLayoutRole(componentId: string): LayoutRole {
  return registry.get(componentId)?.layoutRole ?? DEFAULT_LAYOUT_ROLE;
}

/** True when the card type pins to a deck edge instead of taking a slot. */
export function isSidebarCard(componentId: string): boolean {
  return getLayoutRole(componentId) === "sidebar";
}

/**
 * How greedy a card type is for space, on either axis: what the registration
 * declares, or {@link DEFAULT_GREED_RANK}. See {@link CardRegistration.greedRank}
 * — lower is greedier. An unregistered componentId takes the default too, so a
 * card seeded before its registration lands is simply the least greedy thing
 * in its place rather than a hole in the fold.
 */
export function getGreedRank(componentId: string): number {
  return registry.get(componentId)?.greedRank ?? DEFAULT_GREED_RANK;
}

/**
 * The narrowest width a card type's rail is comfortable at: what the
 * registration declares, or its hard floor when it declares nothing. See
 * {@link CardRegistration.comfortWidth} for what the two floors mean.
 *
 * Falling back to the hard floor rather than to a constant is what makes the
 * comfort band opt-in: a card with no declared comfort width has
 * `comfortWidth === minWidth`, so the allocator's comfort tier is empty for
 * its rail and its behavior is unchanged. An unregistered componentId answers
 * from `DEFAULT_SIZE_POLICY` for the same reason `getSizePolicy` does.
 */
export function getComfortWidth(componentId: string): number {
  return registry.get(componentId)?.comfortWidth ?? getSizePolicy(componentId).min.width;
}

/**
 * True when a new card of this type opens at the deck's content-width default.
 * See {@link CardRegistration.takesContentWidth}. Unregistered ids are `false`
 * — an unknown card keeps whatever width the caller sizes it to.
 */
export function takesContentWidth(componentId: string): boolean {
  return registry.get(componentId)?.takesContentWidth === true;
}

/**
 * Clear the registry.
 *
 * **For test use only.** Provides isolation between test cases.
 */
export function _resetForTest(): void {
  registry.clear();
}
