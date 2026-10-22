/**
 * _kinds.ts — the card kinds the grounding rows run against, one entry each.
 *
 * Every kind of card can be a body. A row that applies to more than one kind
 * runs once per kind under test, seeding that kind's pane with `kindPane` and
 * waiting on its `root` in the card's body; a row that applies to one kind
 * reads that kind's entry.
 *
 * `rows` is the bar each kind is held to: the row numbers of this directory's
 * `row-NN-*.test.ts` files that apply to it. A row not listed does not apply,
 * and `notApplicable` says why where the reason is the kind's own (it has no
 * sheet, no field, it never crosses). The README's row table is this table
 * read the other way.
 *
 * The maker kinds — gallery, spike and fixture cards — share one registration
 * shape, so the gallery's `gallery-buttons` card stands for all of them.
 *
 * The module imports nothing, so the card-DOM census can read the kinds' root
 * selectors from it outside a test run.
 */

/** One card kind, as the grounding rows reach it. */
export interface CardKind {
  /** The deck's `componentId` for the kind. */
  readonly componentId: string;
  /** Whether the kind pins to a deck edge (a rail) rather than a slot. */
  readonly rail: boolean;
  /** A selector in the card's body whose presence proves the card is up. */
  readonly root: string;
  /**
   * Selector fragments only this kind's DOM carries — its class and test-id
   * prefixes — by which the card-DOM census tells a reach into it. The root
   * is always one.
   */
  readonly marks: readonly string[];
  /** The text field typing lands in when the card holds the keyboard; absent for a kind with none. */
  readonly field?: string;
  /** The grounding rows that apply to the kind. */
  readonly rows: readonly number[];
  /** Why a row does not apply, where the reason is the kind's own. */
  readonly notApplicable: Readonly<Record<number, string>>;
}

/** The rows every kind is held to: arrival, motion, focus, lifecycle, edges, deck facts. */
const EVERY_KIND = [1, 2, 3, 4, 6, 7, 9, 10, 11, 14, 20, 21, 23, 28, 29] as const;

/** The rows only the Session card has, because only it streams, composes and compacts. */
const SESSION_ONLY: Readonly<Record<number, string>> = {
  15: "Session-only by construction",
  16: "Session-only by construction",
  19: "Session-only by construction",
  22: "Session-only by construction",
  24: "Session-only by construction",
  26: "raises no deck-scope surface",
};

const NO_SHEET = "no sheet";
const NO_FIELD = "no field";

/** Rows a pinned rail cannot have, whatever its kind, and why. */
const RAIL_ONLY_NOT: Readonly<Record<number, string>> = {
  9: "a rail does not fold: `setPaneFolded` refuses one",
};

/** The class and test-id prefixes only each kind's DOM carries, beyond its root. */
const MARKS: Readonly<Record<string, readonly string[]>> = {
  overview: ['[data-testid="overview-', ".overview-"],
  jots: ['[data-testid="jots-', ".jots-"],
  dashes: ['[data-testid="arcs-', ".arcs-"],
  cards: ['[data-testid="cards-', ".cards-"],
  layout: ['[data-testid="layout-card', ".layout-card"],
  devtools: [".devtools-card", ".tug-devpanel-", ".tug-devlog-", '[data-testid="devtools-'],
  settings: [
    ".settings-card",
    ".settings-general",
    ".settings-session-card",
    '[data-testid="settings-card',
    '[data-testid="settings-section-',
    '[data-testid="settings-general',
    '[data-testid="settings-session-card',
    '[data-testid="settings-default-',
    '[data-testid="settings-briefs-',
    '[data-testid="tug-tab-view-tab-',
  ],
  keyboard: [".keyboard-card", ".settings-keymap", '[data-testid="keymap-'],
  about: [".about-card", '[data-testid="about-card'],
  hello: ['[data-testid="hello-world-'],
  "gallery-buttons": [".cg-", '[data-testid="button-'],
};

/** Each kind's text field, where it has one. */
const FIELDS: Readonly<Record<string, string>> = {
  session: '[data-slot="tug-text-editor"] .cm-content',
  overview: '[data-testid="overview-composer-field"] .cm-content',
};

function kind(
  componentId: string,
  rail: boolean,
  root: string,
  extraRows: readonly number[],
  notApplicable: Readonly<Record<number, string>> = {},
): CardKind {
  const rows = [...new Set([...EVERY_KIND, ...extraRows])].filter((r) => !(rail && r in RAIL_ONLY_NOT)).sort((a, b) => a - b);
  const field = FIELDS[componentId];
  return {
    componentId,
    rail,
    root,
    marks: [root, ...(MARKS[componentId] ?? [])],
    ...(field !== undefined ? { field } : {}),
    rows,
    notApplicable: { ...SESSION_ONLY, ...(rail ? RAIL_ONLY_NOT : {}), ...notApplicable },
  };
}

const CONTENT_SURFACES = [17, 25, 5];

/** Every kind, in the order the kinds move. */
export const CARD_KINDS: readonly CardKind[] = [
  {
    componentId: "session",
    rail: false,
    root: '[data-slot="tug-prompt-entry"]',
    marks: ['[data-slot="tug-prompt-entry"]'],
    field: FIELDS.session,
    rows: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29],
    notApplicable: {},
  },
  kind("overview", true, ".overview-card", [5, 12, 17, 25, 32], { 8: NO_SHEET }),
  kind("jots", true, '[data-testid="jots-toolbar"]', [5, 12, 25, 27], { 8: NO_SHEET, 17: "rails do not cross" }),
  // The Arcs card, under the component id it has always carried (`ARCS_CARD_ID`).
  kind("dashes", true, '[data-testid="arcs-card-content"]', [13, 25], { 8: NO_SHEET, 12: NO_FIELD, 17: "rails do not cross" }),
  kind("cards", true, ".cards-card", [5, 8, 25, 33], { 12: NO_FIELD, 17: "rails do not cross" }),
  kind("layout", true, '[data-testid="layout-card-content"]', [25, 33], { 8: NO_SHEET, 12: NO_FIELD, 17: "rails do not cross" }),
  kind("text", false, '[data-slot="text-card"]', [12, ...CONTENT_SURFACES], { 8: NO_SHEET }),
  kind("file-view", false, ".file-view-card", CONTENT_SURFACES, { 8: NO_SHEET, 12: NO_FIELD }),
  kind("diff", false, '[data-slot="diff-card"]', CONTENT_SURFACES, { 8: NO_SHEET, 12: NO_FIELD }),
  kind("commit", false, '[data-slot="commit-card"]', CONTENT_SURFACES, { 8: NO_SHEET, 12: NO_FIELD }),
  kind("devtools", false, '[data-testid="devtools-card"]', [], { 8: NO_SHEET, 12: NO_FIELD }),
  kind("settings", false, '[data-testid="settings-card"]', [8], { 12: NO_FIELD }),
  kind("keyboard", false, '[data-testid="keyboard-card"]', [], { 8: NO_SHEET, 12: NO_FIELD }),
  kind("about", false, '[data-testid="about-card"]', [], { 8: NO_SHEET, 12: NO_FIELD }),
  kind("hello", false, '[data-testid="hello-world-card-content"]', [], { 8: NO_SHEET, 12: NO_FIELD }),
  kind("gallery-buttons", false, '[data-testid="gallery-buttons"]', [], { 8: NO_SHEET, 12: NO_FIELD }),
];

/** The entry for `componentId`; throws for a kind the table does not hold. */
export function cardKind(componentId: string): CardKind {
  const entry = CARD_KINDS.find((k) => k.componentId === componentId);
  if (entry === undefined) throw new Error(`_kinds: no kind "${componentId}"`);
  return entry;
}

/**
 * The kinds a row runs against: those `TUG_BODY_KINDS` names (a comma list),
 * or, with it unset, one representative of each placement shape — the
 * Session card for a content card, the Overview for a pinned rail — and of
 * those, only the ones `row` applies to. The rows test the body machinery,
 * which does not know which card a body holds; a kind proves itself in its
 * own kind check, not by running every row again.
 */
export function kindsUnderTest(row: number, env: string | undefined = process.env.TUG_BODY_KINDS): CardKind[] {
  const named =
    env === undefined || env.trim() === ""
      ? CARD_KINDS.filter((k) => SHAPE_REPRESENTATIVES.includes(k.componentId))
      : env.split(",").map((name) => cardKind(name.trim()));
  return named.filter((k) => k.rows.includes(row));
}

/** The one card that stands for each placement shape in the grounding rows. */
const SHAPE_REPRESENTATIVES: readonly string[] = ["session", "overview"];

/**
 * The width each rail kind opens at, from its registration's preferred size
 * (the factory rails: 452 px on the left, 375 px on the right). A rail is
 * seeded at it, so the allocator leaves it where it stands and moving it to
 * the other edge is a move, not a move and a resize. Kept by hand, since this
 * module imports nothing; a registration that moves its width moves it here.
 */
const RAIL_WIDTHS: Readonly<Record<string, number>> = {
  overview: 452,
  jots: 452,
  dashes: 452,
  cards: 375,
  layout: 375,
};

/**
 * One pane holding a card of `componentId`: a slotted pane in the flow band
 * for a content kind (the Session card's is `_bodies.ts`'s `sessionPane`
 * exactly), and an unslotted rail pane for a sidebar kind, which
 * `kindSidebars` pins.
 */
export function kindPane(componentId: string, cardId: string, slot: number): Record<string, unknown> {
  const entry = cardKind(componentId);
  if (entry.rail) {
    return {
      id: `${cardId}-pane`,
      position: { x: 0, y: 0 },
      size: { width: RAIL_WIDTHS[componentId] ?? 420, height: 900 },
      cardIds: [cardId],
      activeCardId: cardId,
      title: "",
      acceptsFamilies: [],
    };
  }
  const family = componentId === "session" || componentId.startsWith("gallery-") ? "maker" : "standard";
  return {
    id: `${cardId}-pane`,
    position: { x: 40, y: 40 },
    size: { width: 640, height: 480 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: [family],
    slot,
  };
}

/** The deck's `imposition.sidebars` entry pinning every rail kind among `componentIds` to the right edge. */
export function kindSidebars(componentIds: readonly string[]): Record<string, { side: "right" }> {
  const sidebars: Record<string, { side: "right" }> = {};
  for (const id of componentIds) if (cardKind(id).rail) sidebars[id] = { side: "right" };
  return sidebars;
}

/** Whether the Session card is among the kinds `row` runs against. */
export function sessionUnderTest(row: number, env: string | undefined = process.env.TUG_BODY_KINDS): boolean {
  return kindsUnderTest(row, env).some((k) => k.componentId === "session");
}
