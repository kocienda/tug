/**
 * Coverage for the Cards card's group taxonomy.
 *
 * The Cards card's promise is that *every* content card on the deck has a row
 * in it. That promise is only as good as the resolution being total, so this
 * file registers the whole app's card set — the same entry points `main.tsx`
 * calls — and then asserts two things:
 *
 *   - **Totality.** Every registration resolves to a group or to the explicit
 *     `"none"` exclusion, and the rail cards are exactly the exclusions.
 *   - **The mapping.** Each known componentId lands in the group it should.
 *     Totality alone would be satisfied by resolving everything to `"tools"`;
 *     these pins are what catch a card drifting into the wrong bucket.
 *
 * A new card type added without thought still resolves (the `"tools"`
 * fallback), but it fails the mapping assertion below until someone decides
 * where it belongs — which is the point.
 */

import { beforeAll, describe, expect, test } from "bun:test";

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
import { registerGalleryCards } from "@/components/tugways/cards/gallery-registrations";
import { registerSpikeCards } from "@/spikes/spike-registry";
import { registerFixtureCards } from "@/fixtures/fixture-registrations";

import {
  GROUP_ORDER,
  GROUP_TITLES,
  orderedGroups,
  resolveCardsGroup,
} from "../cards-groups";

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
  registerGalleryCards();
  registerSpikeCards();
  registerFixtureCards();
});

/** componentId → the group it must resolve to, and how it gets there. */
const PINS: ReadonlyArray<{
  componentId: string;
  group: string;
  via: string;
}> = [
  { componentId: "session", group: "sessions", via: "explicit cardsGroup" },
  { componentId: "text", group: "files", via: "explicit cardsGroup" },
  { componentId: "file-view", group: "files", via: "explicit cardsGroup" },
  { componentId: "diff", group: "files", via: "category.label" },
  { componentId: "settings", group: "tools", via: "fallback" },
  { componentId: "keyboard", group: "tools", via: "fallback" },
  { componentId: "about", group: "tools", via: "fallback" },
  { componentId: "devtools", group: "tools", via: "fallback" },
  { componentId: "hello", group: "tools", via: "fallback" },
  { componentId: "jots", group: "none", via: "explicit cardsGroup" },
  { componentId: "overview", group: "none", via: "explicit cardsGroup" },
  { componentId: "dashes", group: "none", via: "explicit cardsGroup" },
  { componentId: "cards", group: "none", via: "explicit cardsGroup" },
  { componentId: "layout", group: "none", via: "explicit cardsGroup" },
];

describe("resolveCardsGroup — the mapping", () => {
  for (const pin of PINS) {
    test(`${pin.componentId} → ${pin.group} (${pin.via})`, () => {
      const reg = getRegistration(pin.componentId);
      expect(reg).toBeDefined();
      expect(resolveCardsGroup(reg!)).toBe(pin.group as never);
    });
  }

  test("diff resolves through its type-picker category, not a declaration", () => {
    const reg = getRegistration("diff")!;
    expect(reg.cardsGroup).toBeUndefined();
    expect(reg.category?.label).toBe("Files");
  });

  test("every gallery, spike, and fixture card lands in tools", () => {
    // All three prefixes, not just `gallery-`: when the spikes and fixtures
    // moved out under their own prefixes, a `gallery-`-only filter would have
    // gone on passing while silently covering sixteen fewer cards.
    const maker = [...getAllRegistrations().values()].filter(
      (reg) =>
        reg.componentId.startsWith("gallery-") ||
        reg.componentId.startsWith("spike-") ||
        reg.componentId.startsWith("fixture-"),
    );
    expect(maker.length).toBeGreaterThan(0);
    for (const reg of maker) {
      expect(resolveCardsGroup(reg), `${reg.componentId}`).toBe("tools");
    }
  });
});

describe("resolveCardsGroup — totality", () => {
  test("every registration resolves to a group or to none", () => {
    const registrations = [...getAllRegistrations().values()];
    expect(registrations.length).toBeGreaterThan(0);
    const legal = new Set<string>([...GROUP_ORDER, "none"]);
    for (const reg of registrations) {
      expect(legal.has(resolveCardsGroup(reg))).toBe(true);
    }
  });

  // A rail card is not deck content — it holds no slot and answers no slot
  // picker — so the list that offers to place a card must not offer it.
  test("the rail cards are exactly the cards excluded from the list", () => {
    const excluded = [...getAllRegistrations().values()]
      .filter((reg) => resolveCardsGroup(reg) === "none")
      .map((reg) => reg.componentId)
      .sort();
    expect(excluded).toEqual([
      "cards",
      "dashes",
      "jots",
      "layout",
      "overview",
    ]);
  });
});

describe("group order and titles", () => {
  test("groups render sessions, files, tools", () => {
    expect(GROUP_ORDER).toEqual(["sessions", "files", "tools"]);
  });

  test("no persisted arrangement renders the built-in order", () => {
    expect(orderedGroups([])).toEqual(GROUP_ORDER);
  });

  test("a persisted arrangement is honored", () => {
    expect(orderedGroups(["tools", "files", "sessions"])).toEqual([
      "tools",
      "files",
      "sessions",
    ]);
  });

  test("a name that is no longer a group is dropped, not rendered", () => {
    expect(orderedGroups(["files", "changesets", "sessions"])).toEqual([
      "files",
      "sessions",
      "tools",
    ]);
  });

  test("a duplicate name is taken once", () => {
    expect(orderedGroups(["files", "files", "sessions"])).toEqual([
      "files",
      "sessions",
      "tools",
    ]);
  });

  test("an unmentioned group trails the arrangement it was never part of", () => {
    expect(orderedGroups(["tools", "sessions"])).toEqual([
      "tools",
      "sessions",
      "files",
    ]);
    // Declaration order decides only among the unmentioned.
    expect(orderedGroups(["tools"])).toEqual(["tools", "sessions", "files"]);
  });

  test("every group has a title", () => {
    for (const group of GROUP_ORDER) {
      expect(GROUP_TITLES[group].length).toBeGreaterThan(0);
    }
  });
});
