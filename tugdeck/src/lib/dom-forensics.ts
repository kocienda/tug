/**
 * dom-forensics — name the node, not the stack.
 *
 * **The failure this exists to end.** On 2026-09-21 the app died repeatedly
 * with WebKit's `NotFoundError: The object can not be found here.` thrown
 * from `removeChild` inside React's deletion walk. What the user could see
 * was a red banner and thirty frames of minified React recursion —
 * `Zs@vendor.js:8:99094`, `Fl@vendor.js:8:98536`, over and over — which
 * names no component, no element, and no feature. The defect (an annotator
 * pass writing `textContent` into a span React was portaling into) was
 * found by reading source, not by reading evidence, and every recurrence
 * produced the same uninformative screenshot.
 *
 * That is the real defect: **the app had no way to say what it was doing
 * when it died.** This module fixes that, for this class of fault and for
 * every future member of it.
 *
 * ## What it does
 *
 * `Node.prototype.removeChild`, `insertBefore` and `replaceChild` are the
 * three DOM mutators that throw `NotFoundError` when the tree is not shaped
 * the way the caller believes. Each is wrapped so that **on the throwing
 * path only** it captures:
 *
 *  - the parent it was called on — tag, id, classes, every `data-*`, its
 *    child count, whether it is still connected, and its ancestor chain;
 *  - the child it was asked to move or remove — the same, plus **where
 *    that child actually is**, which is the one fact that turns "not found"
 *    into a diagnosis (detached? reparented? and if so, under what?);
 *  - a breadcrumb ring of what the app did just before.
 *
 * Then it rethrows, unchanged. Nothing about the app's behaviour changes;
 * the fault simply stops being anonymous.
 *
 * **The cost is zero on the happy path.** The wrapper is a `try` around a
 * native call — no allocation, no branch on the success path, and every
 * forensic helper runs only inside `catch`. These are hot methods (React
 * calls them on every commit), and they stay hot.
 *
 * ## Breadcrumbs
 *
 * A DOM fault is almost always the *delayed* consequence of an earlier
 * mutation — something moved a node, and the crash came one commit later.
 * The throw site alone cannot show that. {@link breadcrumb} lets the known
 * hazard sites (the annotator's unwrap, the portal host hooks) leave a
 * record, so the report reads "this span was unwrapped 40ms ago by the
 * file-path arm" rather than merely "this span is empty".
 *
 * ## Durability
 *
 * The record is POSTed to `/api/client-fault`, which appends it to
 * `<instance>/Logs/client-faults.jsonl`. This is load-bearing: the user's
 * response to the red banner is **Reload**, which destroys every
 * in-memory record. A fault that is not on disk before that click is a
 * fault nobody will ever read. It is also mirrored to `console.error` and
 * parked on `window.__domForensics` for a live inspection.
 *
 * @module lib/dom-forensics
 */

/** How many breadcrumbs to retain. Bounded so an idle app costs nothing. */
const BREADCRUMB_CAP = 256;

/** How much of an element's `outerHTML` to quote. Enough to recognize it. */
const HTML_HEAD_CHARS = 300;

/** How far up to walk when describing an ancestor chain. */
const ANCESTOR_DEPTH = 10;

/** One thing the app did, kept so a later fault can point back at it. */
export interface Breadcrumb {
  /** ms since page load, so ordering and gaps are both readable. */
  at: number;
  /** Which site left it — `"annotator.unwrap"`, `"portal.mounts"`, … */
  channel: string;
  /** Anything the site thought would matter. Kept small. */
  detail: Record<string, unknown>;
}

/** A described DOM node — everything recoverable without holding the node. */
export interface NodeSketch {
  nodeType: number;
  /** `"#text"`, `"DIV"`, … */
  name: string;
  id?: string;
  className?: string;
  /** Every `data-*` on the element, which is where this app keeps identity. */
  dataset?: Record<string, string>;
  childElementCount?: number;
  childNodeCount?: number;
  isConnected: boolean;
  /** The head of `outerHTML` (or the text, for a text node). */
  htmlHead?: string;
  textHead?: string;
}

/** A complete forensic report for one fault. */
export interface DomFaultReport {
  kind: "dom-forensics";
  message: string;
  /** `"removeChild"` | `"insertBefore"` | `"replaceChild"` */
  method: string;
  at: string;
  url: string;
  /** The node the method was called ON. */
  parent: NodeSketch | null;
  /** Its ancestors, nearest first. */
  parentAncestors: string[];
  /** The node the method was asked to remove / insert / replace. */
  child: NodeSketch | null;
  /**
   * The heart of the diagnosis: where the child ACTUALLY is. `"detached"`
   * when it has no parent at all, otherwise a sketch of the parent it does
   * have — which distinguishes "someone deleted it" from "someone moved it",
   * two very different bugs that throw the identical error.
   */
  childActualParent: NodeSketch | "detached" | null;
  /** Whether the parent contains the child at all, at any depth. */
  parentContainsChild: boolean | null;
  stack: string;
  breadcrumbs: Breadcrumb[];
}

/** The breadcrumb ring. */
let crumbs: Breadcrumb[] = [];

/** Faults seen this page-load, for `window.__domForensics`. */
const faults: unknown[] = [];

/**
 * How many faults have been confirmed written to disk. Published so a
 * reader — a person or an app-test — can tell "no faults happened" from
 * "faults happened and the sink is broken", which are the two states a
 * silent fault log otherwise collapses into.
 */
let delivered = 0;

/** Installed once; a second call is a no-op. */
let installed = false;

/**
 * Leave a record that a hazardous mutation happened, so a fault a commit
 * later can point back at it.
 *
 * Keep `detail` small and already-serialized — this runs on ordinary paths,
 * not just failing ones, and must not hold DOM nodes alive.
 */
export function breadcrumb(
  channel: string,
  detail: Record<string, unknown>,
): void {
  crumbs.push({ at: Math.round(performance.now()), channel, detail });
  if (crumbs.length > BREADCRUMB_CAP) {
    crumbs = crumbs.slice(-BREADCRUMB_CAP);
  }
}

/** Describe a node without retaining it. Never throws. */
function sketch(node: Node | null | undefined): NodeSketch | null {
  if (node === null || node === undefined) return null;
  try {
    const base: NodeSketch = {
      nodeType: node.nodeType,
      name: node.nodeName,
      isConnected: node.isConnected,
      childNodeCount: node.childNodes.length,
    };
    if (node.nodeType === Node.TEXT_NODE) {
      base.textHead = (node.textContent ?? "").slice(0, HTML_HEAD_CHARS);
      return base;
    }
    if (!(node instanceof Element)) return base;

    base.childElementCount = node.childElementCount;
    if (node.id !== "") base.id = node.id;
    if (node.className !== "") base.className = String(node.className);

    // `data-*` is where this app writes identity — `data-slot`,
    // `data-tug-annotation`, `data-card-portal-slot`, `data-block-index`.
    // It is by far the most useful thing in the report, so it is captured
    // whole rather than sampled.
    const data: Record<string, string> = {};
    for (const attr of Array.from(node.attributes)) {
      if (attr.name.startsWith("data-")) data[attr.name] = attr.value;
    }
    if (Object.keys(data).length > 0) base.dataset = data;

    base.htmlHead = node.outerHTML.slice(0, HTML_HEAD_CHARS);
    return base;
  } catch {
    // A node that cannot be described must not turn a reportable fault
    // into an unreportable one.
    return { nodeType: -1, name: "(undescribable)", isConnected: false };
  }
}

/** One-line identifier for an ancestor, for the chain. */
function brief(el: Element): string {
  const id = el.id === "" ? "" : `#${el.id}`;
  const cls =
    typeof el.className === "string" && el.className !== ""
      ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
      : "";
  const slot = el.getAttribute("data-slot");
  return `${el.tagName.toLowerCase()}${id}${cls}${slot === null ? "" : `[data-slot=${slot}]`}`;
}

/** The ancestor chain, nearest first. Never throws. */
function ancestors(node: Node | null | undefined): string[] {
  const out: string[] = [];
  try {
    let cur = node?.parentElement ?? null;
    while (cur !== null && out.length < ANCESTOR_DEPTH) {
      out.push(brief(cur));
      cur = cur.parentElement;
    }
  } catch {
    // fall through with what we have
  }
  return out;
}

/** Build the report for a throwing mutation. Never throws. */
function buildReport(
  method: string,
  error: unknown,
  parent: Node,
  child: Node | null,
): DomFaultReport {
  let childActualParent: NodeSketch | "detached" | null = null;
  let parentContainsChild: boolean | null = null;
  try {
    if (child !== null) {
      childActualParent =
        child.parentNode === null ? "detached" : sketch(child.parentNode);
      parentContainsChild = parent.contains(child);
    }
  } catch {
    // leave the defaults
  }
  return {
    kind: "dom-forensics",
    message: error instanceof Error ? error.message : String(error),
    method,
    at: new Date().toISOString(),
    url: typeof location === "undefined" ? "" : location.href,
    parent: sketch(parent),
    parentAncestors: ancestors(parent),
    child: sketch(child),
    childActualParent,
    parentContainsChild,
    stack: error instanceof Error ? (error.stack ?? "") : "",
    breadcrumbs: crumbs.slice(-BREADCRUMB_CAP),
  };
}

/**
 * Send a fault to disk, to the console, and to `window.__domForensics`.
 *
 * `keepalive` is what makes the POST survive the Reload the user is about
 * to click — without it the request is cancelled with the page and the
 * record is lost, which is the exact failure this module exists to end.
 */
export function reportClientFault(report: Record<string, unknown>): void {
  try {
    faults.push(report);
    console.error("[dom-forensics]", report);
    void fetch("/api/client-fault", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
      keepalive: true,
    })
      .then(() => {
        delivered += 1;
      })
      .catch(() => {
        // Reporting a fault must never raise one.
      });
  } catch {
    // Same.
  }
}

/** What `window.__domForensics` exposes for a live look or an app-test. */
export interface DomForensicsSurface {
  faults: unknown[];
  /** Count of faults confirmed written to `client-faults.jsonl`. */
  delivered: () => number;
  breadcrumbs: () => Breadcrumb[];
  breadcrumb: typeof breadcrumb;
  report: typeof reportClientFault;
}

/**
 * Wrap the three throwing DOM mutators, and catch what escapes to the
 * window. Idempotent, and safe to call before React mounts — which is
 * where it must be called, since a fault during the first commit is as
 * worth capturing as any other.
 */
export function installDomForensics(): void {
  if (installed) return;
  if (typeof Node === "undefined") return;
  installed = true;

  const proto = Node.prototype;

  const nativeRemoveChild = proto.removeChild;
  proto.removeChild = function removeChild<T extends Node>(this: Node, child: T): T {
    try {
      return nativeRemoveChild.call(this, child) as T;
    } catch (error) {
      reportClientFault(
        buildReport("removeChild", error, this, child) as unknown as Record<
          string,
          unknown
        >,
      );
      throw error;
    }
  };

  const nativeInsertBefore = proto.insertBefore;
  proto.insertBefore = function insertBefore<T extends Node>(
    this: Node,
    node: T,
    ref: Node | null,
  ): T {
    try {
      return nativeInsertBefore.call(this, node, ref) as T;
    } catch (error) {
      // The reference node is the one that goes missing here, so it is the
      // one worth describing as the "child".
      reportClientFault(
        buildReport("insertBefore", error, this, ref) as unknown as Record<
          string,
          unknown
        >,
      );
      throw error;
    }
  };

  const nativeReplaceChild = proto.replaceChild;
  proto.replaceChild = function replaceChild<T extends Node>(
    this: Node,
    node: Node,
    child: T,
  ): T {
    try {
      return nativeReplaceChild.call(this, node, child) as T;
    } catch (error) {
      reportClientFault(
        buildReport("replaceChild", error, this, child) as unknown as Record<
          string,
          unknown
        >,
      );
      throw error;
    }
  };

  // Anything that escapes to the window is recorded too — a fault outside
  // React's boundary is still a fault, and the breadcrumb ring is just as
  // useful for it.
  window.addEventListener("error", (event) => {
    reportClientFault({
      kind: "window-error",
      message: event.message,
      source: `${event.filename}:${event.lineno}:${event.colno}`,
      stack: event.error instanceof Error ? (event.error.stack ?? "") : "",
      at: new Date().toISOString(),
      breadcrumbs: crumbs.slice(-BREADCRUMB_CAP),
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    reportClientFault({
      kind: "unhandled-rejection",
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? (reason.stack ?? "") : "",
      at: new Date().toISOString(),
      breadcrumbs: crumbs.slice(-BREADCRUMB_CAP),
    });
  });

  const surface: DomForensicsSurface = {
    faults,
    delivered: () => delivered,
    breadcrumbs: () => crumbs.slice(),
    breadcrumb,
    report: reportClientFault,
  };
  (window as unknown as { __domForensics?: DomForensicsSurface }).__domForensics =
    surface;
}
