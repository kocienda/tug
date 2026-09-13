/**
 * card-taxonomy.test.ts — the three kinds of card stay in their three homes.
 *
 * The Component Gallery accumulated three different kinds of thing wearing one
 * prefix: exemplary demos of established `Tug*` components (what the gallery is
 * for), app-test fixtures, and design spikes. This test is what stops that from
 * happening again — a fixture added to the gallery, or a spike registered under
 * the wrong family, fails here rather than being noticed by a reviewer some
 * months later.
 *
 * The prefix IS the taxonomy: `gallery-*` is an exemplary demo, `spike-*` is a
 * design spike, `fixture-*` is a card whose only consumer is the test harness.
 */

import { beforeAll, describe, expect, test } from "bun:test";

import {
  _resetForTest,
  getAllRegistrations,
  type CardRegistration,
} from "@/card-registry";
import { registerGalleryCards } from "@/components/tugways/cards/gallery-registrations";
import { registerSpikeCards } from "@/spikes/spike-registry";
import { registerFixtureCards } from "@/fixtures/fixture-registrations";

// bun shares module state across test files, so register from scratch.
beforeAll(() => {
  _resetForTest();
  registerGalleryCards();
  registerSpikeCards();
  registerFixtureCards();
});

/** The registry as a list — `getAllRegistrations` hands back the live Map. */
function allRegistrations(): CardRegistration[] {
  return [...getAllRegistrations().values()];
}

/** The 16 cards this cleanup moved out of the gallery. */
const MOVED_OUT_OF_GALLERY: readonly string[] = [
  "gallery-slot-layout",
  "gallery-pulse-display",
  "gallery-configure-tug",
  "gallery-session-identity",
  "gallery-transcript-registers",
  "gallery-pinned-headers",
  "gallery-commit-surfaces",
  "gallery-card-chrome",
  "gallery-changes-arcs",
  "gallery-modal-headers",
  "gallery-focus-language",
  "gallery-cycle-demo",
  "gallery-list-view-scroll-keyed",
  "gallery-markdown-1kb",
  "gallery-markdown-50kb",
  "gallery-transcript-copy",
];

describe("card taxonomy", () => {
  test("no gallery card is hidden", () => {
    // A hidden demo is a contradiction in terms: the gallery exists to be
    // browsed, so a card nobody can reach documents nothing. Hidden cards were
    // how the fixtures came to live in the gallery in the first place.
    const hidden = allRegistrations()
      .filter((reg) => reg.componentId.startsWith("gallery-"))
      .filter((reg) => reg.hidden === true)
      .map((reg) => reg.componentId);
    expect(hidden).toEqual([]);
  });

  test("every fixture is hidden and in the fixture family", () => {
    const fixtures = allRegistrations().filter((reg) =>
      reg.componentId.startsWith("fixture-"),
    );
    expect(fixtures.length).toBe(6);
    for (const reg of fixtures) {
      expect(reg.hidden, `${reg.componentId} must be hidden`).toBe(true);
      expect(reg.family).toBe("fixture");
    }
  });

  test("nothing moved out of the gallery is still registered there", () => {
    // registerCard OVERWRITES a duplicate componentId rather than failing, so a
    // move split across two commits can leave both registrations alive with the
    // second silently winning — and every other test still passing. This is the
    // assertion that catches that.
    const ids = new Set(allRegistrations().map((reg) => reg.componentId));
    const survivors = MOVED_OUT_OF_GALLERY.filter((id) => ids.has(id));
    expect(survivors).toEqual([]);
  });

  test("every spike registers under the spike family", () => {
    const spikes = allRegistrations().filter((reg) =>
      reg.componentId.startsWith("spike-"),
    );
    expect(spikes.length).toBeGreaterThan(0);
    for (const reg of spikes) {
      expect(reg.family).toBe("spike");
      expect(reg.acceptsFamilies).toEqual(["spike"]);
    }
  });

  test("every id an app-test seeds resolves to a registration", () => {
    // seedDeckState resolves componentIds against the live registry, so a
    // renamed card whose seed site was missed shows up as a card that will not
    // mount. These are the ids the app-tests name; they are pinned here so the
    // rename stays honest without needing the real app to say so.
    const SEEDED_BY_APP_TESTS = ["spike-session-identity"];
    for (const componentId of SEEDED_BY_APP_TESTS) {
      const reg = allRegistrations().find((r) => r.componentId === componentId);
      expect(reg, `${componentId} must be registered`).toBeDefined();
      expect(reg?.contentFactory).toBeTypeOf("function");
    }
  });

  test("the spikes index card is registered and mountable", () => {
    const home = allRegistrations().find(
      (reg) => reg.componentId === "spike-home",
    );
    expect(home).toBeDefined();
    expect(home?.contentFactory).toBeTypeOf("function");
    expect(home?.defaultMeta.title).toBe("Spikes");
  });
});
