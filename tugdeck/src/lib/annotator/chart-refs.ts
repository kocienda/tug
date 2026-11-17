/**
 * `chart-refs` — a chart's refs, resolved through the one gate.
 *
 * A chart names the things its rows are about in typed refs
 * (`commit:63de5762a`, `file:src/app.ts`, `session:048e4155`, `arc:<name>`),
 * and the renderer writes each one onto the element that stands for it as
 * `data-tugx-ref`: an atom in a Table view cell, and (later) a mark's hit
 * path. Nothing about a ref is trusted for being written. Whether it becomes
 * a link is decided here, by the same resolvers prose goes through, so a
 * chart can name a file that is gone, a commit from another repository, or a
 * session nobody has, and the reader sees it as written and claimed neither
 * way.
 *
 * A confirmed ref is stamped with the ordinary annotation contract
 * (`tugx-annotation`, `data-tug-annotation`, the payload's dataset), which is
 * the whole reason no interaction layer needed a change: the transcript's
 * delegated click, its context menu and the portals that draw commit pills
 * and session chips find a chart ref exactly as they find a prose run.
 *
 * The pass runs inside `annotateElement`, after the prose scan, so it files
 * the verdict keys it consulted with the container's and a late answer
 * re-marks it like any other ink ([P06]).
 *
 * @module lib/annotator/chart-refs
 */

import { refKindOf, refLabel, refValueOf } from "@/lib/chart/chart-table-refs";

import { clearAnnotation, stampAnnotation } from "./annotation-element";
import { detectPathReference, type PathReference } from "./detect-path-reference";
import { classifyInlineCode, payloadForReference, type AnnotationPayload } from "./payloads";
import { ANNOTATION_CLASS, type AnnotationContext } from "./types";
import { hasUrlScheme } from "./url-grammar";
import { NO_SCAN_ATTRIBUTE } from "./wrap-matches";

/** The attribute a ref host carries its ref in. */
export const REF_ATTR = "data-tugx-ref";
/** On a row-ref host: the table row whose label rule it lights. */
export const REF_ROW_ATTR = "data-tugx-ref-row";
/** On an actionable set host: a set with members a press can list. */
export const REF_SET_ATTR = "data-tugx-ref-set";
/** On a set host: the prefix its members share. */
export const REF_KIND_ATTR = "data-tugx-ref-kind";
/**
 * On a set host whose press asks the recipe for something other than the
 * set's own members: `one` for a dot's run or a span's stage, a report of
 * one row; `row` for a row across all its series; `runs` for a file's whole
 * run history.
 */
export const REF_REPORT_ATTR = "data-tugx-ref-report";
/** On a ref host: the words the atom reads as, kept so an emptied host can be refilled. */
export const REF_LABEL_ATTR = "data-tugx-ref-label";
/** On a `.tgl` label rule: its row's ref is confirmed or is a set with members. */
export const REF_LIVE_ATTR = "data-tugx-ref-live";
/** On a chart figure: at least one ref is confirmed or is an actionable set. */
export const CHART_LINKED_ATTR = "data-tugx-chart-linked";
/** On a subtree the prose text scan must not read ([P05]); the scan's own constant. */
export const NO_SCAN_ATTR = NO_SCAN_ATTRIBUTE;
/**
 * On the host a set's report is portaled into, holding the report's id.
 * Everything under it is the report's own React tree.
 */
export const REPORT_HOST_ATTR = "data-tugx-chart-report";

/**
 * Whether `el` stands in a report that lies inside `container`: the report
 * is an island its own component owns, and a pass handed `container` must
 * leave it alone. A row of the report mounts markdown with its own
 * annotation pass and its own portals, so the figure's pass re-reading those
 * marks would unwrap ink React owns and mount a second pill into a host that
 * is already filled. A surface whose own container is inside the report is
 * unaffected: its report host is not inside its container.
 */
export function insideReport(container: Element, el: Element): boolean {
  const host = el.closest(`[${REPORT_HOST_ATTR}]`);
  return host !== null && host !== container && container.contains(host);
}

/**
 * The words a portal saves before it empties a host. A commit pill and a
 * session chip both take the host's text and fill it themselves; a ref that
 * stops resolving drops its portal and needs its words back.
 */
const PORTAL_TEXT_ATTRS = ["data-tugx-commit-text", "data-tugx-session-text"] as const;

/** A ref read apart: its prefix and its value. */
export interface ParsedRef {
  kind: "commit" | "file" | "dir" | "session" | "arc" | "url" | "command";
  value: string;
}

const MAX_REF_TEXT = 512;
const MAX_ARC_NAME = 120;

/** Whether `value` holds a C0 control character or DEL, which no link may carry. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isSessionValue(v: string): boolean {
  if (/^[0-9a-f]{8}$/i.test(v)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return true;
  const slash = v.indexOf("/");
  if (slash <= 0 || slash === v.length - 1) return false;
  return !v.slice(slash + 1).includes("/") && !/\s/.test(v);
}

/**
 * Parse `ref` by the spec's rules, or `null` when it is not one the engine
 * would have accepted. The engine validated the spec already; reading it
 * again here means a hand-written `data-tugx-ref` cannot reach a resolver
 * with a value no resolver was built for.
 */
export function parseRef(ref: string): ParsedRef | null {
  const kind = refKindOf(ref);
  const value = refValueOf(ref);
  switch (kind) {
    case "commit":
      return /^[0-9a-f]{4,40}$/i.test(value) ? { kind, value } : null;
    case "file":
    case "dir":
    case "command":
      return value !== "" && !/[\n\r\0]/.test(value) && [...value].length <= MAX_REF_TEXT ? { kind, value } : null;
    case "session":
      return isSessionValue(value) ? { kind, value } : null;
    case "arc":
      return value.length <= MAX_ARC_NAME && /^[a-z0-9][a-z0-9-]*$/.test(value) ? { kind, value } : null;
    case "url":
      return /^https?:\/\/\S+$/.test(value) && !hasControlCharacter(value) && hasUrlScheme(value)
        ? { kind, value }
        : null;
    default:
      return null;
  }
}

/**
 * The payload `ref` earns, `"pending"` while a resolver's answer is out (the
 * key is noted, so the batch that answers it re-marks the host), or `null`
 * when it names nothing actionable here.
 *
 * A context with nobody to ask (`unanswerable`, the share page) resolves
 * nothing, so every ref there is shown as written.
 *
 * An arc's payload is rooted at `commitRoot`, as a prose `arc:<name>` is: a
 * surface bound to no repository has no root to open a join commit in, and
 * marks no arc.
 */
export function payloadForRef(ref: string, context: AnnotationContext): AnnotationPayload | "pending" | null {
  if (context.unanswerable === true) return null;
  const parsed = parseRef(ref);
  if (parsed === null) return null;
  const { kind, value } = parsed;
  switch (kind) {
    case "commit": {
      const root = context.commitRoot;
      if (root === null) return null;
      const verdict = context.resolveCommit(value);
      if (verdict.state === "confirmed") return { kind: "commit-sha", sha: value, root, paths: verdict.paths };
      return verdict.state === "missing" ? null : "pending";
    }
    case "file":
    case "dir": {
      const reference = pathReferenceForRef(value);
      if (reference === null) return null;
      const verdict = context.resolvePath(reference);
      if (verdict.state === "confirmed") return payloadForReference(reference, verdict);
      return verdict.state === "missing" ? null : "pending";
    }
    case "session": {
      if (context.resolveSession === undefined) return null;
      const verdict = context.resolveSession(value);
      if (verdict.state === "confirmed") return { kind: "session", target: verdict.sessionId };
      return verdict.state === "pending" ? "pending" : null;
    }
    case "arc": {
      const root = context.commitRoot;
      if (context.resolveArc === undefined || root === null) return null;
      const verdict = context.resolveArc(value);
      if (verdict.state === "confirmed") {
        return verdict.fate === "joined" && verdict.joinSha !== undefined
          ? { kind: "arc", name: value, root, joinSha: verdict.joinSha }
          : { kind: "arc", name: value, root };
      }
      return verdict.state === "pending" ? "pending" : null;
    }
    case "url":
      return { kind: "url", url: value };
    case "command": {
      const payload = classifyInlineCode(value, context.isKnownSlashCommand, context.resolvePath);
      return payload !== null && (payload.kind === "slash-command" || payload.kind === "shell-command")
        ? payload
        : null;
    }
  }
}

/**
 * The path a `file:` or `dir:` ref names. The prose grammar reads it first,
 * which keeps a line citation (`app.ts:12`) and refuses a value with a space
 * in it. A whitespace-free value that grammar declines is shaped like a word
 * (a top-level directory, `tugrust`), and in prose that doubt is real; here
 * the prefix has already said it is a path, so it is asked about as one,
 * relative to the cwd.
 */
function pathReferenceForRef(value: string): PathReference | null {
  const reference = detectPathReference(value);
  if (reference !== null) return reference;
  if (/\s/.test(value)) return null;
  const path = value.replace(/\/+$/, "");
  return path === "" ? null : { path, shape: "path" };
}

/**
 * What a press on a session mark will do, as the bubble reads it: `raise`
 * fronts the card holding the session, `resume` seats it, `null` is neither.
 * Read at show time by the caller, which has the stores; this module has only
 * the words.
 */
export type SessionActKind = "raise" | "resume" | null;

/** The last segment of a path, with any trailing separators ignored. */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 && slash < trimmed.length - 1 ? trimmed.slice(slash + 1) : trimmed;
}

/** A link's host, `www.` dropped, or the link itself when it does not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * The line the hover bubble's foot says over a stamped mark: what a press on
 * it does (Spec S06). A session's line is read from the act the press would
 * take now, so the words and the click agree; with no act the line says why
 * the press does nothing, which is the visible reason [L31] asks for. Null
 * for a kind no chart ref is.
 */
export function refActionLabel(payload: AnnotationPayload, sessionAct: SessionActKind): string | null {
  switch (payload.kind) {
    case "file-path":
      return `Open ${basename(payload.path)}`;
    case "directory":
      return `Show ${basename(payload.path)} in Finder`;
    case "commit-sha":
      return `Open commit:${payload.sha.slice(0, 8)}`;
    case "session":
      return sessionAct === "raise" ? "Go to session" : sessionAct === "resume" ? "Resume session" : "Session not open here";
    case "arc":
      return payload.joinSha !== undefined ? "Open the join commit" : `Show ${payload.name} in Arcs`;
    case "url":
      return `Open ${hostOf(payload.url)}`;
    case "slash-command":
    case "shell-command":
      return "Put the command in the prompt";
    default:
      return null;
  }
}

/** Every element in `container`, itself included, that matches `selector`. */
function selfAndBelow<T extends Element>(container: Element, selector: string): T[] {
  const found = Array.from(container.querySelectorAll<T>(selector));
  if (container.matches(selector)) found.unshift(container as unknown as T);
  return found;
}

/**
 * Put a ref host back to plain text: no annotation, and its own words in it.
 *
 * A stamped HTML host may hold a portal's children — a commit pill, a session
 * chip — and those are React's to remove. Writing into the host would take
 * them out from under React, whose unmount then throws. So the host is
 * replaced by a shallow copy with its words put back, and the portal unmounts
 * from the element it mounted into, now detached. The same move
 * `dropStaleWraps` makes for a prose run, for the same reason.
 */
function unmark(host: HTMLElement | SVGElement): void {
  if (host.dataset.tugAnnotation === undefined) return;
  if (host instanceof SVGElement) {
    clearAnnotation(host);
    return;
  }
  const fresh = host.cloneNode(false) as HTMLElement;
  clearAnnotation(fresh);
  for (const attr of PORTAL_TEXT_ATTRS) fresh.removeAttribute(attr);
  fresh.textContent = host.getAttribute(REF_LABEL_ATTR) ?? refLabel(host.getAttribute(REF_ATTR) ?? "");
  host.replaceWith(fresh);
}

/**
 * Resolve every `[data-tugx-ref]` host under `container` and stamp or clear
 * it, then say on each chart figure there which row rules are live and
 * whether the figure links anywhere at all.
 *
 * Idempotent: a host already stamped with the same payload is stamped again
 * to the same dataset, and one whose answer is now refuted is cleared. A
 * `pending` answer clears nothing: a reconnect drops every cached answer, and
 * unmarking on pending would blink every atom on every reconnect.
 */
export function annotateChartRefs(container: HTMLElement, context: AnnotationContext): void {
  const hosts = selfAndBelow<HTMLElement | SVGElement>(container, `[${REF_ATTR}]`).filter(
    (host) => !insideReport(container, host),
  );
  if (hosts.length === 0 && container.querySelector(`[${REF_SET_ATTR}]`) === null) return;
  for (const host of hosts) {
    const payload = payloadForRef(host.getAttribute(REF_ATTR) ?? "", context);
    if (payload === null) unmark(host);
    else if (payload === "pending") continue;
    else stampAnnotation(host, payload, { guardPress: true });
  }
  const figures = new Set<Element>(selfAndBelow(container, ".tugx-chart"));
  const enclosing = container.closest(".tugx-chart");
  if (enclosing !== null) figures.add(enclosing);
  for (const figure of figures) markFigure(figure);
}

/** A host that a press can act on: a confirmed ref, or a set with members. */
function isLive(host: Element): boolean {
  return host.classList.contains(ANNOTATION_CLASS) || host.hasAttribute(REF_SET_ATTR);
}

function markFigure(figure: Element): void {
  const liveRows = new Set<string>();
  let linked = false;
  for (const host of figure.querySelectorAll(`[${REF_ATTR}], [${REF_SET_ATTR}]`)) {
    if (!isLive(host)) continue;
    linked = true;
    const row = host.getAttribute(REF_ROW_ATTR);
    if (row !== null) liveRows.add(row);
  }
  for (const rule of figure.querySelectorAll(".tgl[data-row]")) {
    rule.toggleAttribute(REF_LIVE_ATTR, liveRows.has(rule.getAttribute("data-row") ?? ""));
  }
  figure.toggleAttribute(CHART_LINKED_ATTR, linked);
}
