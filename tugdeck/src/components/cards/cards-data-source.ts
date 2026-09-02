/**
 * cards-data-source.ts — the `TugListView` data source for the Cards card **Cards**
 * section: a pane-first mirror of the deck canvas, grouped by kind.
 *
 * The deck's data model is pane-first — a pane owns an ordered `cardIds` and
 * one `activeCardId` — and this projection says so rather than flattening it.
 * The top level of the list is always a *pane*:
 *
 *  - A **single-card pane** borrows its card's identity, name, and row
 *    rendering wholesale. There is no chevron, no disclosure, no indent, and
 *    nothing to expand: the row IS the card's row. This is the invariant the
 *    whole section exists to honor.
 *  - A **multi-card pane** renders one pane row followed by one indented
 *    subrow per card, in `cardIds` order, unconditionally visible. There is no
 *    per-pane fold state anywhere in this file, and none is coming — a heavy
 *    stack is handled by collapsing its *group*.
 *
 * Rows are emitted group by group, in the user's arranged order (`orderedGroups`
 * over the persisted list, falling back to {@link GROUP_ORDER}). A group with no
 * pane rows
 * emits nothing at all, not an empty header. A collapsed group emits its
 * header and nothing else — the header is the way back.
 *
 * Everything here is pure over its inputs and resolvers, so the whole model is
 * exercised by `__tests__/cards-data-source.test.ts` with no registry, no
 * stores, and no DOM.
 *
 * Laws:
 *  - [L02] external state via `useSyncExternalStore` — this IS such a store
 *    (`subscribe` + `getVersion`); the hook mints one stable instance per
 *    lifetime and notifies from `useLayoutEffect` ([L03]).
 *  - [L19] component authoring — module docstring, exported types.
 *
 * @module components/cards/cards-data-source
 */

import { useLayoutEffect, useRef, useSyncExternalStore } from "react";

import { getRegistration } from "@/card-registry";
import type {
  TugListViewCellRole,
  TugListViewDataSource,
} from "@/components/tugways/tug-list-view";
import type { CardState, DeckState, TugPaneState } from "@/layout-tree";
import { findSidebarPanes } from "@/deck-store-selectors";
import type { CardSessionBinding } from "@/lib/card-session-binding-store";
import type { WorkspacesChangesetSnapshot } from "@/lib/changeset-types";
import {
  arcSessionIndex,
  type ArcSessionFact,
} from "@/lib/arc-session-index";
import { getDeckStore } from "@/lib/deck-store-registry";
import {
  countedFileType,
  fileTypeName,
  type FileTypeName,
} from "@/lib/file-type-names";
import {
  getOpenFileViewCard,
  getOpenFileViewCardsVersion,
  subscribeOpenFileViewCards,
} from "@/lib/file-view-open-registry";
import type { CardsRowOrder } from "@/components/cards/cards-store/types";
import {
  sessionDisplayTitleForBinding,
  sessionIdentityLineForBinding,
} from "@/lib/session-identity";
import {
  getOpenTextCard,
  getOpenTextCardsVersion,
  subscribeOpenTextCards,
} from "@/lib/text-card-open-registry";
import { filterAndRank, filterQueryMatch } from "@/lib/text-match";

import {
  GROUP_ORDER,
  orderedGroups,
  resolveCardsGroup,
  type CardsGroup,
} from "./cards-groups";
import { basename, dirname } from "@/lib/display-path";

// ---------------------------------------------------------------------------
// Path helpers — the display vocabulary shared by every file-kind row.
// `basename` / `dirname` are re-exported from `lib/display-path` so this
// section's rows and a tool header spell a path the same way.
// ---------------------------------------------------------------------------

export { basename, dirname };

/**
 * Abbreviate a macOS home prefix (`/Users/<name>`) to `~` for display. It lives
 * beside `basename` rather than in the section so the data source can match on
 * exactly the string the row shows — typing `~/src` finds the row, and the
 * highlight offsets land on the rendered characters.
 */
export function displayDir(dir: string): string {
  return dir.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

/** The abbreviated full path a row shows on hover (`~/src/proj/a.txt`). */
export function displayPath(path: string): string {
  const dir = dirname(path);
  const shown = dir.length > 0 ? displayDir(dir) : "";
  return shown.length > 0 ? `${shown}/${basename(path)}` : basename(path);
}

/** The shape {@link assignDisambiguators} needs to tell two rows apart. */
interface Nameable {
  readonly title: string;
  readonly path: string | null;
}

/**
 * The **shortest trailing directory run** that separates each entry from the
 * others sharing its filename — one segment where one is enough (`roadmap` vs
 * `Desktop`), more only where the near directories also match (`tugcast/src`
 * vs `tugbank/src`) — or `null` when the filename is already unique. Two files
 * with the same name in the same directory cannot happen, so the walk always
 * terminates at the abbreviated full directory.
 *
 * Returned as a parallel array so it can be attached to whatever row shape the
 * caller is building. Run it on the UNFILTERED set so a row's suffix does not
 * appear and vanish as the filter narrows the list.
 */
export function assignDisambiguators(
  entries: readonly Nameable[],
): (string | null)[] {
  const byTitle = new Map<string, Nameable[]>();
  for (const entry of entries) {
    const group = byTitle.get(entry.title);
    if (group === undefined) byTitle.set(entry.title, [entry]);
    else group.push(entry);
  }
  return entries.map((entry) => {
    const group = byTitle.get(entry.title) ?? [];
    if (group.length < 2 || entry.path === null) return null;
    const segments = (path: string): string[] =>
      displayDir(dirname(path))
        .split("/")
        .filter((s) => s !== "");
    const mine = segments(entry.path);
    const others: string[][] = [];
    for (const other of group) {
      if (other === entry || other.path === null) continue;
      others.push(segments(other.path));
    }
    for (let k = 1; k <= mine.length; k += 1) {
      const tail = mine.slice(mine.length - k).join("/");
      const clashes = others.some(
        (segs) => segs.slice(segs.length - k).join("/") === tail,
      );
      if (!clashes) return tail;
    }
    return mine.length > 0 ? mine.join("/") : null;
  });
}

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

/**
 * A card resolved for display: everything a cell needs to draw the card,
 * independent of whether it is showing as a pane row or as a subrow.
 */
export interface CardIdentity {
  readonly cardId: string;
  readonly componentId: string;
  readonly group: CardsGroup;
  /**
   * The name the row shows.
   *
   * For a bound session this is the identity's display title ([D141]): the
   * user's own name when they set one, the `<project>/<callsign>` Line when
   * they did not, and both only under a name collision. The flat rows here are
   * the same rule the three-line monitor row and the masthead already wear —
   * the callsign is carried everywhere and shown where it is the name.
   */
  readonly title: string;
  /**
   * The session's Line — `<project>/<callsign>` — for a bound session card,
   * and null for everything else.
   *
   * Not drawn. It exists so a filter still matches the callsign on a row that
   * has stopped printing one: the handle stays the way to find a session even
   * once the user has given it a name of their own, which is the whole promise
   * behind hiding it.
   */
  readonly callsignLine: string | null;
  /** The bound file path, for file-kind cards that have one. */
  readonly path: string | null;
  /** The card wears its unsaved-changes mark. Viewers are read-only, so never. */
  readonly unsaved: boolean;
  /** The session this card is bound to, when it is a bound session card. */
  readonly tugSessionId: string | null;
  /** The session's project directory, needed by the monitor cell. */
  readonly projectDir: string | null;
  readonly closable: boolean;
  /** A lucide icon name from the registration, for the generic cells. */
  readonly icon: string | null;
}

/** Which cell renderer draws a pane row. */
export type CardsPaneRowKind =
  | "session-pane"
  | "file-pane"
  | "tool-pane"
  | "stack-pane";

export type CardsRow =
  | {
      readonly type: "group-header";
      readonly group: CardsGroup;
      /** Pane rows in this group, after filtering. */
      readonly count: number;
      /** What the header reports while the group is folded — see
       *  {@link summarizeGroup}. */
      readonly summary: string;
      readonly collapsed: boolean;
    }
  | {
      readonly type: "pane";
      readonly group: CardsGroup;
      readonly paneId: string;
      /** The identity card — the pane's `activeCardId`. */
      readonly identity: CardIdentity;
      /** The key this row's arrangement position persists under ([P08]). */
      readonly orderKey: string;
      readonly cardCount: number;
      /**
       * Every hosted card is closable — whether a close box on the PANE row
       * has anything to offer. A pane close takes all of its cards with it, so
       * one card that refuses is enough to withhold the box; the surviving
       * cards' own rows still carry theirs.
       */
      readonly closable: boolean;
      readonly rowKind: CardsPaneRowKind;
      readonly disambiguator: string | null;
    }
  | {
      readonly type: "card";
      readonly group: CardsGroup;
      readonly paneId: string;
      readonly identity: CardIdentity;
      /** This card is its pane's active tab. */
      readonly active: boolean;
    };

/** The cell renderer key `TugListView` dispatches on. */
export function kindOfRow(row: CardsRow): string {
  if (row.type === "group-header") return "group-header";
  if (row.type === "card") return "subcard";
  return row.rowKind;
}

/** A row's stable, non-colliding list id. */
export function idOfRow(row: CardsRow): string {
  switch (row.type) {
    case "group-header":
      return `header:${row.group}`;
    case "pane":
      return `pane:${row.paneId}`;
    case "card":
      return `card:${row.identity.cardId}`;
  }
}

// ---------------------------------------------------------------------------
// Resolver seams — the registry and the open registries, injectable for tests
// ---------------------------------------------------------------------------

/** How a card's presentation is resolved. Every field defaults to the real
 *  registry / open registries, so production passes nothing. */
export interface CardsResolvers {
  /** The Cards card group a componentId files under, or `"none"` to omit it. */
  group: (componentId: string) => CardsGroup | "none";
  /** An open Text card's bound path. */
  textPath: (cardId: string) => string | null;
  /** An open Text card's buffer display name (`"Untitled-2"`). */
  textDisplayName: (cardId: string) => string | null;
  /** Whether an open Text card wears its unsaved-changes mark. */
  textUnsaved: (cardId: string) => boolean;
  /** An open viewer card's bound path. */
  viewPath: (cardId: string) => string | null;
  /** The title a bound session row displays — the identity's display title. */
  sessionLabel: (binding: CardSessionBinding) => string;
  /** That session's `<project>/<callsign>` Line, for the filter to match on. */
  sessionCallsignLine: (binding: CardSessionBinding) => string;
  /** The registration's fallback title for a card with none of its own. */
  defaultTitle: (componentId: string) => string;
  /** The registration's lucide icon name, for the generic cells. */
  icon: (componentId: string) => string | null;
}

export const DEFAULT_RESOLVERS: CardsResolvers = {
  group: (componentId) => {
    const reg = getRegistration(componentId);
    // An unregistered componentId cannot reach a pane (the deck filters those
    // panes out on load), but resolving it to `"none"` rather than guessing
    // keeps a stray one out of the mirror instead of inventing a home for it.
    return reg === undefined ? "none" : resolveCardsGroup(reg);
  },
  textPath: (cardId) => getOpenTextCard(cardId)?.getPath() ?? null,
  textDisplayName: (cardId) => getOpenTextCard(cardId)?.getDisplayName() ?? null,
  textUnsaved: (cardId) => getOpenTextCard(cardId)?.hasUnsavedMark() ?? false,
  viewPath: (cardId) => getOpenFileViewCard(cardId)?.getPath() ?? null,
  // A projection, not a render: this recomputes when the identity stores'
  // version tokens move (they are inputs to the section's memo), which is the
  // sanctioned non-React path into the resolver.
  sessionLabel: (binding) => sessionDisplayTitleForBinding(binding),
  sessionCallsignLine: (binding) => sessionIdentityLineForBinding(binding),
  defaultTitle: (componentId) =>
    getRegistration(componentId)?.defaultMeta.title ?? "",
  icon: (componentId) =>
    getRegistration(componentId)?.defaultMeta.icon ?? null,
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface LensCardsInputs {
  readonly deck: DeckState | null;
  /** The user's persisted per-group arrangement, by order key. */
  readonly cardsRowOrder: CardsRowOrder;
  /** The user's persisted group order; empty means the built-in one. */
  readonly groupOrder: readonly string[];
  /** Groups the user has collapsed. */
  readonly collapsedGroups: readonly string[];
  /** The band's filter query. Empty / whitespace → every row. */
  readonly filterQuery: string;
  /** Bumps when any card binds / rebinds a path in either open registry. */
  readonly registryVersion: number;
  readonly bindings: ReadonlyMap<string, CardSessionBinding>;
  /**
   * Version token for the tag store. A session row still reads the callsign —
   * as its Line for the filter to match on, and as its title whenever the user
   * has set no name — so a tag arriving late (or a ledger reroll replacing the
   * optimistic one) must re-run the projection. This is how the section says
   * "it changed". The synopsis appears in neither string and is deliberately
   * not an input here.
   */
  readonly tagVersion: unknown;
  /**
   * Version token for the name store. The user's name IS the row's title
   * ({@link CardIdentity.title}) under [D141], so a `/rename` that did not
   * re-run the projection would leave the row printing the callsign of a
   * session the user has already named — and findable only under the name it
   * had before they changed it.
   */
  readonly nameVersion: unknown;
  /**
   * The account-global changeset aggregate, which is where a session's dash
   * comes from. Null before the connection is up — the same as no dash at all,
   * and the honest reading of "nothing has said yet".
   *
   * The rows use it for one thing: a session's dash name joins the pane's
   * filter match fields, so a reader who types a dash name finds the session
   * working it. What the row DRAWS comes from the row's own leaf subscription,
   * not from here.
   *
   * A whole snapshot rather than a version token because the match needs the
   * dash's facts, not just notice that something moved; it is memoized per
   * snapshot identity ({@link arcSessionIndex}), so a recompute costs one map
   * lookup per session row.
   */
  readonly changesets: WorkspacesChangesetSnapshot | null;
}

/** Which cell renders a single-card pane of this group. */
const PANE_KIND_FOR_GROUP: Readonly<Record<CardsGroup, CardsPaneRowKind>> = {
  sessions: "session-pane",
  files: "file-pane",
  tools: "tool-pane",
};

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

/** A pane and its resolved cards, before grouping / ordering / filtering. */
interface PaneEntry {
  readonly pane: TugPaneState;
  readonly identity: CardIdentity;
  readonly cards: readonly CardIdentity[];
  readonly orderKey: string;
  readonly group: CardsGroup;
  /**
   * Where this pane sorts when the user has not arranged it.
   *
   * Deliberately NOT the pane's index in `deck.panes`: that array IS the
   * canvas stacking order — `deck-canvas` turns it straight into z-index — so
   * fronting a card rewrites it, and a list keyed off it would reshuffle every
   * time the user clicked between cards. The identity card's index in
   * `deck.cards` is insertion order and does not move, which is the same
   * stable footing the two retired sections stood on.
   */
  readonly seq: number;
}

/** The strings a card is matched on — the ones the row actually shows. */
function matchFields(identity: CardIdentity): (string | null)[] {
  return [
    identity.title,
    identity.callsignLine,
    identity.path !== null ? displayDir(dirname(identity.path)) : null,
  ];
}

function resolveCard(
  card: CardState,
  group: CardsGroup,
  bindings: ReadonlyMap<string, CardSessionBinding>,
  r: CardsResolvers,
): CardIdentity {
  const binding = bindings.get(card.id);
  let title: string;
  let callsignLine: string | null = null;
  let path: string | null = null;
  let unsaved = false;

  if (card.componentId === "text") {
    path = r.textPath(card.id);
    title =
      path !== null
        ? basename(path)
        : r.textDisplayName(card.id) ?? (card.title || "Untitled");
    unsaved = r.textUnsaved(card.id);
  } else if (card.componentId === "file-view") {
    path = r.viewPath(card.id);
    title = path !== null ? basename(path) : card.title || "File";
  } else if (binding !== undefined) {
    title = r.sessionLabel(binding);
    callsignLine = r.sessionCallsignLine(binding);
  } else {
    title = card.title || r.defaultTitle(card.componentId) || card.componentId;
  }

  return {
    cardId: card.id,
    componentId: card.componentId,
    group,
    title,
    callsignLine,
    path,
    unsaved,
    tugSessionId: binding?.tugSessionId ?? null,
    projectDir: binding?.projectDir ?? null,
    closable: card.closable,
    icon: card.icon ?? r.icon(card.componentId),
  };
}

// ---------------------------------------------------------------------------
// The collapsed-group summary
// ---------------------------------------------------------------------------

/** How many file kinds a folded Files group names before the rest are rolled
 *  into a remainder. Three fits the rail; a fourth pushes the header's own
 *  title into truncation, which is the wrong thing to lose. */
const SUMMARY_KIND_LIMIT = 3;

/**
 * What a folded group's header reports about what the fold is hiding.
 *
 * For Sessions and Tools that is the count and nothing else — those rows are
 * told apart by their names, and a name is exactly what a fold takes away, so
 * there is no second fact to offer.
 *
 * Files is different: a file row's kind is a real dimension of what it is, and
 * it survives the fold as a summary. "3" over a folded Files group answers a
 * question nobody asked; "2 Markdown · 1 Image" says what is in there. The
 * names are `file-type-names`', not extensions: the header is prose and reads
 * as prose, and its buckets are the ones a person would count in — every image
 * format is Images, `.ts` and `.tsx` are both TypeScript. Kinds are ordered by
 * how many there are, ties alphabetically, so the biggest thing in the group
 * leads and the order does not shuffle as counts move.
 */
export function summarizeGroup(
  group: CardsGroup,
  identities: readonly CardIdentity[],
): string {
  if (group !== "files") return String(identities.length);

  const counts = new Map<string, { name: FileTypeName; n: number }>();
  for (const identity of identities) {
    const name = fileTypeName(identity.path);
    const seen = counts.get(name.key);
    if (seen === undefined) counts.set(name.key, { name, n: 1 });
    else seen.n += 1;
  }
  const kinds = [...counts.values()].sort(
    (a, b) => b.n - a.n || a.name.one.localeCompare(b.name.one),
  );

  const parts = kinds
    .slice(0, SUMMARY_KIND_LIMIT)
    .map(({ name, n }) => countedFileType(name, n));
  const rest = kinds
    .slice(SUMMARY_KIND_LIMIT)
    .reduce((sum, { n }) => sum + n, 0);
  // The remainder counts FILES, not kinds: the number the user wants is how
  // many rows are still unaccounted for, not how many buckets they fell into.
  if (rest > 0) parts.push(`+${rest} more`);
  return parts.join(" · ");
}

/**
 * A pane's order key ([P08]): the identity that should survive a close/reopen.
 * A stack has only its pane id; a single-card session pane keys by session so
 * the arrangement holds across the card being closed and the session resumed;
 * everything else keys by card id.
 */
function orderKeyFor(
  pane: TugPaneState,
  identity: CardIdentity,
): string {
  if (pane.cardIds.length > 1) return pane.id;
  if (identity.tugSessionId !== null) return identity.tugSessionId;
  return identity.cardId;
}

/**
 * Project the deck into the Cards section's flat row list.
 *
 * A pane files under its **active card's** group, so a mixed-kind stack moves
 * groups when the user fronts a different-kind tab. Same-kind stacks — the
 * common case — never move, and a mixed one moving is honest: the row follows
 * what the pane currently is.
 */
export function buildCardsRows(
  inputs: LensCardsInputs,
  resolvers: Partial<CardsResolvers> = {},
): CardsRow[] {
  const r: CardsResolvers = { ...DEFAULT_RESOLVERS, ...resolvers };
  const deck = inputs.deck;
  if (deck === null) return [];

  // Session → dash, memoized on the snapshot, so every row's lookup is a map
  // hit rather than a walk of the aggregate.
  const dashes =
    inputs.changesets === null
      ? null
      : arcSessionIndex(inputs.changesets);
  const dashFor = (identity: CardIdentity): ArcSessionFact | null =>
    dashes === null || identity.tugSessionId === null
      ? null
      : dashes.get(identity.tugSessionId) ?? null;

  const cardsById = new Map(deck.cards.map((c) => [c.id, c]));
  const cardSeq = new Map(deck.cards.map((c, i) => [c.id, i]));
  const railPaneIds = new Set(findSidebarPanes(deck).map(({ pane }) => pane.id));

  // 1. One entry per pane, filed by its active card's group.
  const entries: PaneEntry[] = [];
  for (const pane of deck.panes) {
    if (railPaneIds.has(pane.id)) continue;
    const activeCard = cardsById.get(pane.activeCardId);
    if (activeCard === undefined) continue;
    const group = r.group(activeCard.componentId);
    if (group === "none") continue;

    const identity = resolveCard(activeCard, group, inputs.bindings, r);
    const cards = pane.cardIds
      .map((id) => cardsById.get(id))
      .filter((c): c is CardState => c !== undefined)
      .map((c) =>
        c.id === activeCard.id
          ? identity
          : resolveCard(c, group, inputs.bindings, r),
      );
    entries.push({
      pane,
      identity,
      cards,
      orderKey: orderKeyFor(pane, identity),
      group,
      seq: cardSeq.get(activeCard.id) ?? Number.MAX_SAFE_INTEGER,
    });
  }

  // 2. Disambiguators are computed over the UNFILTERED file-group pane rows,
  //    so a row's trailing directory does not appear and vanish as the filter
  //    narrows the list.
  const fileEntries = entries.filter((e) => e.group === "files");
  const suffixes = assignDisambiguators(fileEntries.map((e) => e.identity));
  const disambiguatorByPane = new Map<string, string | null>();
  fileEntries.forEach((entry, i) => {
    disambiguatorByPane.set(entry.pane.id, suffixes[i]);
  });

  // 3. Bucket by group, then order each bucket by the user's arrangement:
  //    ranked keys first in rank order, unranked entries trailing in deck
  //    order — so a newly opened card lands at the bottom without disturbing
  //    what the user arranged.
  const buckets = new Map<CardsGroup, PaneEntry[]>();
  for (const group of GROUP_ORDER) buckets.set(group, []);
  for (const entry of entries) buckets.get(entry.group)!.push(entry);

  const query = inputs.filterQuery;
  const filtering = query.trim().length > 0;
  const collapsed = new Set(inputs.collapsedGroups);
  const rows: CardsRow[] = [];

  for (const group of orderedGroups(inputs.groupOrder)) {
    const bucket = buckets.get(group)!;
    if (bucket.length === 0) continue;

    const order = inputs.cardsRowOrder[group] ?? [];
    const rank = new Map<string, number>();
    order.forEach((key, i) => rank.set(key, i));
    const ordered = [...bucket].sort((a, b) => {
      const ra = rank.get(a.orderKey) ?? Number.POSITIVE_INFINITY;
      const rb = rank.get(b.orderKey) ?? Number.POSITIVE_INFINITY;
      return ra !== rb ? ra - rb : a.seq - b.seq;
    });

    // 4. A pane survives the filter on its OWN text or on any of its cards' —
    //    a stack is findable by a tab buried inside it. Which subrows then
    //    show depends on which side matched: when the pane's own text matched,
    //    all of them (the user found the pane, so they get the pane); when only
    //    children matched, just those children.
    // The dash NAME joins the pane's match fields: a reader who types a dash
    // name is looking for the session working it, and the sub-row that would
    // answer only shows under a pane row that survived.
    const survivors = filtering
      ? filterAndRank(ordered, query, (entry) => [
          ...matchFields(entry.identity),
          dashFor(entry.identity)?.name ?? null,
          ...entry.cards.flatMap((c) => matchFields(c)),
        ])
      : ordered;
    if (survivors.length === 0) continue;

    const isCollapsed = collapsed.has(group);
    rows.push({
      type: "group-header",
      group,
      count: survivors.length,
      summary: summarizeGroup(
        group,
        survivors.map((entry) => entry.identity),
      ),
      collapsed: isCollapsed,
    });
    if (isCollapsed) continue;

    for (const entry of survivors) {
      const multi = entry.pane.cardIds.length > 1;
      rows.push({
        type: "pane",
        group,
        paneId: entry.pane.id,
        identity: entry.identity,
        orderKey: entry.orderKey,
        cardCount: entry.pane.cardIds.length,
        closable: entry.cards.every((card) => card.closable),
        rowKind: multi ? "stack-pane" : PANE_KIND_FOR_GROUP[group],
        disambiguator: disambiguatorByPane.get(entry.pane.id) ?? null,
      });

      if (!multi) continue;

      const paneMatched =
        !filtering || filterQueryMatch(query, matchFields(entry.identity));
      for (const card of entry.cards) {
        if (
          filtering &&
          !paneMatched &&
          !filterQueryMatch(query, matchFields(card))
        ) {
          continue;
        }
        rows.push({
          type: "card",
          group,
          paneId: entry.pane.id,
          identity: card,
          active: card.cardId === entry.pane.activeCardId,
        });
      }
    }
  }

  return rows;
}

/** A per-group census of pane rows, for the band's collapsed summary. */
export type CardsCensus = Readonly<Record<CardsGroup, number>>;

// ---------------------------------------------------------------------------
// The data source
// ---------------------------------------------------------------------------

export class CardsDataSource implements TugListViewDataSource {
  private inputs: LensCardsInputs;
  private rows: CardsRow[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly resolvers: Partial<CardsResolvers>;
  private version = 0;

  /** `resolvers` overrides the registry / open-registry defaults; production
   *  passes none. Held for the source's lifetime — a resolver set is a wiring
   *  choice, not an input that changes between recomputes. */
  constructor(inputs: LensCardsInputs, resolvers: Partial<CardsResolvers> = {}) {
    this.inputs = inputs;
    this.resolvers = resolvers;
    this.recompute();
  }

  numberOfItems(): number {
    return this.rows.length;
  }

  idForIndex(index: number): string {
    return idOfRow(this.rows[index]);
  }

  kindForIndex(index: number): string {
    return kindOfRow(this.rows[index]);
  }

  /**
   * Every row is a `"cell"`, headers included: `TugListView`'s `"header"` role
   * is inert — skipped by the cursor and by click — and a group header here is
   * a collapse toggle the arrow walk must reach.
   */
  roleForIndex(_index: number): TugListViewCellRole {
    return "cell";
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getVersion(): unknown {
    return this.version;
  }

  /** Typed row access for the cell renderers. */
  rowAt(index: number): CardsRow {
    return this.rows[index];
  }

  /** Index of the row with this list id, or -1 when absent. */
  indexForId(id: string): number {
    return this.rows.findIndex((row) => idOfRow(row) === id);
  }

  /** Index of the pane row carrying this order key, or -1 when absent — how a
   *  reorder finds the row it just moved, which it knows only by that key. */
  indexForOrderKey(orderKey: string): number {
    return this.rows.findIndex(
      (row) => row.type === "pane" && row.orderKey === orderKey,
    );
  }

  /** Index of this group's header row, or -1 when the group renders none. */
  indexForGroup(group: string): number {
    return this.rows.findIndex(
      (row) => row.type === "group-header" && row.group === group,
    );
  }

  /**
   * Index of the first pane row, or -1 when the projection holds none.
   *
   * The section seeds the movement cursor here rather than letting the list
   * fall back to its first cursorable row, which — headers being cursorable —
   * would be a group header. ⌘L must land on a card, not on a collapse toggle.
   */
  firstPaneRowIndex(): number {
    return this.rows.findIndex((row) => row.type === "pane");
  }

  setInputsWithoutNotify(next: LensCardsInputs): boolean {
    if (
      this.inputs.deck === next.deck &&
      this.inputs.cardsRowOrder === next.cardsRowOrder &&
      this.inputs.groupOrder === next.groupOrder &&
      this.inputs.collapsedGroups === next.collapsedGroups &&
      this.inputs.filterQuery === next.filterQuery &&
      this.inputs.registryVersion === next.registryVersion &&
      this.inputs.bindings === next.bindings &&
      this.inputs.tagVersion === next.tagVersion &&
      this.inputs.nameVersion === next.nameVersion &&
      this.inputs.changesets === next.changesets
    ) {
      return false;
    }
    this.inputs = next;
    this.recompute();
    return true;
  }

  notifyAll(): void {
    for (const listener of this.listeners) listener();
  }

  /** Whether a filter is narrowing the list right now. */
  isFiltering(): boolean {
    return this.inputs.filterQuery.trim().length > 0;
  }

  /**
   * The order keys of the pane rows as RENDERED, in emission order — the
   * reorder hook's `getVisibleOrder`.
   *
   * Derived from the projection and never from the underlying pane set:
   * `useBlockReorder`'s `beginDrag` aborts silently, with no error and no log,
   * if any key it is handed has no mounted element. A collapsed group emits no
   * pane rows, so its keys must be absent here too.
   */
  visibleOrder(): string[] {
    const out: string[] = [];
    for (const row of this.rows) {
      if (row.type === "pane") out.push(row.orderKey);
    }
    return out;
  }

  /**
   * The groups as RENDERED, in emission order — the group reorder hook's
   * `getVisibleOrder`. Same derived-from-the-projection discipline as
   * {@link visibleOrder}: a group with no rows emits no header, so it must not
   * appear here either.
   */
  visibleGroupOrder(): CardsGroup[] {
    const out: CardsGroup[] = [];
    for (const row of this.rows) {
      if (row.type === "group-header") out.push(row.group);
    }
    return out;
  }

  /** The group each order key currently belongs to — what a reorder commit
   *  re-buckets against, so a row dropped across a boundary still orders
   *  within its own group. */
  groupByOrderKey(): Map<string, CardsGroup> {
    const out = new Map<string, CardsGroup>();
    for (const row of this.rows) {
      if (row.type === "pane") out.set(row.orderKey, row.group);
    }
    return out;
  }

  /** Pane rows per group, filter or no filter — the band's summary reads this. */
  censusByGroup(): CardsCensus {
    const unfiltered = buildCardsRows(
      { ...this.inputs, filterQuery: "", collapsedGroups: [] },
      this.resolvers,
    );
    const out: Record<CardsGroup, number> = {
      sessions: 0,
      files: 0,
      tools: 0,
    };
    for (const row of unfiltered) {
      if (row.type === "pane") out[row.group] += 1;
    }
    return out;
  }

  /** How many pane rows exist, filter or no filter. */
  unfilteredCount(): number {
    const census = this.censusByGroup();
    return census.sessions + census.files + census.tools;
  }

  private recompute(): void {
    this.rows = buildCardsRows(this.inputs, this.resolvers);
    this.version += 1;
  }
}

const NOOP_SUBSCRIBE = (): (() => void) => () => {};

/**
 * Hook — read the deck snapshot and both open registries (all [L02] stores)
 * and feed a stable {@link CardsDataSource}, notifying from a layout
 * effect ([L03]).
 */
export function useCardsDataSource(
  inputs: Omit<LensCardsInputs, "deck" | "registryVersion">,
): CardsDataSource {
  const deckStore = getDeckStore();
  const deck = useSyncExternalStore(
    deckStore?.subscribe ?? NOOP_SUBSCRIBE,
    deckStore !== null ? deckStore.getSnapshot : () => null,
    () => null,
  );
  // Recompute when a card binds / rebinds its path, so a just-opened file is
  // titled the instant its card resolves. Both families feed the list, so both
  // registries are watched; their versions sum into one input, which changes
  // whenever either side moves.
  const textVersion = useSyncExternalStore(
    subscribeOpenTextCards,
    getOpenTextCardsVersion,
    getOpenTextCardsVersion,
  );
  const viewVersion = useSyncExternalStore(
    subscribeOpenFileViewCards,
    getOpenFileViewCardsVersion,
    getOpenFileViewCardsVersion,
  );

  const ref = useRef<CardsDataSource | null>(null);
  const full: LensCardsInputs = {
    ...inputs,
    deck,
    registryVersion: textVersion + viewVersion,
  };
  if (ref.current === null) {
    ref.current = new CardsDataSource(full);
  }
  const ds = ref.current;
  const didChange = ds.setInputsWithoutNotify(full);

  useLayoutEffect(() => {
    if (didChange) ds.notifyAll();
    // didChange is captured per render; intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  return ds;
}
