/**
 * The overlay's drawing of what a drag indicates: the outline of the zone a
 * release would land in, the title band a tab or a card would merge onto,
 * the guides the host snapped a step to, the ghost of a tab dragged past its
 * own bar ([B08]), and the width a rail width drag's release would commit.
 *
 * The shell computes every one of them — from the zones it enumerated when
 * the drag began and the pointer the host or the card's page reported — and
 * sends the answer as `overlay.indication`, in viewport points. This page
 * only draws: one element per kind, created on demand, moved by writing its
 * style, removed when the answer says none ([L06]). None of it is a moving
 * card's rect: a zone and a band are places, which stand still while the
 * card in hand moves over them, and the ghost and the readout are drawn at
 * the pointer. The readout alone outlives its answer: it fades once the hand
 * lets go, and is removed when the fade is done. Drawn here, it stands above
 * every card's view — a rail's own members included — which a pill in the
 * shell's canvas, beneath every view, could not.
 *
 * @module overlay/overlay-indication
 */

import "../components/tugways/tug-tab-bar.css";
import "../components/tugways/tug-pane.css";

import type { OverlayIndication, OverlayReadout, OverlayRect, OverlayZone } from "../bus/declarations/overlay";
import { layoutPxOf } from "../lib/page-zoom-store";
import { getTugTiming } from "../lib/scale-timing";

/** The zone outline's class — the one the shell's canvas drew under before ([P09]). */
export const ZONE_CLASS = "tug-drop-zone-indicator";
/** The merge band's class: the band a release would merge onto, outlined as a zone is. */
export const BAND_CLASS = "tug-merge-band-indicator";
const GUIDE_X_CLASS = "snap-guide-line snap-guide-line-x";
const GUIDE_Y_CLASS = "snap-guide-line snap-guide-line-y";
const GHOST_CLASS = "tug-tab-ghost";
/** The rail width readout's class. */
export const READOUT_CLASS = "tug-rail-readout";
/** How long the readout takes to fade once the hand lets go, at a timing of
 *  1. Stated here only: the pill carries it as `--tugx-rail-readout-fade`,
 *  which the stylesheet's transition reads and scales by `--tug-timing`. */
const READOUT_FADE_MS = 400;
/** Where the pill stands from the pointer, layout px: beside it and above. */
const READOUT_OFFSET_X = 14;
const READOUT_OFFSET_Y = -34;

/** The one element of `className` under `root`, made when `want`, removed when not. */
function element(root: HTMLElement, slot: string, className: string, want: boolean): HTMLElement | null {
  const existing = root.querySelector<HTMLElement>(`:scope > [data-indication="${slot}"]`);
  if (!want) {
    existing?.remove();
    return null;
  }
  if (existing !== null) return existing;
  const el = document.createElement("div");
  el.className = className;
  el.dataset.indication = slot;
  root.appendChild(el);
  return el;
}

/** Write `rect`, in viewport points, onto `el` as a box in `root`'s layout px. */
function placeBox(el: HTMLElement, rect: OverlayRect, origin: DOMRect): void {
  el.style.left = `${layoutPxOf(rect.x - origin.left)}px`;
  el.style.top = `${layoutPxOf(rect.y - origin.top)}px`;
  el.style.width = `${layoutPxOf(rect.width)}px`;
  el.style.height = `${layoutPxOf(rect.height)}px`;
}

/**
 * The zone outline's clip: its own box with a hole for everything standing
 * over it (even-odd), in the outline's layout px — the rail's panel shows
 * where the outline runs on behind it, as it did when the two shared a page
 * and the rail outranked it. None when nothing stands over it.
 */
export function zoneClipOf(zone: OverlayZone): string {
  const holes = zone.under
    .map((u) => ({
      left: Math.max(u.x, zone.x) - zone.x,
      top: Math.max(u.y, zone.y) - zone.y,
      right: Math.min(u.x + u.width, zone.x + zone.width) - zone.x,
      bottom: Math.min(u.y + u.height, zone.y + zone.height) - zone.y,
    }))
    .filter((h) => h.right > h.left && h.bottom > h.top);
  if (holes.length === 0) return "";
  const px = (v: number): string => `${layoutPxOf(v)}px`;
  const w = px(zone.width);
  const h = px(zone.height);
  const ring = [`0px 0px`, `${w} 0px`, `${w} ${h}`, `0px ${h}`, `0px 0px`];
  for (const hole of holes) {
    const l = px(hole.left);
    const t = px(hole.top);
    const r = px(hole.right);
    const b = px(hole.bottom);
    ring.push(`${l} ${t}`, `${l} ${b}`, `${r} ${b}`, `${r} ${t}`, `${l} ${t}`, `0px 0px`);
  }
  return `polygon(evenodd, ${ring.join(", ")})`;
}

/** Draw `indication` in `root`, the page's overlay root: exactly what it says, and nothing it does not. */
export function paintIndication(root: HTMLElement, indication: OverlayIndication): void {
  const origin = root.getBoundingClientRect();
  const zone = element(root, "zone", ZONE_CLASS, indication.zone !== null);
  if (zone !== null && indication.zone !== null) {
    placeBox(zone, indication.zone, origin);
    zone.style.clipPath = zoneClipOf(indication.zone);
  }
  const band = element(root, "band", BAND_CLASS, indication.band !== null);
  if (band !== null && indication.band !== null) placeBox(band, indication.band, origin);
  const { x, y } = indication.guides;
  const guideX = element(root, "guide-x", GUIDE_X_CLASS, x !== null);
  if (guideX !== null && x !== null) guideX.style.left = `${layoutPxOf(x - origin.left)}px`;
  const guideY = element(root, "guide-y", GUIDE_Y_CLASS, y !== null);
  if (guideY !== null && y !== null) guideY.style.top = `${layoutPxOf(y - origin.top)}px`;
  const ghost = element(root, "ghost", GHOST_CLASS, indication.ghost !== null);
  if (ghost !== null && indication.ghost !== null) {
    placeBox(ghost, indication.ghost, origin);
    if (ghost.textContent !== indication.ghost.label) ghost.textContent = indication.ghost.label;
  }
  paintReadout(root, indication.readout, origin);
}

/**
 * The readout pill: written beside the pointer while the answer carries one,
 * and let go when it does not — marked leaving, out of the readout's slot so
 * a drag that starts during the fade gets a pill of its own, its limit's ink
 * dropped, and removed once its fade is done.
 */
function paintReadout(root: HTMLElement, readout: OverlayReadout | null, origin: DOMRect): void {
  const existing = root.querySelector<HTMLElement>(`:scope > [data-indication="readout"]`);
  if (readout === null) {
    if (existing === null) return;
    existing.dataset.indication = "readout-leaving";
    existing.removeAttribute("data-limit");
    existing.setAttribute("data-leaving", "");
    setTimeout(() => existing.remove(), READOUT_FADE_MS * getTugTiming() + 50);
    return;
  }
  const pill = element(root, "readout", READOUT_CLASS, true);
  if (pill === null) return;
  if (existing === null) {
    pill.style.setProperty("--tugx-rail-readout-fade", `${READOUT_FADE_MS}ms`);
    pill.setAttribute("aria-hidden", "true");
  }
  if (pill.textContent !== readout.text) pill.textContent = readout.text;
  if (readout.limit === null) pill.removeAttribute("data-limit");
  else pill.setAttribute("data-limit", readout.limit);
  pill.style.left = `${layoutPxOf(readout.x - origin.left) + READOUT_OFFSET_X}px`;
  pill.style.top = `${layoutPxOf(readout.y - origin.top) + READOUT_OFFSET_Y}px`;
}
