/**
 * Serialization, deserialization, and default layout for DeckState.
 *
 * **Current wire format:** `version: 4` with on-disk keys
 * `{ version: 4, cards, panes, activePaneId?, imposition }`, with `panes[]`
 * carrying the additive-optional `slot?` and `imposition` carrying
 * `{ kind?, sidebars, … }`. `imposition` was a bare kind string in earlier v4 blobs
 * and both shapes parse — the widening is additive, so no version bump.
 * `focusedCardId` is persisted separately via `putFocusedCardId` and is not
 * part of the layout blob.
 *
 * **Pre-v4 on-disk shape (migrated on load):** `version: 3` used `windows` and
 * `activeWindowId` instead of `panes` / `activePaneId`. Those blobs are normalized
 * by {@link migrateV3ToV4} before the same parsing and clamping as v4.
 *
 * **Load path:**
 * - `version === 4` — parsed by {@link parseV4}.
 * - `version === 3` — {@link migrateV3ToV4} (field rename only) then {@link parseV4}.
 * - `version === 2` — legacy two-table blob (`stacks`, `activeStackId`); {@link migrateV2ToV4}
 *   bridges to pre-v4 v3 wire names, then {@link migrateV3ToV4} → {@link parseV4}.
 * - Missing `version` or other legacy shapes — if `cards` is an array, the
 *   historical single-table blob (`version: 5`, `cards[].tabs[]`, etc.) is
 *   migrated by {@link migrateV1ToDeckState}. Unrelated shapes (e.g. stray
 *   `version: 4` objects without valid `cards`/`panes`) fall through to
 *   {@link buildDefaultLayout}.
 *
 * Legacy card ids become pane ids; legacy tab ids become card ids — identity
 * is preserved so per-card state in tugbank remains keyed by the same id strings.
 */

import {
  type DeckState,
  type CardState,
  type TugPaneState,
} from "./layout-tree";
import {
  clampSlot,
  isImpositionKind,
  isImpositionLayout,
  isColumnMode,
  isSidebarSide,
  DEFAULT_IMPOSITION_KIND,
  DEFAULT_CONTENT_WIDTH,
  DEFAULT_SIDEBAR_SIDE,
  isContentWidth,
  sweptColumnOrders,
  type DeckImposition,
  type ImpositionKind,
  type ColumnArrangement,
  type RailArrangement,
  type SidebarEntry,
} from "@/lib/layout-imposer";
import { CARDS_CARD_ID } from "@/lib/cards-card-id";

// ---- Constants ----

/** Floor for a restored pane's width and height. */
const MIN_PANE_SIZE = 100;

/**
 * Breathing room left between a pane and the canvas edges when the pane has
 * to be sized/positioned to fit. Keeps a fitted pane from sitting flush
 * against the edge, which reads as a glitch rather than a deliberate fit.
 */
const FIT_MARGIN = 8;

// ---- Card-family back-compat ----

/**
 * Parse a persisted `acceptsFamilies` array, mapping the legacy `"developer"`
 * family value onto `"maker"` so decks saved before the family rename still
 * surface maker cards. Absent or non-array input falls back to `["standard"]`.
 */
function parseAcceptsFamilies(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return ["standard"];
  return (raw as string[]).map((f) => (f === "developer" ? "maker" : f));
}

/**
 * Map a persisted card `componentId` through the kind-rename history so a deck
 * saved before a registry-kind rename still resolves to a registered card.
 * An id no longer registered is dropped by `filterDeckStateByRegistration`,
 * taking any pane it was alone in with it — so a rename without an entry here
 * silently deletes the card from a layout somebody arranged.
 *
 * The Session card shipped as componentId `"dev"`, and is rewritten to the
 * kind that is registered now.
 *
 * This table only grows. Unlike a data migration it has no end condition: a
 * layout blob written years ago is still a valid layout blob, and the entry
 * that resolves it is what keeps it one.
 */
const RENAMED_COMPONENT_IDS: Readonly<Record<string, string>> = {
  dev: "session",
};

function migrateComponentId(componentId: string): string {
  return RENAMED_COMPONENT_IDS[componentId] ?? componentId;
}

// ---- Geometry fitting ----

/**
 * Fit a restored pane's geometry to the live canvas.
 *
 * Floors each dimension at {@link MIN_PANE_SIZE}, then — when the canvas size
 * is known (both dimensions positive) — caps width/height to the canvas (less
 * a {@link FIT_MARGIN} gap on each side) and pulls the position in so no edge
 * overhangs. This brings a pane that was saved on a larger display fully
 * on-screen when the layout is restored on a smaller one, so neither the pane
 * body nor its bottom prompt falls outside the visible canvas, and a fitted
 * pane keeps a small margin from the edges rather than sitting flush.
 *
 * The card-id harvest path (`main.tsx`) passes a 0×0 canvas because it
 * discards geometry; in that case coordinates are returned floored but
 * unclamped.
 */
function fitPaneGeometry(
  pos: { x: number; y: number },
  sz: { width: number; height: number },
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number; width: number; height: number } {
  let width = Math.max(MIN_PANE_SIZE, sz.width);
  let height = Math.max(MIN_PANE_SIZE, sz.height);
  let x = pos.x;
  let y = pos.y;
  if (canvasWidth > 0 && canvasHeight > 0) {
    width = Math.min(width, Math.max(MIN_PANE_SIZE, canvasWidth - 2 * FIT_MARGIN));
    height = Math.min(height, Math.max(MIN_PANE_SIZE, canvasHeight - 2 * FIT_MARGIN));
    x = Math.max(FIT_MARGIN, Math.min(x, canvasWidth - FIT_MARGIN - width));
    y = Math.max(FIT_MARGIN, Math.min(y, canvasHeight - FIT_MARGIN - height));
  }
  return { x, y, width, height };
}

// ---- Serialize ----

/**
 * Serialize a DeckState to the v4 wire format for settings API persistence.
 *
 * Returns a plain object. Caller should JSON.stringify before writing.
 *
 * `focusedCardId` is intentionally NOT included in the layout blob. It is
 * persisted separately via `putFocusedCardId` (single source of truth) and
 * read back on mount through `initialFocusedCardId`. Keeping two paths for
 * one field invites divergence.
 *
 * `bullseyePaneId` is likewise absent, and must stay absent. Bullseye is a
 * temporary reading posture; persisting it would strand a user who quit or
 * crashed while bullseyed in a posture they never asked to keep. The fields
 * below are listed one by one rather than spread for exactly this reason —
 * omission is the default here, and a refactor to a spread would quietly undo
 * it. A unit test pins the key set.
 */
export function serialize(deckState: DeckState): object {
  return {
    version: 4,
    cards: deckState.cards,
    panes: deckState.panes,
    ...(deckState.activePaneId !== undefined
      ? { activePaneId: deckState.activePaneId }
      : {}),
    imposition: deckState.imposition,
  };
}

// ---- Deserialize ----

/**
 * Deserialize a JSON string to a DeckState.
 *
 * Accepts `version: 4` two-table blobs, migrates `version: 3` blobs (field
 * rename to v4 keys), migrates `version: 2` blobs (stacks → windows naming
 * then through the v3→v4 path), or migrates legacy single-table blobs
 * (`version: 5` or missing `version` with `cards[].tabs[]`) to the two-table
 * model. Any blob the parser cannot make sense of falls back to
 * {@link buildDefaultLayout}.
 *
 * Enforces 100px minimum sizes and fits panes to the canvas: a pane saved on
 * a larger display is capped to the current canvas and pulled fully on-screen
 * so neither it nor its contents overhang the visible bounds. See
 * {@link fitPaneGeometry}.
 */
export function deserialize(
  json: string,
  canvasWidth: number,
  canvasHeight: number,
): DeckState {
  const state = parseDeckState(json, canvasWidth, canvasHeight);
  // A deck saved with a stranded column member has to come back usable, not on
  // the error overlay: the record outlives the run that broke it, so healing
  // only the live mutations would leave every already-persisted deck bad
  // forever. Sweeping on the way in is what makes the fix retroactive.
  const imposition = sweptColumnOrders(state.imposition, state.panes);
  return imposition === state.imposition ? state : { ...state, imposition };
}

function parseDeckState(
  json: string,
  canvasWidth: number,
  canvasHeight: number,
): DeckState {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;

    if (raw["version"] === 4) {
      return parseV4(raw, canvasWidth, canvasHeight);
    }

    if (raw["version"] === 3) {
      return parseV4(migrateV3ToV4(raw), canvasWidth, canvasHeight);
    }

    if (raw["version"] === 2) {
      return migrateV2ToV4(raw, canvasWidth, canvasHeight);
    }

    // Legacy shape: missing version or any non-2/3/4 version. The historical v5
    // single-table shape (and any blob that still carries a `cards[].tabs`
    // structure) gets migrated in place. Unrelated shapes (e.g. version 4
    // placeholder objects without valid `cards`/`panes`) fall through to
    // the default layout via the `cards` Array check inside migrate or here.
    if (Array.isArray(raw["cards"])) {
      return migrateV1ToDeckState(raw, canvasWidth, canvasHeight);
    }

    return buildDefaultLayout();
  } catch {
    return buildDefaultLayout();
  }
}

// ---- Internal: v3 → v4 (field rename on the wire object) ----

/**
 * Convert a pre-v4 `version: 3` blob (`windows`, `activeWindowId`) into a
 * v4-shaped record (`panes`, `activePaneId`) for {@link parseV4}. Other keys
 * such as `focusedCardId` are preserved so parseV4 can ignore them as today.
 */
function migrateV3ToV4(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    version: 4,
    cards: raw["cards"],
    panes: raw["windows"],
  };
  const rawActive = raw["activeWindowId"];
  if (typeof rawActive === "string") {
    out["activePaneId"] = rawActive;
  }
  if ("focusedCardId" in raw) {
    out["focusedCardId"] = raw["focusedCardId"];
  }
  return out;
}

/**
 * The `sidebars` map from an imposition record, keeping only entries that
 * actually name a side. Entries whose `side` is missing or unreadable are
 * dropped rather than defaulted: an unplaced sidebar card takes
 * {@link DEFAULT_SIDEBAR_SIDE} at the moment it opens, and inventing an entry
 * here would record that default as though the user had chosen it.
 */
function parseSidebars(
  impositionRecord: Record<string, unknown> | undefined,
): Record<string, SidebarEntry> {
  const raw = impositionRecord?.["sidebars"];
  const out: Record<string, SidebarEntry> = {};
  if (raw === null || typeof raw !== "object") return out;
  for (const [componentId, value] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (value === null || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    if (!isSidebarSide(entry["side"])) continue;
    // The key is a componentId, so it runs through the rename history the
    // same way the card table's and the rails' do. Without this a renamed
    // card keeps its pane but loses the side it was standing on.
    // Built field by field rather than spread, so a blob carrying something
    // this build does not know about cannot smuggle it into the record. The
    // split build wrote an `order` here (a member's position in a rail that
    // divided vertically); same-side sidebars stand front-to-back now, so
    // there is no such position and the field is dropped on read.
    out[migrateComponentId(componentId)] = {
      side: entry["side"],
      ...(entry["pinned"] === false ? { pinned: false } : {}),
    };
  }
  return out;
}

/**
 * The `rails` record from an imposition record — how each side's sidebar cards
 * stand against one another.
 *
 * Additive-optional, and read defensively field by field like
 * {@link parseSidebars}: a blob written before splitting existed carries no
 * `rails` at all and comes back a stack on both sides, which is exactly what it
 * was. Anything unreadable is dropped rather than defaulted, down to the whole
 * side — an arrangement is something the user chose, and a half-read one is not
 * that.
 *
 * `order` entries and `shares` keys are componentIds, so they run through
 * {@link migrateComponentId} the same way the card table's do. The kind-rename
 * history is a real path (`"dev"` → `"session"`), and a rail that named a card
 * by its old id would otherwise drop that member's place on the first rename.
 * Unknown componentIds are *kept*: the card registry is not loaded at parse
 * time, and `effectiveRailOrder` filters to the members actually standing.
 */
function parseRails(
  impositionRecord: Record<string, unknown> | undefined,
): DeckImposition["rails"] {
  const raw = impositionRecord?.["rails"];
  if (raw === null || typeof raw !== "object") return undefined;
  const rails: NonNullable<DeckImposition["rails"]> = {};
  for (const side of ["left", "right"] as const) {
    const value = (raw as Record<string, unknown>)[side];
    if (value === null || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const arrangement: RailArrangement = {};

    // A blob written before [B01] may carry `mode` and `layout` on the side.
    // Both are IGNORED here and dropped by the next write: a rail is always
    // divided now, so neither says anything about how this side stands, and
    // the order and shares below are the whole of what it stored that survives.

    const order = entry["order"];
    if (Array.isArray(order)) {
      const ids = order
        .filter((id): id is string => typeof id === "string")
        .map(migrateComponentId);
      if (ids.length > 0) arrangement.order = ids;
    }

    const shares = entry["shares"];
    if (shares !== null && typeof shares === "object") {
      const weights: Record<string, number> = {};
      for (const [componentId, weight] of Object.entries(
        shares as Record<string, unknown>,
      )) {
        if (typeof weight !== "number") continue;
        if (!Number.isFinite(weight) || weight <= 0) continue;
        weights[migrateComponentId(componentId)] = weight;
      }
      if (Object.keys(weights).length > 0) arrangement.shares = weights;
    }

    // Nothing survived: the side is absent, which is what a stack already is.
    if (Object.keys(arrangement).length === 0) continue;
    rails[side] = arrangement;
  }
  return Object.keys(rails).length > 0 ? rails : undefined;
}

/**
 * The `columns` record from an imposition record — how the cards in each slot
 * stand against one another.
 *
 * Read exactly as defensively as {@link parseRails}, with two differences that
 * follow from a column being keyed by slot and by pane id rather than by side
 * and by componentId:
 *
 * - the keys are slot indices, so a key that is not a non-negative integer is
 *   dropped. Slots the current kind does not reach are *kept*: a deck dropped
 *   to three-up remembers its fourth column, and the imposer only ever asks
 *   about slots it has.
 * - the members are pane ids, which have no rename history, so nothing here
 *   runs through `migrateComponentId`. Unknown ids are kept for the same
 *   reason the rails keep theirs — the panes are parsed alongside, not before,
 *   and `effectiveColumnOrder` filters to the members actually standing.
 */
function parseColumns(
  impositionRecord: Record<string, unknown> | undefined,
): DeckImposition["columns"] {
  const raw = impositionRecord?.["columns"];
  if (raw === null || typeof raw !== "object") return undefined;
  const columns: NonNullable<DeckImposition["columns"]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const slot = Number(key);
    if (!Number.isInteger(slot) || slot < 0) continue;
    if (value === null || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const arrangement: ColumnArrangement = {};

    const mode = entry["mode"];
    if (mode !== undefined) {
      // A mode this build cannot read means the whole column is unreadable,
      // because the order and heights below describe an arrangement nobody
      // would have chosen under a guessed mode.
      if (!isColumnMode(mode)) continue;
      arrangement.mode = mode;
    }

    // A `layout` written before [B12] is ignored, as a rail's is: a divided
    // column divides its run and has no second answer to store.

    const order = entry["order"];
    if (Array.isArray(order)) {
      const ids = order.filter((id): id is string => typeof id === "string");
      if (ids.length > 0) arrangement.order = ids;
    }

    const shares = entry["shares"];
    if (shares !== null && typeof shares === "object") {
      const weights: Record<string, number> = {};
      for (const [paneId, weight] of Object.entries(
        shares as Record<string, unknown>,
      )) {
        if (typeof weight !== "number") continue;
        if (!Number.isFinite(weight) || weight <= 0) continue;
        weights[paneId] = weight;
      }
      if (Object.keys(weights).length > 0) arrangement.shares = weights;
    }

    // Nothing survived: the slot is absent, which is what a stack already is.
    if (Object.keys(arrangement).length === 0) continue;
    columns[slot] = arrangement;
  }
  return Object.keys(columns).length > 0 ? columns : undefined;
}

// ---- Internal: v4 parser ----

/**
 * Parse a `version: 4` layout blob into {@link DeckState}.
 * Ignores unknown top-level keys (including legacy `focusedCardId`).
 */
function parseV4(
  raw: Record<string, unknown>,
  canvasWidth: number,
  canvasHeight: number,
): DeckState {
  const rawCards = raw["cards"];
  const rawPanes = raw["panes"];
  if (!Array.isArray(rawCards) || !Array.isArray(rawPanes)) {
    return buildDefaultLayout();
  }

  const cards: CardState[] = [];
  const cardIdSet = new Set<string>();
  for (const c of rawCards) {
    if (!c || typeof c !== "object") continue;
    const card = c as Record<string, unknown>;
    const id = card["id"];
    const componentId = card["componentId"];
    if (typeof id !== "string" || typeof componentId !== "string") continue;
    const rawTitle = card["title"];
    const title = typeof rawTitle === "string" ? rawTitle : "";
    const rawClosable = card["closable"];
    const closable = typeof rawClosable === "boolean" ? rawClosable : true;
    const rawState = card["state"];
    const state =
      rawState && typeof rawState === "object"
        ? (rawState as CardState["state"])
        : undefined;
    cards.push({
      id,
      componentId: migrateComponentId(componentId),
      title,
      closable,
      ...(state !== undefined ? { state } : {}),
    });
    cardIdSet.add(id);
  }

  // A deck always stands under an imposition, so an absent or unreadable kind
  // reads as DEFAULT_IMPOSITION_KIND rather than as "no arrangement". A
  // pre-imposition blob restores under those anchors, which no pane occupies
  // until one is assigned a slot — the deck looks exactly as it did.
  //
  // `imposition` has widened without a version bump, so two shapes parse: a
  // bare kind string and the current `{ kind?, contentWidth?, sidebars }`
  // record. A blob older than that carries sidebar placements this parser does
  // not read; the ids it named are unregistered now, so nothing is lost that
  // `filterDeckStateByRegistration` would not have swept on the same load.
  const rawImposition = raw["imposition"];
  const impositionRecord =
    rawImposition !== null && typeof rawImposition === "object"
      ? (rawImposition as Record<string, unknown>)
      : undefined;
  const kind: ImpositionKind = isImpositionKind(rawImposition)
    ? rawImposition
    : isImpositionKind(impositionRecord?.["kind"])
      ? (impositionRecord["kind"] as ImpositionKind)
      : DEFAULT_IMPOSITION_KIND;

  const sidebars = parseSidebars(impositionRecord);
  const rawContentWidth = impositionRecord?.["contentWidth"];
  const rails = parseRails(impositionRecord);
  const columns = parseColumns(impositionRecord);
  // Additive-optional like `rails`: a blob written before the mode existed
  // carries no `layout` and comes back fit, which is what it was. An
  // unreadable value is dropped rather than defaulted to flow — a mode is
  // something the user chose.
  const rawLayout = impositionRecord?.["layout"];
  const imposition: DeckImposition = {
    kind,
    contentWidth: isContentWidth(rawContentWidth)
      ? rawContentWidth
      : DEFAULT_CONTENT_WIDTH,
    sidebars,
    ...(rails !== undefined ? { rails } : {}),
    ...(columns !== undefined ? { columns } : {}),
    ...(isImpositionLayout(rawLayout) ? { layout: rawLayout } : {}),
  };

  const panes: TugPaneState[] = [];
  for (const w of rawPanes) {
    if (!w || typeof w !== "object") continue;
    const win = w as Record<string, unknown>;
    const id = win["id"];
    const pos = win["position"] as { x: number; y: number } | undefined;
    const sz = win["size"] as { width: number; height: number } | undefined;
    const cardIdsRaw = win["cardIds"];
    if (
      typeof id !== "string" ||
      !pos ||
      !sz ||
      !Array.isArray(cardIdsRaw) ||
      cardIdsRaw.length === 0
    ) {
      continue;
    }
    const cardIds = cardIdsRaw.filter(
      (cid): cid is string => typeof cid === "string" && cardIdSet.has(cid),
    );
    if (cardIds.length === 0) continue;

    // An imposed pane — one holding a slot in the active imposition — derives
    // its geometry at render rather than from a free position; the canvas-fit
    // clamp would floor/cap the derived rect against the canvas, so skip it
    // and carry the stored geometry through untouched.
    const rawSlot = win["slot"];
    const slot: number | undefined =
      typeof rawSlot === "number" &&
      Number.isInteger(rawSlot) &&
      rawSlot >= 0
        ? clampSlot(kind, rawSlot)
        : undefined;

    const derived = slot !== undefined;
    const { x, y, width, height } = derived
      ? { x: pos.x, y: pos.y, width: sz.width, height: sz.height }
      : fitPaneGeometry(pos, sz, canvasWidth, canvasHeight);

    const rawActiveCardId = win["activeCardId"];
    const activeCardId: string =
      typeof rawActiveCardId === "string" && cardIds.includes(rawActiveCardId)
        ? rawActiveCardId
        : cardIds[0];

    const rawTitle = win["title"];
    const title = typeof rawTitle === "string" ? rawTitle : "";

    const acceptsFamilies = parseAcceptsFamilies(win["acceptsFamilies"]);

    // `collapsed` is deliberately not read. Window-shade collapse is gone, and
    // an old blob's `collapsed: true` deserializes to a pane that comes back
    // expanded — which is the whole of what dropping it costs.
    const rawWidthPreset = win["widthPreset"];
    const widthPreset = isContentWidth(rawWidthPreset)
      ? rawWidthPreset
      : undefined;

    // `minimized` is read on the way in because the pane is REBUILT here
    // field by field — `serialize` spreads the pane whole, so an additive
    // field survives the save and would be dropped on the load without this
    // line. Only `true` is honored; anything else restores as not minimized.
    const minimized = win["minimized"] === true ? (true as const) : undefined;

    panes.push({
      id,
      position: { x, y },
      size: { width, height },
      cardIds,
      activeCardId,
      title,
      acceptsFamilies,
      ...(widthPreset !== undefined ? { widthPreset } : {}),
      ...(slot !== undefined ? { slot } : {}),
      ...(minimized !== undefined ? { minimized } : {}),
    });
  }

  const referencedCardIds = new Set<string>();
  for (const pane of panes) {
    for (const cid of pane.cardIds) referencedCardIds.add(cid);
  }
  const filteredCards = cards.filter((c) => referencedCardIds.has(c.id));

  const rawActivePaneId = raw["activePaneId"];
  const activePaneId =
    typeof rawActivePaneId === "string" &&
    panes.some((pane) => pane.id === rawActivePaneId)
      ? rawActivePaneId
      : undefined;

  return {
    cards: filteredCards,
    panes,
    ...(activePaneId !== undefined ? { activePaneId } : {}),
    imposition,
    // Session-only; deserialize always seeds true and DeckManager overrides
    // with the live `document.hasFocus()` reading at construction. Not
    // persisted to disk.
    hasFocus: true,
  };
}

/**
 * Migrate a v2 two-table blob (`stacks`, `activeStackId`) to the pre-v4 v3
 * wire field names, then through {@link migrateV3ToV4} and {@link parseV4}.
 * Semantics are unchanged — key renames on the wire object before the same
 * validation and clamping as v4.
 */
function migrateV2ToV4(
  raw: Record<string, unknown>,
  canvasWidth: number,
  canvasHeight: number,
): DeckState {
  const bridged: Record<string, unknown> = {
    version: 3,
    cards: raw["cards"],
    windows: raw["stacks"],
  };
  const rawActive = raw["activeStackId"];
  if (typeof rawActive === "string") {
    bridged["activeWindowId"] = rawActive;
  }
  return parseV4(migrateV3ToV4(bridged), canvasWidth, canvasHeight);
}

// ---- Internal: legacy single-table → two-table ----

/**
 * Migrate a legacy single-table blob (historically `version: 5`) to
 * {@link DeckState}.
 *
 * Legacy shape per card:
 * ```
 * { id, position, size, tabs: [{ id, componentId, title, closable }],
 *   activeTabId, acceptsFamilies?, title? }
 * ```
 * Migration: each legacy card becomes a pane (same id); each legacy tab
 * becomes a card (same id). Pane `cardIds` = ordered legacy tab ids;
 * `activeCardId` = legacy `activeTabId` (falls back to first tab id).
 * `focusedCardId` in the legacy blob is already the card identity (= former
 * single-table tab identity) and carries across unchanged.
 */
function migrateV1ToDeckState(
  raw: Record<string, unknown>,
  canvasWidth: number,
  canvasHeight: number,
): DeckState {
  const rawCards = raw["cards"];
  if (!Array.isArray(rawCards)) {
    return buildDefaultLayout();
  }

  const cards: CardState[] = [];
  const panes: TugPaneState[] = [];

  for (const c of rawCards) {
    if (!c || typeof c !== "object") continue;
    const legacy = c as Record<string, unknown>;
    const paneId = legacy["id"];
    const pos = legacy["position"] as { x: number; y: number } | undefined;
    const sz = legacy["size"] as { width: number; height: number } | undefined;
    const rawTabs = legacy["tabs"];
    if (
      typeof paneId !== "string" ||
      !pos ||
      !sz ||
      !Array.isArray(rawTabs) ||
      rawTabs.length === 0
    ) {
      continue;
    }

    const cardIds: string[] = [];
    for (const t of rawTabs) {
      if (!t || typeof t !== "object") continue;
      const tab = t as Record<string, unknown>;
      const id = tab["id"];
      const componentId = tab["componentId"];
      if (typeof id !== "string" || typeof componentId !== "string") continue;
      const rawTitle = tab["title"];
      const title = typeof rawTitle === "string" ? rawTitle : "";
      const rawClosable = tab["closable"];
      const closable = typeof rawClosable === "boolean" ? rawClosable : true;
      cards.push({ id, componentId: migrateComponentId(componentId), title, closable });
      cardIds.push(id);
    }

    if (cardIds.length === 0) continue;

    const { x, y, width, height } = fitPaneGeometry(
      pos,
      sz,
      canvasWidth,
      canvasHeight,
    );

    const rawActiveTabId = legacy["activeTabId"];
    const activeCardId: string =
      typeof rawActiveTabId === "string" && cardIds.includes(rawActiveTabId)
        ? rawActiveTabId
        : cardIds[0];

    const rawTitle = legacy["title"];
    const title = typeof rawTitle === "string" ? rawTitle : "";

    const acceptsFamilies = parseAcceptsFamilies(legacy["acceptsFamilies"]);

    panes.push({
      id: paneId,
      position: { x, y },
      size: { width, height },
      cardIds,
      activeCardId,
      title,
      acceptsFamilies,
    });
  }

  return {
    cards,
    panes,
    imposition: { sidebars: { [CARDS_CARD_ID]: { side: DEFAULT_SIDEBAR_SIDE } } },
    hasFocus: true,
  };
}

// ---- Default Layout ----

/**
 * Build the default canvas layout.
 *
 * Returns an empty DeckState. The pre-Phase-5 five-card default layout used
 * component IDs that are not registered in Phase 5. An empty canvas is the
 * correct default until Phase 9 registers real cards.
 *
 * `hasFocus` is seeded true here as a safe default for non-browser
 * contexts (tests, SSR). `DeckManager` overrides it in its
 * constructor with the live `document.hasFocus()` reading.
 */
export function buildDefaultLayout(): DeckState {
  return {
    cards: [],
    panes: [],
    imposition: {
      kind: DEFAULT_IMPOSITION_KIND,
      contentWidth: DEFAULT_CONTENT_WIDTH,
      sidebars: { [CARDS_CARD_ID]: { side: DEFAULT_SIDEBAR_SIDE } },
    },
    hasFocus: true,
  };
}
