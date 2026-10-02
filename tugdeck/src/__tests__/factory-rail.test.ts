/**
 * factory-rail.test.ts — the rails a factory-fresh deck stands up.
 *
 * A brand-new install has no persisted layout, so nothing tells the deck how
 * its rails are arranged: the arrangement is the factory's to write, and
 * `factoryDeckImposition` is where it is written. None of it can be read off
 * the card registry.
 *
 * The **orders are explicit** because absent means *registration* order to
 * `effectiveRailOrder`, and `main.tsx` registers jots, overview, arcs,
 * cards, layout — a different vertical order from the ones the factory
 * rails ask for. Leaving `order` off would look right at the type level and
 * stand the rails in the wrong sequence.
 *
 * Every card is **pinned to its side**: Arcs, Jots and Overview on the left,
 * Workspaces and Layout on the right, each side divided at the factory shares.
 * And the deck stands four-up, flow, at the slim content width.
 *
 * Pure over the imposition — no registry, no DOM — which is why the plan the
 * rails commit lives in its own function rather than only inside
 * `DeckManager._createFactoryRail`.
 */

import { describe, expect, test } from "bun:test";

import {
  FACTORY_RAILS,
  FACTORY_RAIL_ORDER,
  factoryDeckImposition,
} from "../deck-manager";
import type { DeckImposition } from "../lib/layout-imposer";

/** A deck that has never placed anything — a factory-fresh imposition. */
const FRESH: DeckImposition = { sidebars: {} };

describe("factoryDeckImposition", () => {
  test("stands each rail up in the factory order", () => {
    const imposition = factoryDeckImposition(FRESH);

    expect(imposition.rails?.left?.order).toEqual([
      "dashes",
      "jots",
      "overview",
    ]);
    expect(imposition.rails?.right?.order).toEqual(["cards", "layout"]);
  });

  test("divides each rail at the factory shares, one weight per member", () => {
    const imposition = factoryDeckImposition(FRESH);

    for (const side of ["left", "right"] as const) {
      const shares = imposition.rails?.[side]?.shares ?? {};
      expect(Object.keys(shares).sort()).toEqual(
        [...FACTORY_RAILS[side].order].sort(),
      );
      const sum = Object.values(shares).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(FACTORY_RAILS[side].order.length, 6);
    }
    expect(imposition.rails?.left?.shares?.overview).toBeGreaterThan(1);
    expect(imposition.rails?.right?.shares?.cards).toBeGreaterThan(1);
  });

  test("the written orders and shares are copies, not the constants", () => {
    const imposition = factoryDeckImposition(FRESH);

    // A copy, not the constant: the stored arrangement is state the deck goes
    // on to rewrite, and handing out the module's own record would let a
    // rearranged rail change what "factory" means for the rest of the session.
    for (const side of ["left", "right"] as const) {
      expect(imposition.rails?.[side]?.order).not.toBe(
        FACTORY_RAILS[side].order,
      );
      expect(imposition.rails?.[side]?.shares).not.toBe(
        FACTORY_RAILS[side].shares,
      );
    }
  });

  test("pins every card to its side", () => {
    const imposition = factoryDeckImposition(FRESH);

    expect(FACTORY_RAIL_ORDER.length).toBe(5);
    for (const side of ["left", "right"] as const) {
      for (const componentId of FACTORY_RAILS[side].order) {
        expect(imposition.sidebars[componentId]).toEqual({
          side,
          pinned: true,
        });
      }
    }
  });

  test("Workspaces heads the rail order, so it lands frontmost", () => {
    expect(FACTORY_RAIL_ORDER[0]).toBe("cards");
  });

  test("stands four-up, flow, at the slim width", () => {
    const imposition = factoryDeckImposition({
      kind: "two-up",
      contentWidth: "comfy",
      layout: "fit",
      sidebars: {},
    });

    expect(imposition.kind).toBe("four-up");
    expect(imposition.contentWidth).toBe("slim");
    expect(imposition.layout).toBe("flow");
  });

  test("leaves the columns alone", () => {
    const columns = { 0: { mode: "stack" as const } };
    const imposition = factoryDeckImposition({ sidebars: {}, columns });

    expect(imposition.columns).toEqual(columns);
  });

  test("is pure — the imposition it was handed is untouched", () => {
    const before: DeckImposition = { sidebars: {} };

    factoryDeckImposition(before);

    expect(before).toEqual({ sidebars: {} });
  });
});
