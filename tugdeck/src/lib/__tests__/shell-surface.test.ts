/**
 * The body's half of a surface the shell draws, and the two halves' shared
 * tree arithmetic: a node's path survives the bus, a patch keeps the nodes
 * that still match (so a drawn scroller keeps its position), and the mirror
 * publishes the content it is shown, clicks the node a press names, and
 * says when the surface goes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { ShellSurface } from "@tugproto/bus";
import { createSurfaceMirror, nodeAt, patchChildren, pathOf } from "../shell-surface";

const dom = new JSDOM("<!doctype html><body></body>");
const doc = dom.window.document;

const GLOBALS = ["window", "Element", "MouseEvent", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame"] as const;
const saved: Record<string, unknown> = {};
const scope = globalThis as unknown as Record<string, unknown>;

beforeAll(() => {
  for (const name of GLOBALS) saved[name] = scope[name];
  scope.window = dom.window;
  scope.Element = dom.window.Element;
  scope.MouseEvent = dom.window.MouseEvent;
  scope.MutationObserver = dom.window.MutationObserver;
  scope.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0) as unknown as number;
  scope.cancelAnimationFrame = (id: number) => clearTimeout(id);
});

afterAll(() => {
  // Restored by assignment: deleting a global slows every later file.
  for (const name of GLOBALS) scope[name] = saved[name];
});

function tree(html: string): HTMLElement {
  const root = doc.createElement("div");
  root.innerHTML = html;
  return root;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe("paths", () => {
  test("a node's path from the root leads back to it", () => {
    const root = tree("<ul><li>a</li><li><b>b</b> tail</li></ul>");
    const b = root.querySelector("b")!;
    const path = pathOf(root, b);
    expect(path).toEqual([0, 1, 0]);
    expect(nodeAt(root, path!)).toBe(b);
  });

  test("a node outside the root has no path, and a path past the tree leads nowhere", () => {
    const root = tree("<p>x</p>");
    expect(pathOf(root, doc.createElement("span"))).toBeNull();
    expect(nodeAt(root, [0, 4])).toBeNull();
  });
});

describe("patchChildren", () => {
  test("keeps every node that still matches and brings its text and attributes into line", () => {
    const target = tree('<div class="scroller" data-n="1"><span>1:00</span></div><p>old</p>');
    const scroller = target.firstChild;
    const span = target.querySelector("span");
    patchChildren(target, tree('<div class="scroller" data-m="2"><span>1:01</span><em>new</em></div>'));
    expect(target.firstChild).toBe(scroller);
    expect(target.querySelector("span")).toBe(span);
    expect(target.innerHTML).toBe('<div class="scroller" data-m="2"><span>1:01</span><em>new</em></div>');
  });

  test("replaces a node whose tag changed", () => {
    const target = tree("<p>a</p>");
    const p = target.firstChild;
    patchChildren(target, tree("<h1>a</h1>"));
    expect(target.firstChild).not.toBe(p);
    expect(target.innerHTML).toBe("<h1>a</h1>");
  });
});

describe("createSurfaceMirror", () => {
  const meta = { title: "Time", className: "session-telemetry-status-placard", growth: "up" as const, anchorX: 300, lineY: 580 };

  test("publishes the content on show, again when it changes, and null on release", async () => {
    const sent: Array<ShellSurface | null> = [];
    const mirror = createSurfaceMirror((s) => sent.push(s));
    const content = tree("<span>1:00</span>");
    const release = mirror.show(content, () => meta, () => {});
    expect(sent).toEqual([{ ...meta, html: "<span>1:00</span>", scroll: [] }]);
    content.querySelector("span")!.textContent = "1:01";
    await tick();
    expect(sent[sent.length - 1]).toEqual({ ...meta, html: "<span>1:01</span>", scroll: [] });
    release();
    expect(sent[sent.length - 1]).toBeNull();
    content.querySelector("span")!.textContent = "1:02";
    await tick();
    expect(sent[sent.length - 1]).toBeNull();
  });

  test("publishes again when the page's viewport moves the line, and only then", async () => {
    const sent: Array<ShellSurface | null> = [];
    const mirror = createSurfaceMirror((s) => sent.push(s));
    let lineY = 580;
    const release = mirror.show(tree("<span>1:00</span>"), () => ({ ...meta, lineY }), () => {});
    dom.window.dispatchEvent(new dom.window.Event("resize"));
    await tick();
    expect(sent.length).toBe(1);
    lineY = 420;
    dom.window.dispatchEvent(new dom.window.Event("resize"));
    await tick();
    expect(sent[sent.length - 1]).toEqual({ ...meta, lineY: 420, html: "<span>1:00</span>", scroll: [] });
    release();
    lineY = 300;
    dom.window.dispatchEvent(new dom.window.Event("resize"));
    await tick();
    expect(sent[sent.length - 1]).toBeNull();
  });

  test("clicks the node a press names, and runs the dismissal the shell asks for", () => {
    const mirror = createSurfaceMirror(() => {});
    const content = tree('<div><button type="button">#a2</button></div>');
    const button = content.querySelector("button")!;
    let clicks = 0;
    button.addEventListener("click", () => clicks++);
    let dismissed = 0;
    mirror.show(content, () => meta, () => dismissed++);
    mirror.activate(pathOf(content, button.firstChild!)!);
    expect(clicks).toBe(1);
    mirror.dismiss();
    expect(dismissed).toBe(1);
  });

  test("a release after a newer show leaves the newer surface standing", () => {
    const sent: Array<ShellSurface | null> = [];
    const mirror = createSurfaceMirror((s) => sent.push(s));
    const releaseOld = mirror.show(tree("old"), () => meta, () => {});
    mirror.show(tree("new"), () => meta, () => {});
    releaseOld();
    expect(sent.map((s) => s?.html ?? null)).toEqual(["old", "new"]);
  });
});
