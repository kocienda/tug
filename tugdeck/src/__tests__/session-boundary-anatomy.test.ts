/**
 * `SessionBoundary` — one anatomy, three times.
 *
 * The three transcript rows where the ground moves (a compaction swaps the
 * context, a stage rotation swaps the claude session, a join swaps the base)
 * render one shape. Nothing pinned that before this arc, which is how the join
 * came to wear a command's outcome idiom at a different indent.
 *
 * ## Why this is element-tree assertions and not a render test
 *
 * The project ships no in-process DOM substrate — fake-DOM / RTL tests are
 * banned outright, so "does the bar look right" is an app-test's question and
 * `at0106` / `at0474` / `at0480` ask it against the real app. What IS a
 * pure-logic concern, and what this file pins, is the element tree
 * `SessionBoundary` returns: a plain function over props, called directly.
 *
 * Three claims, and each has a defect behind it that this shape prevents:
 *
 *  1. **One root slot.** All three kinds render `data-slot="session-boundary"`
 *     and differ only in `data-boundary`, so a surface can address "a
 *     boundary" rather than three unrelated wrappers.
 *  2. **A chevron only where something folds.** A fold is wrapped in
 *     `ToolBlockHistoryCollapse`; no fold means the bare chrome, so a stage
 *     never offers a toggle that would reveal nothing.
 *  3. **The event rides the identity run, not the strip's name slot, and the
 *     accessible name rides `ariaName`.** This is the pair that makes [B03]'s
 *     flush wrap possible: the name slot would give the detail a left edge of
 *     its own and a wrapped join subject would hang under it. Moving the event
 *     to `toolName` would look identical on a one-line row and break the wrap
 *     silently — and would also be the only thing keeping the row's
 *     accessible identity, so the two are pinned together. The PIXEL half of
 *     [B03] (a second line beginning at the event's x) is measurement and
 *     belongs to the app-test that step two adds.
 */

import { describe, expect, test } from "bun:test";
import React from "react";

import {
  SessionBoundary,
  type SessionBoundaryKind,
  type SessionBoundaryProps,
} from "@/components/tugways/cards/session-boundary";
import { BlockChrome } from "@/components/tugways/blocks/block-chrome";
import { ToolBlockHistoryCollapse } from "@/components/tugways/blocks/collapse-context";

type AnyElement = React.ReactElement<Record<string, unknown>>;

/** Call the component as the pure function it is; no hooks, no DOM. */
function renderBoundary(props: SessionBoundaryProps): AnyElement {
  return SessionBoundary(props) as AnyElement;
}

function propsOf(el: AnyElement): Record<string, unknown> {
  return el.props;
}

function onlyChild(el: AnyElement): AnyElement {
  return propsOf(el).children as AnyElement;
}

/** Flatten a React node into the strings it will paint. */
function textOf(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (React.isValidElement(node)) {
    return textOf((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

/** The three kinds, with the shape each one is built with. */
const GLYPH = React.createElement("svg");

const INSTANCES: ReadonlyArray<{
  kind: SessionBoundaryKind;
  props: SessionBoundaryProps;
  folds: boolean;
  event: string;
}> = [
  {
    kind: "compaction",
    folds: true,
    event: "Session compacted",
    props: {
      kind: "compaction",
      glyph: GLYPH,
      event: "Session compacted",
      summary: { kind: "text", text: "~142k tokens" },
      fold: React.createElement("div"),
      collapseKey: "session-compaction",
    },
  },
  {
    kind: "stage",
    folds: false,
    event: "Stage",
    props: {
      kind: "stage",
      glyph: GLYPH,
      event: "Stage",
      detail: React.createElement("span", null, "review · opus · plan.md"),
    },
  },
  {
    kind: "join",
    folds: true,
    event: "Joined arc-resolve into main",
    props: {
      kind: "join",
      glyph: GLYPH,
      event: "Joined arc-resolve into main",
      detail: React.createElement("span", null, "9c4e21ab subject"),
      summary: [{ kind: "count", count: 5, noun: "file" }],
      fold: React.createElement("div"),
      collapseKey: "join-receipt",
    },
  },
];

/** The chrome under the wrapper, whether or not a collapse wraps it. */
function barOf(root: AnyElement): AnyElement {
  const inner = onlyChild(root);
  return inner.type === ToolBlockHistoryCollapse ? onlyChild(inner) : inner;
}

describe("SessionBoundary — one anatomy, three times", () => {
  test("every kind renders the one root slot, keyed by kind", () => {
    for (const instance of INSTANCES) {
      const root = renderBoundary(instance.props);
      const p = propsOf(root);
      expect(p["data-slot"]).toBe("session-boundary");
      expect(p["data-boundary"]).toBe(instance.kind);
      expect(p.className).toContain("session-boundary");
    }
  });

  test("every kind renders the one bar, with the glyph leading it", () => {
    for (const instance of INSTANCES) {
      const bar = barOf(renderBoundary(instance.props));
      expect(bar.type).toBe(BlockChrome);
      const p = propsOf(bar);
      expect(p.rootSlot).toBe("session-boundary-bar");
      expect(p.className).toBe("session-boundary-bar");
      expect(p.leading).toBe(GLYPH);
    }
  });

  test("a chevron only where something folds behind the bar", () => {
    for (const instance of INSTANCES) {
      const inner = onlyChild(renderBoundary(instance.props));
      if (instance.folds) {
        expect(inner.type).toBe(ToolBlockHistoryCollapse);
        expect(propsOf(inner).toolUseId).toBe(instance.props.collapseKey);
        expect(propsOf(inner).defaultCollapsed).toBe(true);
      } else {
        // No collapse wrapper at all — the header is the whole of the row.
        expect(inner.type).toBe(BlockChrome);
        expect(propsOf(barOf(renderBoundary(instance.props))).children).toBe(null);
      }
    }
  });

  test("the event rides the identity run and the name slot stays empty", () => {
    for (const instance of INSTANCES) {
      const p = propsOf(barOf(renderBoundary(instance.props)));
      // The strip's name column would give the detail a left edge of its own;
      // [B03] wants one inline run, so the event goes in the identity.
      expect(p.toolName).toBeUndefined();
      expect(textOf(p.identity as React.ReactNode)).toContain(instance.event);
      // …and the accessible identity the empty name slot would have cost is
      // carried explicitly, per [B09].
      expect(p.ariaName).toBe(instance.event);
    }
  });

  test("the detail follows the event inside that same run", () => {
    const join = INSTANCES[2]!;
    const p = propsOf(barOf(renderBoundary(join.props)));
    const run = textOf(p.identity as React.ReactNode);
    expect(run).toContain("Joined arc-resolve into main");
    expect(run).toContain("9c4e21ab subject");
    expect(run.indexOf("Joined")).toBeLessThan(run.indexOf("9c4e21ab"));
  });

  test("the in-turn seat marks itself, and no other seat does", () => {
    const stage = INSTANCES[1]!;
    expect(propsOf(renderBoundary(stage.props))["data-in-turn"]).toBeUndefined();
    expect(
      propsOf(renderBoundary({ ...stage.props, inTurn: true }))["data-in-turn"],
    ).toBe("");
  });

  test("a fold with no collapse key gets no collapse wrapper", () => {
    // The guard that keeps a fold from mounting collapse state under an
    // undefined key — the bar renders bare rather than keying on `undefined`.
    const inner = onlyChild(
      renderBoundary({
        kind: "join",
        glyph: GLYPH,
        event: "Joined x into main",
        fold: React.createElement("div"),
      }),
    );
    expect(inner.type).toBe(BlockChrome);
  });
});
