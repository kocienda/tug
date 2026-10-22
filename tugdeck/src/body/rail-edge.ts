/**
 * rail-edge.ts — a rail member's deck-facing edge as this page paints it.
 *
 * While a hand drags a rail's width, the host holds each member's page at
 * the size the press found it and draws the moving edge itself, over the
 * page: the pane's surface where the page does not reach, the border, and
 * the shadow the rail casts into its gutter (`RailView.swift`'s
 * `RailCrossing`). It asks the page for those as the press lands
 * (`onRailEdge`), and this reads them off the page's computed styles as
 * they stand then — the theme, the rail treatment and the zoom included —
 * so the host draws what the page would have.
 *
 * Colours go to the host as sRGB bytes, read through a one-pixel canvas,
 * which takes any colour syntax the page's own styles resolve to. Widths go
 * as view points: a CSS px here is the deck's zoom in points.
 *
 * @module body/rail-edge
 */

import type { RailEdge } from "../host/declarations/lifecycle";

/** `color` as four sRGB bytes, or null when the page cannot paint one. */
export function cssColorBytes(color: string): number[] | null {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const g = canvas.getContext("2d");
  if (g === null) return null;
  g.clearRect(0, 0, 1, 1);
  g.fillStyle = color;
  g.fillRect(0, 0, 1, 1);
  return [...g.getImageData(0, 0, 1, 1).data];
}

/** `value` — a colour, or a `var()` naming one — resolved where `scope` stands. */
function resolvedColor(scope: HTMLElement, value: string): string {
  const probe = document.createElement("span");
  probe.style.setProperty("display", "none");
  probe.style.setProperty("color", value);
  scope.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved;
}

/** Whether `bytes` paint anything. */
function opaque(bytes: number[] | null): bytes is number[] {
  return bytes !== null && bytes[3] > 0;
}

/**
 * The deck-facing edge of the rail member whose frame is `frame`, at the
 * deck's `zoom`; null for a frame no rail holds, or one with no chrome.
 */
export function readRailEdge(frame: HTMLElement, zoom: number): RailEdge | null {
  const side = frame.getAttribute("data-rail-side");
  if (side !== "left" && side !== "right") return null;
  const chrome = frame.querySelector<HTMLElement>(".tug-pane-chrome");
  if (chrome === null) return null;
  // A left rail faces the deck with its right edge, a right rail its left.
  const facing = side === "left" ? "right" : "left";
  const style = getComputedStyle(chrome);
  // The pane's surface is the first of its layers that paints one.
  const surface =
    [frame.querySelector<HTMLElement>(".tug-pane-content"), frame.querySelector<HTMLElement>(".tug-pane-body"), chrome]
      .map((el) => (el === null ? null : cssColorBytes(getComputedStyle(el).backgroundColor)))
      .find(opaque) ?? cssColorBytes(resolvedColor(frame, "var(--tugx-pane-bg)"));
  const rest = cssColorBytes(style.getPropertyValue(`border-${facing}-color`));
  const held = cssColorBytes(resolvedColor(frame, "var(--tugx-rail-edge-held)"));
  const limit = cssColorBytes(resolvedColor(frame, "var(--tugx-rail-edge-limit)"));
  const shadow = cssColorBytes(resolvedColor(frame, "var(--tugx-rail-shadow-color)"));
  if (surface === null || rest === null || held === null || limit === null || shadow === null) return null;
  const width = parseFloat(style.getPropertyValue(`border-${facing}-width`)) || 0;
  const reach = parseFloat(getComputedStyle(frame).getPropertyValue("--tugx-rail-shadow-reach")) || 0;
  return { surface, rest, held, limit, width: width * zoom, shadow, reach: reach * zoom };
}
