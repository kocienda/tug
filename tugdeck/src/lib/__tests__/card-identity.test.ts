/**
 * Coverage for `cardIdentity` — the one total function every surface that
 * names a card resolves through.
 *
 * The invariant under test is [B01]'s: a card says what it holds whether or
 * not anything of it is standing. So the cases here are about the *ladder* —
 * live before parked before the registration's own default — and about
 * totality, which is what makes the answer safe to call on any card id
 * without a null check.
 *
 * The registry and the deck store are both process-wide singletons, so each
 * test registers exactly the card types it needs and installs a deck-store
 * double holding exactly the cards it names.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  _resetForTest,
  registerCard,
  type CardIdentityFacts,
} from "@/card-registry";
import type { CardState, DeckState } from "@/layout-tree";
import type { IDeckManagerStore } from "@/deck-manager-store";
import { registerDeckStore } from "@/lib/deck-store-registry";
import { cardIdentity, parkedBagPath, parkedCardBag } from "@/lib/card-identity";
import { registerCommitCard } from "@/components/tugways/cards/commit-card";
import { registerDiffCard } from "@/components/tugways/cards/diff-card";

function card(id: string, componentId: string, title = ""): CardState {
  return { id, componentId, title, closable: true };
}

/**
 * A deck store holding `cards` in one space, with `bags` as their persisted
 * content. Only the three reads `cardIdentity` makes are implemented — the
 * rest of `IDeckManagerStore` is never reached from this path.
 */
function installDeckStore(
  cards: readonly CardState[],
  bags: Readonly<Record<string, unknown>> = {},
): void {
  const deck = { cards } as unknown as DeckState;
  const store = {
    spaceOf: (cardId: string) =>
      cards.some((c) => c.id === cardId) ? "space-1" : null,
    getSpaceDeck: (spaceId: string) => (spaceId === "space-1" ? deck : null),
    getCardState: (cardId: string) =>
      cardId in bags ? { content: bags[cardId] } : undefined,
  } as unknown as IDeckManagerStore;
  registerDeckStore(store);
}

beforeEach(() => {
  _resetForTest();
});

afterEach(() => {
  registerDeckStore(null);
  _resetForTest();
});

/** A registration whose identity resolvers are supplied per test. */
function registerProbe(opts: {
  live?: (cardId: string) => CardIdentityFacts | null;
  parked?: (cardId: string) => CardIdentityFacts | null;
  title?: string;
  icon?: string;
}): void {
  registerCard({
    componentId: "probe",
    contentFactory: () => null,
    defaultMeta: {
      title: opts.title ?? "Probe",
      icon: opts.icon ?? "Box",
      closable: true,
    },
    identity:
      opts.live === undefined && opts.parked === undefined
        ? undefined
        : { live: opts.live, parked: opts.parked },
  });
}

describe("the resolution ladder", () => {
  test("live answers first, and the parked resolver is never asked", () => {
    let parkedAsked = false;
    registerProbe({
      live: () => ({ title: "mounted.ts", path: "/w/mounted.ts" }),
      parked: () => {
        parkedAsked = true;
        return { title: "durable.ts" };
      },
    });
    installDeckStore([card("c1", "probe")]);

    const identity = cardIdentity("c1");
    expect(identity.source).toBe("live");
    expect(identity.title).toBe("mounted.ts");
    expect(identity.path).toBe("/w/mounted.ts");
    expect(parkedAsked).toBe(false);
  });

  test("parked answers when nothing is mounted", () => {
    registerProbe({
      live: () => null,
      parked: () => ({ title: "durable.ts", path: "/w/durable.ts" }),
    });
    installDeckStore([card("c1", "probe")]);

    const identity = cardIdentity("c1");
    expect(identity.source).toBe("parked");
    expect(identity.title).toBe("durable.ts");
    expect(identity.path).toBe("/w/durable.ts");
  });

  test("a registration declaring no identity still resolves", () => {
    registerProbe({ title: "Settings", icon: "Settings" });
    installDeckStore([card("c1", "probe")]);

    const identity = cardIdentity("c1");
    expect(identity.source).toBe("default");
    expect(identity.title).toBe("Settings");
    expect(identity.icon).toBe("Settings");
  });

  test("the card's own title outranks the registration's default", () => {
    registerProbe({ title: "Probe" });
    installDeckStore([card("c1", "probe", "Named by the deck")]);

    expect(cardIdentity("c1").title).toBe("Named by the deck");
  });
});

describe("totality", () => {
  test("an id no workspace holds still resolves", () => {
    registerProbe({});
    installDeckStore([card("c1", "probe")]);

    const identity = cardIdentity("nobody-holds-this");
    expect(identity.componentId).toBeNull();
    expect(identity.source).toBe("default");
    expect(identity.title).toBe("nobody-holds-this");
  });

  test("an unregistered componentId resolves to the card's own title", () => {
    installDeckStore([card("c1", "retired-kind", "Old Card")]);

    const identity = cardIdentity("c1");
    expect(identity.componentId).toBe("retired-kind");
    expect(identity.title).toBe("Old Card");
  });

  test("with no deck store registered at all", () => {
    registerDeckStore(null);
    const identity = cardIdentity("c1");
    expect(identity.componentId).toBeNull();
    expect(identity.title).toBe("c1");
  });
});

describe("the identity is settled, never partial", () => {
  test("every field is present whichever source answered", () => {
    registerProbe({ live: () => ({ title: "only a title" }) });
    installDeckStore([card("c1", "probe")]);

    expect(cardIdentity("c1")).toEqual({
      cardId: "c1",
      componentId: "probe",
      source: "live",
      title: "only a title",
      secondary: null,
      path: null,
      tugSessionId: null,
      projectDir: null,
      icon: "Box",
      unsaved: false,
    });
  });

  test("a resolver's own icon wins over the registration's", () => {
    registerProbe({ live: () => ({ title: "t", icon: "GitCommit" }) });
    installDeckStore([card("c1", "probe")]);

    expect(cardIdentity("c1").icon).toBe("GitCommit");
  });
});

describe("the durable door the parked resolvers read through", () => {
  test("the bag, when one was written", () => {
    installDeckStore([card("c1", "probe")], { c1: { path: "/w/a.ts" } });
    expect(parkedCardBag("c1")).toEqual({ path: "/w/a.ts" });
    expect(parkedBagPath("c1")).toBe("/w/a.ts");
  });

  test("null when no bag was written, and when it holds no path", () => {
    installDeckStore([card("c1", "probe"), card("c2", "probe")], {
      c2: { untitled: true, untitledNumber: 2 },
    });
    expect(parkedCardBag("c1")).toBeNull();
    expect(parkedBagPath("c1")).toBeNull();
    expect(parkedBagPath("c2")).toBeNull();
  });

  test("an empty path is no path", () => {
    installDeckStore([card("c1", "probe")], { c1: { path: "" } });
    expect(parkedBagPath("c1")).toBeNull();
  });
});

/**
 * The bag-holding kinds, against their REAL registrations.
 *
 * These are the cards [F04] named: they preserve a target through
 * `useCardStatePreservation` and had no fallback, so a parked one drew its
 * registration's own default title — "Commit", "Diff" — where the commit or
 * the file it holds should be. Each bag below is the shape the card's own
 * `onSave` writes, so what is asserted is that the resolver reads what the
 * card wrote rather than a second guess at the same shape.
 */
describe("a parked card of a bag-holding kind", () => {
  test("a Commit card is the commit it holds", () => {
    registerCommitCard();
    installDeckStore([card("c1", "commit")], {
      c1: { target: { root: "/w/repo", sha: "abcdef0123456789" } },
    });

    const identity = cardIdentity("c1");
    expect(identity.source).toBe("parked");
    expect(identity.title).toBe("Commit abcdef012");
    expect(identity.secondary, "the root tells one repo's sha from another's").toBe(
      "/w/repo",
    );
    expect(identity.title).not.toBe("Commit");
  });

  test("a Commit card whose bag holds no target falls back", () => {
    registerCommitCard();
    installDeckStore([card("c1", "commit")], { c1: { target: { root: "/w" } } });

    const identity = cardIdentity("c1");
    expect(identity.source).toBe("default");
    expect(identity.title).toBe("Commit");
  });

  test("a Diff card scoped to one file is that file, and carries its path", () => {
    registerDiffCard();
    installDeckStore([card("c1", "diff")], {
      c1: {
        descriptor: {
          kind: "commit",
          root: "/w/repo",
          sha: "abcdef0123456789",
          paths: ["src/parser/plan.rs"],
        },
      },
    });

    const identity = cardIdentity("c1");
    expect(identity.source).toBe("parked");
    expect(identity.title).toBe("plan.rs");
    expect(
      identity.path,
      "so the row files as the file it is showing, not as a nameless Files entry",
    ).toBe("/w/repo/src/parser/plan.rs");
  });

  test("a Diff card over a whole commit is that commit", () => {
    registerDiffCard();
    installDeckStore([card("c1", "diff")], {
      c1: { descriptor: { kind: "commit", root: "/w/repo", sha: "abcdef0123456789" } },
    });

    expect(cardIdentity("c1").title).toBe("Commit abcdef012");
  });

  test("a Diff card over a range is that range", () => {
    registerDiffCard();
    installDeckStore([card("c1", "diff")], {
      c1: {
        descriptor: {
          kind: "range",
          worktree: "/w/repo",
          base: "main",
          branch: "tugarc/thing",
        },
      },
    });

    expect(cardIdentity("c1").title).toBe("main…tugarc/thing");
  });

  test("a Diff card over the whole project says so", () => {
    registerDiffCard();
    installDeckStore([card("c1", "diff")], {
      c1: { descriptor: { kind: "head", root: "/w/repo" } },
    });

    const identity = cardIdentity("c1");
    expect(identity.source).toBe("parked");
    expect(identity.title).toBe("Project Diff");
    expect(identity.title).not.toBe("Diff");
  });

  test("a Diff card whose bag holds no descriptor falls back", () => {
    registerDiffCard();
    installDeckStore([card("c1", "diff")], { c1: { descriptor: { kind: "nope" } } });

    const identity = cardIdentity("c1");
    expect(identity.source).toBe("default");
    expect(identity.title).toBe("Diff");
  });
});
