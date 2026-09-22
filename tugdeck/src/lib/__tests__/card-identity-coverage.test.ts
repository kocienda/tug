/**
 * Registration coverage for `cardIdentity` — the guard that makes [B02]'s
 * claim true rather than aspirational.
 *
 * The claim is that identity resolution is total BY CONSTRUCTION: a card type
 * cannot be added broken, because the resolver is declared on the
 * registration rather than switched on inside whichever consumer happens to
 * be naming cards. `cardIdentity` is total by its own final rung, so a test
 * that only asked "does it return something" would pass for a card type
 * nobody had thought about — which is exactly the failure [F04] describes, a
 * kind born drawing its registration's generic default.
 *
 * So this file is built the way `cards-groups.test.ts` is built, and for the
 * same reason. It registers the whole app's card set — the same entry points
 * `main.tsx` calls — and then asserts two things:
 *
 *   - **The mapping.** Every registered kind is named below as one that
 *     DECLARES a durable resolver or one that deliberately does not, and each
 *     declaring kind is driven with the bag its own card writes to check that
 *     a parked card of that kind says what it holds.
 *   - **Closure.** The two lists together account for every registration, and
 *     the set declaring `identity.parked` is exactly the declaring list.
 *
 * A new card type therefore fails this file the moment it is registered,
 * until somebody says which of the two it is. That failure is the guard —
 * the whole point is that nobody has to notice.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  _resetForTest,
  getAllRegistrations,
  getRegistration,
} from "@/card-registry";
import { registerHelloWorldCard } from "@/components/tugways/cards/hello-world-card";
import { registerSessionCard } from "@/components/tugways/cards/session-card-registration";
import { registerAboutCard } from "@/components/tugways/cards/about-card";
import { registerSettingsCard } from "@/components/tugways/cards/settings-card";
import { registerKeyboardCard } from "@/components/tugways/cards/keyboard-card";
import { registerDevtoolsCard } from "@/components/devtools/devtools-card";
import { registerJotsCard } from "@/components/jots/jots-card-registration";
import { registerOverviewCard } from "@/components/overview/overview-card-registration";
import { registerArcsCard } from "@/components/arcs/arcs-card-registration";
import { registerCardsCard } from "@/components/cards/cards-card-registration";
import { registerLayoutCard } from "@/components/layout/layout-card-registration";
import { registerTextCard } from "@/components/tugways/cards/text-card-registration";
import { registerFileViewCard } from "@/components/tugways/cards/file-view-card-registration";
import { registerDiffCard } from "@/components/tugways/cards/diff-card";
import { registerCommitCard } from "@/components/tugways/cards/commit-card";
import { registerGalleryCards } from "@/components/tugways/cards/gallery-registrations";
import { registerSpikeCards } from "@/spikes/spike-registry";
import { registerFixtureCards } from "@/fixtures/fixture-registrations";

import type { CardState, DeckState } from "@/layout-tree";
import type { IDeckManagerStore } from "@/deck-manager-store";
import { registerDeckStore } from "@/lib/deck-store-registry";
import { publishListCardBindingsOk } from "@/lib/session-ledger-events";
import { spaceBindingsLedgerStore } from "@/lib/space-bindings-ledger-store";
import { cardIdentity, type ResolvedCardIdentity } from "@/lib/card-identity";
import { DEFAULT_RESOLVERS } from "@/components/cards/cards-data-source";
import {
  registerOpenCommitCard,
  unregisterOpenCommitCard,
} from "@/lib/commit-card-open-registry";

const CARD_ID = "coverage-card";
const SESSION_ID = "coverage-session";
const PROJECT_DIR = "/w/coverage-project";

// bun shares module state across test files, so register from scratch.
beforeAll(() => {
  _resetForTest();
  registerHelloWorldCard();
  registerSessionCard();
  registerAboutCard();
  registerSettingsCard();
  registerKeyboardCard();
  registerDevtoolsCard();
  registerJotsCard();
  registerOverviewCard();
  registerArcsCard();
  registerCardsCard();
  registerLayoutCard();
  registerTextCard();
  registerFileViewCard();
  registerDiffCard();
  registerCommitCard();
  registerGalleryCards();
  registerSpikeCards();
  registerFixtureCards();
});

afterAll(() => {
  registerDeckStore(null);
  // The ledger cache is a module singleton shared with every other file, so
  // it is emptied by REPLACING its rows the way a later frame would, never by
  // dropping its bus subscription — that reset is process-wide and leaves the
  // store deaf for whatever file runs next.
  publishListCardBindingsOk({ bindings: [] });
  _resetForTest();
});

/**
 * The maker card families, which are registered in bulk and named by prefix
 * rather than one at a time — the same shape `cards-groups.test.ts` reads
 * them by, and for the same reason: the list is long and nobody adds a
 * gallery tab to give it an identity.
 */
const MAKER_PREFIXES = ["gallery-", "spike-", "fixture-"] as const;

const isMaker = (componentId: string): boolean =>
  MAKER_PREFIXES.some((prefix) => componentId.startsWith(prefix));

/** A card type that answers for a card nothing is holding up. */
interface DeclaringPin {
  componentId: string;
  /** Where the durable answer comes from. */
  via: string;
  /** The bag this card's own `useCardStatePreservation.onSave` writes. */
  bag?: Record<string, unknown>;
  /** A bindings-ledger row, for the one kind whose door is the ledger. */
  ledger?: boolean;
  /** What a parked card of this kind must be called. */
  title?: string;
  /** Extra facts the kind's answer must carry, beyond the title. */
  also?: (identity: ResolvedCardIdentity) => void;
}

const DECLARING: readonly DeclaringPin[] = [
  {
    componentId: "session",
    via: "the bindings ledger cache",
    ledger: true,
    // The title is a projection over the name/tag/synopsis stores, which this
    // file does not seed; what the defect was about is the two IDS, which are
    // what make the row build as a session row at all ([B04]).
    also: (identity) => {
      expect(identity.tugSessionId).toBe(SESSION_ID);
      expect(identity.projectDir).toBe(PROJECT_DIR);
      expect(identity.title.length).toBeGreaterThan(0);
    },
  },
  {
    componentId: "text",
    via: "the persisted bag's path",
    bag: { path: "/w/repo/notes.md" },
    title: "notes.md",
  },
  {
    componentId: "file-view",
    via: "the persisted bag's path",
    bag: { path: "/w/repo/parser.rs" },
    title: "parser.rs",
  },
  {
    componentId: "commit",
    via: "the persisted bag's target, through the card's own coercion",
    bag: { target: { root: "/w/repo", sha: "abcdef0123456789" } },
    title: "Commit abcdef012",
  },
  {
    componentId: "diff",
    via: "the persisted bag's descriptor, through the card's own coercion",
    bag: { descriptor: { kind: "head", root: "/w/repo" } },
    title: "Project Diff",
  },
];

/**
 * The kinds that deliberately declare nothing, each with the reason.
 *
 * A card type belongs here when its identity IS its type: there is one Jots
 * card and one Settings card, they hold nothing a second one could differ
 * over, and the registration's own title is the whole answer. The rail cards
 * are all of this shape, which is why they are also the cards the Workspaces
 * list excludes.
 */
const NOT_DECLARING: readonly { componentId: string; why: string }[] = [
  { componentId: "cards", why: "a rail — one per workspace, named by its type" },
  { componentId: "dashes", why: "a rail" },
  { componentId: "jots", why: "a rail" },
  { componentId: "layout", why: "a rail" },
  { componentId: "overview", why: "a rail" },
  { componentId: "about", why: "one per deck, and it holds nothing" },
  { componentId: "settings", why: "one per deck, and it holds nothing" },
  { componentId: "keyboard", why: "one per deck, and it holds nothing" },
  { componentId: "devtools", why: "a maker surface, holding no target" },
  { componentId: "hello", why: "the sample card, holding no target" },
];

/**
 * A deck holding one card of `componentId`, with `bag` as its persisted
 * content — the state a card in a workspace nobody has activated is in.
 */
function parkOneCard(
  componentId: string,
  bag: Record<string, unknown> | undefined,
): void {
  const card: CardState = {
    id: CARD_ID,
    componentId,
    title: "",
    closable: true,
  };
  const deck = { cards: [card] } as unknown as DeckState;
  registerDeckStore({
    spaceOf: (cardId: string) => (cardId === CARD_ID ? "space-1" : null),
    getSpaceDeck: (spaceId: string) => (spaceId === "space-1" ? deck : null),
    getCardState: (cardId: string) =>
      cardId === CARD_ID && bag !== undefined ? { content: bag } : undefined,
  } as unknown as IDeckManagerStore);
}

/** The ledger's answer for `CARD_ID`, as the boot frame delivers it. */
function seedLedger(): void {
  spaceBindingsLedgerStore.installOnce();
  publishListCardBindingsOk({
    bindings: [
      {
        card_id: CARD_ID,
        session_id: SESSION_ID,
        line_id: SESSION_ID,
        project_dir: PROJECT_DIR,
        state: "live",
        turn_count: 3,
      },
    ] as never,
  });
}

describe("every kind that answers for a parked card", () => {
  for (const pin of DECLARING) {
    test(`${pin.componentId} — ${pin.via}`, () => {
      if (pin.ledger === true) seedLedger();
      parkOneCard(pin.componentId, pin.bag);

      const identity = cardIdentity(CARD_ID);
      expect(identity.source).toBe("parked");
      if (pin.title !== undefined) expect(identity.title).toBe(pin.title);
      pin.also?.(identity);

      // The whole defect, stated once per kind: the registration's generic
      // default is what a parked card used to draw as.
      const registryTitle = getRegistration(pin.componentId)!.defaultMeta.title;
      expect(identity.title, `${pin.componentId} drew as its type`).not.toBe(
        registryTitle,
      );

      registerDeckStore(null);
      publishListCardBindingsOk({ bindings: [] });
    });
  }
});

describe("every kind that deliberately answers nothing", () => {
  for (const pin of NOT_DECLARING) {
    test(`${pin.componentId} — ${pin.why}`, () => {
      const registration = getRegistration(pin.componentId);
      expect(registration, `${pin.componentId} is not registered`).toBeDefined();
      expect(registration!.identity).toBeUndefined();

      // Still total: the final rung answers. Its rule is the card's own
      // title, then the registration's, then the componentId — and the last
      // of those is reached for real, because the About card registers an
      // EMPTY title and publishes "About Tug" only once it is standing.
      parkOneCard(pin.componentId, undefined);
      const identity = cardIdentity(CARD_ID);
      expect(identity.source).toBe("default");
      expect(identity.title).toBe(
        registration!.defaultMeta.title || pin.componentId,
      );
      registerDeckStore(null);
    });
  }
});

describe("closure over the registration list", () => {
  test("every registered kind is named in one of the two lists", () => {
    const named = new Set<string>([
      ...DECLARING.map((pin) => pin.componentId),
      ...NOT_DECLARING.map((pin) => pin.componentId),
    ]);
    const unaccounted = [...getAllRegistrations().keys()]
      .filter((componentId) => !isMaker(componentId))
      .filter((componentId) => !named.has(componentId))
      .sort();
    expect(
      unaccounted,
      "a new card type: say whether it answers for a parked card, or why it needs not",
    ).toEqual([]);
  });

  test("the kinds declaring a durable resolver are exactly the declaring list", () => {
    const declared = [...getAllRegistrations().values()]
      .filter((registration) => registration.identity?.parked !== undefined)
      .map((registration) => registration.componentId)
      .sort();
    expect(declared).toEqual(
      DECLARING.map((pin) => pin.componentId).sort(),
    );
  });

  test("a maker card resolves too, to the name its registration gives it", () => {
    const maker = [...getAllRegistrations().values()].filter((registration) =>
      isMaker(registration.componentId),
    );
    expect(maker.length).toBeGreaterThan(0);
    for (const registration of maker) {
      parkOneCard(registration.componentId, undefined);
      const identity = cardIdentity(CARD_ID);
      expect(identity.source, registration.componentId).toBe("default");
      expect(identity.title, registration.componentId).toBe(
        registration.defaultMeta.title || registration.componentId,
      );
    }
    registerDeckStore(null);
  });

  test("an id no workspace holds resolves without a registration at all", () => {
    // Totality's other end: the guarantee callers rely on is that there is no
    // null to handle, whatever id they were given.
    registerDeckStore(null);
    expect(cardIdentity("nobody-holds-this").title).toBe("nobody-holds-this");
  });
});

/**
 * The Workspaces list's own seam, from the other side.
 *
 * `resolveCard`'s generic branch names every kind the two file branches do
 * not, and it has no live path of its own — so a kind whose identity is
 * declared on its registration must come back through that seam whether it is
 * standing or not. Taking only the durable half there would have made the
 * ACTIVE workspace the degraded one: a Commit card said what commit it held
 * until the user clicked into its workspace, and read a bare "Commit"
 * afterwards. That is this arc's own defect wearing the other face ([B01]).
 */
describe("the Workspaces list names a standing card by what it holds", () => {
  const SHA = "abcdef0123456789";

  test("a MOUNTED Commit card answers through the same seam a parked one does", () => {
    parkOneCard("commit", undefined);
    registerOpenCommitCard(CARD_ID, {
      getTarget: () => ({ root: "/w/repo", sha: SHA }),
    } as never);
    try {
      // No bag at all, so the durable half has nothing: this is the live
      // resolver's answer or none.
      expect(cardIdentity(CARD_ID).source).toBe("live");
      expect(DEFAULT_RESOLVERS.resolvedIdentity(CARD_ID)?.title).toBe(
        "Commit abcdef012",
      );
    } finally {
      unregisterOpenCommitCard(CARD_ID);
      registerDeckStore(null);
    }
  });

  test("and a kind that declares nothing still falls to the row's own chain", () => {
    // `null` here is what lets `resolveCard` keep `card.title ||
    // defaultTitle(componentId)`, which is the right answer for a rail.
    parkOneCard("settings", undefined);
    try {
      expect(DEFAULT_RESOLVERS.resolvedIdentity(CARD_ID)).toBeNull();
    } finally {
      registerDeckStore(null);
    }
  });
});
