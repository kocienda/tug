/**
 * factory-rail.test.ts — the rail a factory-fresh deck stands up.
 *
 * A brand-new install has no persisted layout, so nothing tells the deck how
 * its rail is arranged: the arrangement is the factory's to write, and
 * `factoryRailImposition` is where it is written. Two facts are the whole of
 * it, and neither can be read off the card registry.
 *
 * The **order is explicit** because absent means *registration* order to
 * `effectiveRailOrder`, and `main.tsx` registers jots, overview, tripwires,
 * arcs, cards, layout — a different vertical order from the one the factory
 * rail asks for. Leaving `order` off would look right at the type level and
 * stand the rail in the wrong sequence.
 *
 * And the four cards are **pinned**, which is what puts them on
 * `DEFAULT_SIDEBAR_SIDE` on a deck that has never placed them.
 *
 * Pure over the imposition — no registry, no DOM — which is why the plan the
 * rail commits lives in its own function rather than only inside
 * `DeckManager._createFactoryRail`.
 */

import { describe, expect, test } from "bun:test";

import { FACTORY_RAIL_ORDER, factoryRailImposition } from "../deck-manager";
import type { DeckImposition } from "../lib/layout-imposer";

/** A deck that has never placed anything — a factory-fresh imposition. */
const FRESH: DeckImposition = { sidebars: {} };

describe("factoryRailImposition", () => {
  test("stands the right rail up in the factory order", () => {
    const imposition = factoryRailImposition(FRESH);

    expect(imposition.rails?.right?.order).toEqual([
      "cards",
      "dashes",
      "layout",
      "tripwires",
    ]);
  });

  test("the written order is FACTORY_RAIL_ORDER, and a copy of it", () => {
    const imposition = factoryRailImposition(FRESH);

    expect(imposition.rails?.right?.order).toEqual([...FACTORY_RAIL_ORDER]);
    // A copy, not the constant: the stored order is state the deck goes on to
    // rewrite, and handing out the module's own array would let a rearranged
    // rail change what "factory" means for the rest of the session.
    expect(imposition.rails?.right?.order).not.toBe(FACTORY_RAIL_ORDER);
  });

  test("pins all four cards, which puts them on the default side", () => {
    const imposition = factoryRailImposition(FRESH);

    for (const componentId of FACTORY_RAIL_ORDER) {
      expect(imposition.sidebars[componentId]).toEqual({
        side: "right",
        pinned: true,
      });
    }
  });

  test("leaves every other axis of the imposition alone", () => {
    const imposition = factoryRailImposition({
      kind: "two-up",
      contentWidth: "slim",
      sidebars: { jots: { side: "left" } },
      rails: { left: { order: ["jots"] } },
    });

    expect(imposition.kind).toBe("two-up");
    expect(imposition.contentWidth).toBe("slim");
    expect(imposition.sidebars.jots).toEqual({ side: "left" });
    expect(imposition.rails?.left).toEqual({ order: ["jots"] });
  });

  test("is pure — the imposition it was handed is untouched", () => {
    const before: DeckImposition = { sidebars: {} };

    factoryRailImposition(before);

    expect(before).toEqual({ sidebars: {} });
  });
});
