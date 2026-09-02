/**
 * spatial-nav — the spatial arrow navigator over a real `FocusManager` ([P22] /
 * [P23]). Exercises `moveKeyViewSpatial` against a registered focusable set + a
 * declared ring/seam order + a live group cursor handle — no DOM (`focusKeyView`
 * no-ops headless; `setKeyView` mutates the in-memory key view, which is what these
 * assert). The pure resolver itself is pinned by `spatial-order.test.ts`; this pins
 * the engine wiring: ring/seam movement, group cursor delegation, the never-beep
 * liveliness walk at an edge, the dead-arrow warning ([R06]), and the
 * default-context path ([L26]).
 */

import { describe, expect, test } from "bun:test";

import { BASE_FOCUS_MODE, FocusManager } from "../focus-manager";
import type { SpatialCursorHandle } from "../focus-manager";
import type { SpatialDirection, SpatialOrder } from "../spatial-order";

// The PermissionDialog skeleton: a [deny, allow] button ring + a scope group below
// Allow, reached by a seam. Nodes are referenced by their stable `group:order` key
// (here group "g") — the navigator maps the ringed focusable id to its key ([Q12]).
// Groups are injected live from the handle, so the order declares only rings + seams.
const order: SpatialOrder = {
  rings: [{ axis: "horizontal", nodes: ["g:0", "g:1"], closed: true }], // deny, allow
  seams: [
    { from: "g:1", direction: "down", to: "g:2" }, // allow → scope
    { from: "g:2", direction: "up", to: "g:1" }, // scope → allow
  ],
};

// A minimal stand-in for a group's `useFocusCursor` handle — a 1D index with clamp.
function makeHandle(length: number, start = 0) {
  const state = { index: start, descendable: false, descended: 0 };
  const handle: SpatialCursorHandle = {
    length: () => length,
    cursorIndex: () => state.index,
    moveCursor: (delta) => {
      state.index = Math.max(0, Math.min(length - 1, state.index + delta));
    },
    tryDescendRight: () => {
      if (state.descendable) {
        state.descended += 1;
        return true;
      }
      return false;
    },
  };
  return { handle, state };
}

function setup() {
  const m = new FocusManager();
  const ctx = m.contextFor(null); // the default context — no key card ([L26])
  ctx.registerFocusable({ id: "deny", group: "g", order: 0 });
  ctx.registerFocusable({ id: "allow", group: "g", order: 1 });
  ctx.registerFocusable({ id: "scope", group: "g", order: 2 });
  ctx.registerSpatialOrder(BASE_FOCUS_MODE, order);
  return { m, ctx };
}

describe("moveKeyViewSpatial — ring movement", () => {
  test("Left from allow lands on deny (the reported case), reversibly", () => {
    const { m, ctx } = setup();
    ctx.setKeyView("allow", true);
    expect(m.moveKeyViewSpatial("left")).toBe(true);
    expect(m.keyView()).toBe("deny");
    // Right returns to allow — the author declared both edges (closed ring).
    expect(m.moveKeyViewSpatial("right")).toBe(true);
    expect(m.keyView()).toBe("allow");
  });

  test("a closed ring never beeps — both edges wrap and report consumed", () => {
    const { m, ctx } = setup();
    ctx.setKeyView("allow", true);
    expect(m.moveKeyViewSpatial("right")).toBe(true); // wrap → deny
    expect(m.keyView()).toBe("deny");
    expect(m.moveKeyViewSpatial("left")).toBe(true); // wrap → allow
    expect(m.keyView()).toBe("allow");
  });

  test("a declared seam crosses from the button ring to the scope group", () => {
    const { m, ctx } = setup();
    ctx.setKeyView("allow", true);
    expect(m.moveKeyViewSpatial("down")).toBe(true);
    expect(m.keyView()).toBe("scope");
  });
});

describe("moveKeyViewSpatial — group cursor delegation", () => {
  test("an in-group arrow drives the cursor and keeps the ring on the group", () => {
    const { m, ctx } = setup();
    const { handle, state } = makeHandle(2, 0);
    ctx.registerCursorHandle("scope", handle);
    ctx.setKeyView("scope", true);
    expect(m.moveKeyViewSpatial("down")).toBe(true);
    expect(m.keyView()).toBe("scope"); // ring stayed on the group
    expect(state.index).toBe(1); // cursor advanced
  });

  test("an arrow off the group edge crosses the declared seam", () => {
    const { m, ctx } = setup();
    const { handle } = makeHandle(2, 0); // cursor at the top
    ctx.registerCursorHandle("scope", handle);
    ctx.setKeyView("scope", true);
    expect(m.moveKeyViewSpatial("up")).toBe(true); // off the top → seam → allow
    expect(m.keyView()).toBe("allow");
  });

  test("a group edge in a declared scope falls back to the linear walk (liveliness)", () => {
    const { m, ctx } = setup();
    const { handle } = makeHandle(2, 1); // cursor at the bottom
    ctx.registerCursorHandle("scope", handle);
    ctx.setKeyView("scope", true);
    // Down runs off the end with no down-seam → no spatial target → the linear
    // groupOrder fallback advances: scope is last, so it wraps to the first stop.
    // The arrow never silently swallows ([P23] liveliness).
    expect(m.moveKeyViewSpatial("down")).toBe(true);
    expect(m.keyView()).toBe("deny"); // focusNext(scope=last) wraps to deny (order 0)
  });

  test("a group edge with NO declared order walks on along the linear order", () => {
    const m = new FocusManager();
    const ctx = m.contextFor(null);
    ctx.registerFocusable({ id: "list", group: "grp", order: 0 });
    ctx.registerFocusable({ id: "next-section", group: "grp", order: 1 });
    const { handle, state } = makeHandle(2, 1); // cursor at the bottom
    ctx.registerCursorHandle("list", handle);
    ctx.setKeyView("list", true);
    // No declared spatial order for this mode → the liveliness net carries the ring on
    // to the next stop in the walk (the rail's next section) instead of clamping.
    expect(m.moveKeyViewSpatial("down")).toBe(true);
    expect(m.keyView()).toBe("next-section");
    expect(state.index).toBe(1); // the cursor did not move; the ring left the group
  });

  test("a lone group with nowhere to walk holds, and still consumes", () => {
    const m = new FocusManager();
    const ctx = m.contextFor(null);
    ctx.registerFocusable({ id: "g", group: "grp", order: 0 });
    const { handle, state } = makeHandle(2, 1); // cursor at the bottom
    ctx.registerCursorHandle("g", handle);
    ctx.setKeyView("g", true);
    // The walk has one member, so it lands back on the group: nothing moves, but the
    // arrow is still consumed so the page does not scroll and the key never beeps.
    expect(m.moveKeyViewSpatial("down")).toBe(true);
    expect(m.keyView()).toBe("g");
    expect(state.index).toBe(1);
  });

  test("a vertical-axis group yields horizontal arrows to the plane ([P12])", () => {
    const { m, ctx } = setup();
    const { handle, state } = makeHandle(3, 1); // mid-cursor: a 'both' group would rove
    ctx.registerCursorHandle("scope", { ...handle, axis: "vertical" });
    ctx.setKeyView("scope", true);
    // Vertical still roves the cursor.
    expect(m.moveKeyViewSpatial("down")).toBe(true);
    expect(state.index).toBe(2);
    expect(m.keyView()).toBe("scope");
    // Left is not the cursor's: with no horizontal seam from the list it falls to
    // the liveliness net, which retreats one stop in the walk order.
    expect(m.moveKeyViewSpatial("left")).toBe(true);
    expect(state.index).toBe(2); // the cursor did not move
    expect(m.keyView()).toBe("allow"); // focusPrevious(scope) → allow
  });

  test("a 'both' group (a chip row) still roves on horizontal arrows", () => {
    const { m, ctx } = setup();
    const { handle, state } = makeHandle(3, 1);
    ctx.registerCursorHandle("scope", handle); // no axis → "both"
    ctx.setKeyView("scope", true);
    expect(m.moveKeyViewSpatial("left")).toBe(true);
    expect(state.index).toBe(0);
    expect(m.keyView()).toBe("scope");
  });

  test("ArrowRight descends a disclosable item before any spatial movement", () => {
    const { m, ctx } = setup();
    const { handle, state } = makeHandle(2, 0);
    state.descendable = true;
    ctx.registerCursorHandle("scope", handle);
    ctx.setKeyView("scope", true);
    expect(m.moveKeyViewSpatial("right")).toBe(true);
    expect(state.descended).toBe(1);
    expect(m.keyView()).toBe("scope"); // descend is the group's; the ring did not move
  });
});

describe("moveKeyViewSpatial — never-beep boundaries", () => {
  test("an arrow with no spatial target in a declared scope falls back to the linear walk", () => {
    const { m, ctx } = setup();
    ctx.setKeyView("deny", true); // deny is on the horizontal ring; Up is undeclared
    // Up has no ring (vertical) / seam / override from deny → the liveliness fallback
    // retreats one stop in groupOrder (deny is first, so it wraps to the last). The
    // arrow moves the ring and reports consumed — never a beep, never not-consumed.
    expect(m.moveKeyViewSpatial("up")).toBe(true);
    expect(m.keyView()).toBe("scope"); // focusPrevious(deny=first) wraps to scope (order 2)
  });

  test("with no declared order and no group, the arrow is not the navigator's", () => {
    const m = new FocusManager();
    const ctx = m.contextFor(null);
    ctx.registerFocusable({ id: "btn", group: "g", order: 0 });
    ctx.setKeyView("btn", true);
    for (const dir of ["up", "down", "left", "right"] as SpatialDirection[]) {
      expect(m.moveKeyViewSpatial(dir)).toBe(false);
    }
    expect(m.keyView()).toBe("btn");
  });

  test("no key view → nothing to move", () => {
    const { m } = setup();
    expect(m.moveKeyViewSpatial("left")).toBe(false);
  });
});

describe("moveKeyViewLinear — the liveliness net's walk", () => {
  test("down / right advance and up / left retreat, wrapping at both ends", () => {
    const { m, ctx } = setup(); // deny(0), allow(1), scope(2)
    ctx.setKeyView("allow", true);
    expect(m.moveKeyViewLinear("down")).toBe("scope");
    expect(m.moveKeyViewLinear("right")).toBe("deny"); // wrapped past the last
    expect(m.moveKeyViewLinear("up")).toBe("scope"); // wrapped past the first
    expect(m.moveKeyViewLinear("left")).toBe("allow");
    expect(m.keyView()).toBe("allow");
  });

  test("a registry with nothing to walk returns null", () => {
    const m = new FocusManager();
    expect(m.moveKeyViewLinear("down")).toBeNull();
    expect(m.keyView()).toBeNull();
  });

  test("a single-stop registry re-returns its one id", () => {
    const m = new FocusManager();
    const ctx = m.contextFor(null);
    ctx.registerFocusable({ id: "only", group: "g", order: 0 });
    ctx.setKeyView("only", true);
    expect(m.moveKeyViewLinear("down")).toBe("only");
    expect(m.moveKeyViewLinear("up")).toBe("only");
  });
});

describe("moveKeyViewSpatial — a descend scope above the declaring scope", () => {
  // The PermissionDialog case: the dialog pushes its trap and declares the
  // button ring under that scope; the enclosing transcript list then DESCENDS
  // into the row holding the dialog, pushing a non-trapped row scope on top.
  // The arrows still belong to the dialog's declared plane — a descend does not
  // strand them.
  function setupDescended() {
    const m = new FocusManager();
    const ctx = m.contextFor(null);
    ctx.registerFocusable({ id: "deny", group: "g", order: 0 });
    ctx.registerFocusable({ id: "allow", group: "g", order: 1 });
    ctx.registerFocusable({ id: "scope", group: "g", order: 2 });
    ctx.pushFocusMode("dialog-trap", { trapped: true });
    ctx.registerSpatialOrder("dialog-trap", order);
    ctx.pushFocusMode("list-row-1", { trapped: false });
    return { m, ctx };
  }

  test("Left from allow still lands on deny under a descend scope", () => {
    const { m, ctx } = setupDescended();
    ctx.setKeyView("allow", true);
    expect(m.moveKeyViewSpatial("left")).toBe(true);
    expect(m.keyView()).toBe("deny");
  });

  test("a trapped mode that declares no order does not borrow the plane below it", () => {
    const m = new FocusManager();
    const ctx = m.contextFor(null);
    ctx.registerFocusable({ id: "deny", group: "g", order: 0 });
    ctx.registerFocusable({ id: "allow", group: "g", order: 1 });
    ctx.registerSpatialOrder(BASE_FOCUS_MODE, order);
    ctx.pushFocusMode("sheet", { trapped: true });
    ctx.setKeyView("allow", true);
    expect(m.moveKeyViewSpatial("left")).toBe(false);
    expect(m.keyView()).toBe("allow");
  });
});

describe("key-within projection", () => {
  // An element is never its own container. A descend scope captures the key view
  // at push (`restoreKeyView`) and may then place the key view back on that same
  // node — the dialog seeds Allow, the list descends into that row and lands on
  // Allow again. Marking it key-within paints the faint within outline over the
  // crisp role ring, because `[data-key-within]` is authored last.
  test("a descend scope whose restore IS the key view projects no within mark", () => {
    const m = new FocusManager();
    const ctx = m.contextFor(null);
    ctx.registerFocusable({ id: "allow", group: "g", order: 0 });
    ctx.setKeyView("allow", true);
    ctx.pushFocusMode("list-row-1", { trapped: false });
    ctx.setKeyView("allow", true);
    expect(ctx.projectionState().keyWithinId).toBeNull();
  });

  test("a descend scope from a DIFFERENT node still marks that node", () => {
    const m = new FocusManager();
    const ctx = m.contextFor(null);
    ctx.registerFocusable({ id: "row", group: "g", order: 0 });
    ctx.registerFocusable({ id: "accessory", group: "g", order: 1 });
    ctx.setKeyView("row", true);
    ctx.pushFocusMode("list-row-1", { trapped: false });
    ctx.setKeyView("accessory", true);
    expect(ctx.projectionState().keyWithinId).toBe("row");
  });
});
