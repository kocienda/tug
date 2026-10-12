/**
 * PropertyStore unit tests -- Step 1.
 *
 * Tests cover:
 * - get() returns initial value for valid path
 * - get() throws for path not in schema
 * - set() updates value and fires observers with correct PropertyChange
 * - set() throws for readOnly property
 * - set() clamps number values to min/max range (e.g., set fontSize to 100 with max 72 stores 72)
 * - set() throws for invalid enum values (e.g., set fontFamily to 'comic-sans' when not in enumValues)
 * - observe() returns unsubscribe; after unsubscribe listener does not fire
 * - observe() with plain () => void callback works as useSyncExternalStore subscribe
 * - get() returns stable reference for unchanged value (same object identity)
 * - Multiple observers on same path all fire on set()
 * - Observer on path A does not fire when path B changes
 *
 * Note: This test file does not import setup-rtl because it tests only the
 * TypeScript module logic -- no React rendering needed.
 */

import { describe, it, expect } from "bun:test";
import { PropertyStore } from "@/lib/property-store";
import type { PropertyDescriptor, PropertyChange } from "@/lib/property-store";

// ---------------------------------------------------------------------------
// Test schema fixtures
// ---------------------------------------------------------------------------

const COLOR_DESCRIPTOR: PropertyDescriptor = {
  path: "style.backgroundColor",
  type: "color",
  label: "Background Color",
};

const FONT_SIZE_DESCRIPTOR: PropertyDescriptor = {
  path: "style.fontSize",
  type: "number",
  label: "Font Size",
  min: 8,
  max: 72,
};

const FONT_FAMILY_DESCRIPTOR: PropertyDescriptor = {
  path: "style.fontFamily",
  type: "enum",
  label: "Font Family",
  enumValues: ["system-ui", "monospace", "serif"],
};

const READONLY_DESCRIPTOR: PropertyDescriptor = {
  path: "meta.id",
  type: "string",
  label: "ID",
  readOnly: true,
};

function makeStore() {
  return new PropertyStore({
    schema: [
      COLOR_DESCRIPTOR,
      FONT_SIZE_DESCRIPTOR,
      FONT_FAMILY_DESCRIPTOR,
      READONLY_DESCRIPTOR,
    ],
    initialValues: {
      "style.backgroundColor": "#4f8ef7",
      "style.fontSize": 16,
      "style.fontFamily": "system-ui",
      "meta.id": "card-001",
    },
  });
}

// ---------------------------------------------------------------------------
// get() tests
// ---------------------------------------------------------------------------

describe("PropertyStore – get()", () => {
  it("returns initial value for valid path", () => {
    const store = makeStore();
    expect(store.get("style.backgroundColor")).toBe("#4f8ef7");
    expect(store.get("style.fontSize")).toBe(16);
    expect(store.get("style.fontFamily")).toBe("system-ui");
  });

  it("throws for path not in schema", () => {
    const store = makeStore();
    expect(() => store.get("style.fontWeight")).toThrow(/unknown path "style.fontWeight"/);
  });

  it("returns stable reference for unchanged value", () => {
    const objStore = new PropertyStore({
      schema: [{ path: "data.config", type: "string", label: "Config" }],
      initialValues: { "data.config": "hello" },
    });
    const first = objStore.get("data.config");
    const second = objStore.get("data.config");
    expect(first).toBe(second); // same reference (string identity)
  });

  it("returns undefined for a path with no initial value provided", () => {
    const store = new PropertyStore({
      schema: [{ path: "style.opacity", type: "number", label: "Opacity" }],
      initialValues: {},
    });
    expect(store.get("style.opacity")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// set() tests
// ---------------------------------------------------------------------------

describe("PropertyStore – set()", () => {
  it("updates value for a valid path", () => {
    const store = makeStore();
    store.set("style.backgroundColor", "#ff0000", "test");
    expect(store.get("style.backgroundColor")).toBe("#ff0000");
  });

  it("fires observers with correct PropertyChange record", () => {
    const store = makeStore();
    const changes: PropertyChange[] = [];
    store.observe("style.backgroundColor", (change) => {
      changes.push(change);
    });

    store.set("style.backgroundColor", "#ff0000", "inspector");

    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe("style.backgroundColor");
    expect(changes[0].oldValue).toBe("#4f8ef7");
    expect(changes[0].newValue).toBe("#ff0000");
    expect(changes[0].source).toBe("inspector");
  });

  it("includes source in the PropertyChange record", () => {
    const store = makeStore();
    let receivedSource = "";
    store.observe("style.fontSize", (change) => {
      receivedSource = change.source;
    });

    store.set("style.fontSize", 24, "content");
    expect(receivedSource).toBe("content");
  });

  it("throws for readOnly property", () => {
    const store = makeStore();
    expect(() => store.set("meta.id", "new-id", "test")).toThrow(
      /property "meta.id" is readOnly/
    );
  });

  it("throws for path not in schema", () => {
    const store = makeStore();
    expect(() => store.set("style.fontWeight", "bold", "test")).toThrow(
      /unknown path "style.fontWeight"/
    );
  });

  it("clamps number values to max (e.g., fontSize 100 with max 72 stores 72)", () => {
    const store = makeStore();
    store.set("style.fontSize", 100, "test");
    expect(store.get("style.fontSize")).toBe(72);
  });

  it("clamps number values to min (e.g., fontSize 2 with min 8 stores 8)", () => {
    const store = makeStore();
    store.set("style.fontSize", 2, "test");
    expect(store.get("style.fontSize")).toBe(8);
  });

  it("accepts number values within range without clamping", () => {
    const store = makeStore();
    store.set("style.fontSize", 36, "test");
    expect(store.get("style.fontSize")).toBe(36);
  });

  it("throws for invalid enum value (e.g., fontFamily 'comic-sans' not in enumValues)", () => {
    const store = makeStore();
    expect(() => store.set("style.fontFamily", "comic-sans", "test")).toThrow(
      /invalid enum value "comic-sans" for path "style.fontFamily"/
    );
  });

  it("accepts valid enum value", () => {
    const store = makeStore();
    store.set("style.fontFamily", "monospace", "test");
    expect(store.get("style.fontFamily")).toBe("monospace");
  });

  it("fires observers with clamped value, not raw input", () => {
    const store = makeStore();
    const changes: PropertyChange[] = [];
    store.observe("style.fontSize", (change) => changes.push(change));

    store.set("style.fontSize", 999, "test");

    expect(changes[0].newValue).toBe(72); // clamped to max
    expect(store.get("style.fontSize")).toBe(72);
  });
});

// ---------------------------------------------------------------------------
// observe() tests
// ---------------------------------------------------------------------------

describe("PropertyStore – observe()", () => {
  it("returns unsubscribe; after unsubscribe listener does not fire", () => {
    const store = makeStore();
    const calls: PropertyChange[] = [];
    const unsubscribe = store.observe("style.backgroundColor", (change) => {
      calls.push(change);
    });

    store.set("style.backgroundColor", "#aaaaaa", "test");
    expect(calls).toHaveLength(1);

    unsubscribe();

    store.set("style.backgroundColor", "#bbbbbb", "test");
    expect(calls).toHaveLength(1); // no new calls after unsubscribe
  });

  it("works with plain () => void callback (useSyncExternalStore subscribe pattern)", () => {
    const store = makeStore();
    let notifyCount = 0;
    const plainCallback = () => {
      notifyCount += 1;
    };

    const unsubscribe = store.observe("style.backgroundColor", plainCallback);

    store.set("style.backgroundColor", "#ff0000", "test");
    expect(notifyCount).toBe(1);

    store.set("style.backgroundColor", "#00ff00", "test");
    expect(notifyCount).toBe(2);

    unsubscribe();
    store.set("style.backgroundColor", "#0000ff", "test");
    expect(notifyCount).toBe(2); // no new calls after unsubscribe
  });

  it("multiple observers on same path all fire on set()", () => {
    const store = makeStore();
    const calls1: PropertyChange[] = [];
    const calls2: PropertyChange[] = [];
    const calls3: PropertyChange[] = [];

    store.observe("style.backgroundColor", (c) => calls1.push(c));
    store.observe("style.backgroundColor", (c) => calls2.push(c));
    store.observe("style.backgroundColor", (c) => calls3.push(c));

    store.set("style.backgroundColor", "#ff0000", "test");

    expect(calls1).toHaveLength(1);
    expect(calls2).toHaveLength(1);
    expect(calls3).toHaveLength(1);
  });

  it("observer on path A does not fire when path B changes", () => {
    const store = makeStore();
    const bgCalls: PropertyChange[] = [];
    const sizeCalls: PropertyChange[] = [];

    store.observe("style.backgroundColor", (c) => bgCalls.push(c));
    store.observe("style.fontSize", (c) => sizeCalls.push(c));

    // Change only fontSize
    store.set("style.fontSize", 24, "test");

    expect(sizeCalls).toHaveLength(1);
    expect(bgCalls).toHaveLength(0); // backgroundColor observer did not fire

    // Change only backgroundColor
    store.set("style.backgroundColor", "#ff0000", "test");

    expect(bgCalls).toHaveLength(1);
    expect(sizeCalls).toHaveLength(1); // fontSize observer did not fire again
  });

  it("throws for path not in schema", () => {
    const store = makeStore();
    expect(() => store.observe("style.fontWeight", () => {})).toThrow(
      /unknown path "style.fontWeight"/
    );
  });

  it("unsubscribe is idempotent -- calling it twice does not throw", () => {
    const store = makeStore();
    const unsubscribe = store.observe("style.backgroundColor", () => {});
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getSchema() tests
// ---------------------------------------------------------------------------

describe("PropertyStore – getSchema()", () => {
  it("returns the schema with all registered paths", () => {
    const store = makeStore();
    const schema = store.getSchema();
    const paths = schema.paths.map((d) => d.path);
    expect(paths).toContain("style.backgroundColor");
    expect(paths).toContain("style.fontSize");
    expect(paths).toContain("style.fontFamily");
    expect(paths).toContain("meta.id");
  });

  it("returns schema with correct descriptor metadata", () => {
    const store = makeStore();
    const schema = store.getSchema();
    const sizeDescriptor = schema.paths.find((d) => d.path === "style.fontSize");
    expect(sizeDescriptor).toBeDefined();
    expect(sizeDescriptor!.type).toBe("number");
    expect(sizeDescriptor!.min).toBe(8);
    expect(sizeDescriptor!.max).toBe(72);
  });
});

// ---------------------------------------------------------------------------
// onGet / onSet callback tests
// ---------------------------------------------------------------------------

describe("PropertyStore – optional callbacks", () => {
  it("onGet overrides internal map read", () => {
    const store = new PropertyStore({
      schema: [{ path: "style.fontSize", type: "number", label: "Font Size" }],
      initialValues: { "style.fontSize": 16 },
      onGet: (path) => {
        if (path === "style.fontSize") return 42; // always return 42 from external source
        return undefined;
      },
    });

    expect(store.get("style.fontSize")).toBe(42);
  });

  it("onSet is called after internal write and observer notification", () => {
    const onSetCalls: Array<{ path: string; value: unknown; source: string }> = [];
    const observerCalls: PropertyChange[] = [];

    const store = new PropertyStore({
      schema: [{ path: "style.fontSize", type: "number", label: "Font Size" }],
      initialValues: { "style.fontSize": 16 },
      onSet: (path, value, source) => {
        onSetCalls.push({ path, value, source });
      },
    });

    store.observe("style.fontSize", (change) => {
      observerCalls.push(change);
    });

    store.set("style.fontSize", 24, "test");

    // Both observer and onSet should have been called
    expect(observerCalls).toHaveLength(1);
    expect(onSetCalls).toHaveLength(1);
    expect(onSetCalls[0]).toEqual({ path: "style.fontSize", value: 24, source: "test" });
  });
});

describe("PropertyStore – acceptsPath()", () => {
  it("accepts the schema's paths and refuses others, so a probe never throws", () => {
    const store = new PropertyStore({
      schema: [{ path: "turn.t.message.m.text", type: "string", label: "text" }],
      initialValues: { "turn.t.message.m.text": "x" },
    });
    expect(store.acceptsPath("turn.t.message.m.text")).toBe(true);
    expect(store.acceptsPath("turn.t.message.m.rendered")).toBe(false);
    expect(() => store.get("turn.t.message.m.rendered")).toThrow();
  });

  it("accepts any path when paths are dynamic", () => {
    const store = new PropertyStore({ schema: [], initialValues: {}, dynamicPaths: true });
    expect(store.acceptsPath("turn.t.message.m.rendered")).toBe(true);
    expect(store.get("turn.t.message.m.rendered")).toBeUndefined();
  });
});
