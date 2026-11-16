/**
 * `chart-ref-light` — a chart mark and the prose naming the same thing
 * light together.
 *
 * Within one message, a prose mention of a file and the bar whose ref names
 * that file are one fact twice, and a pointer over either lights both. The
 * light is one attribute, `data-tugx-ref-lit`, set on every annotated
 * element in the message whose `entityKey` equals the hovered one's, and on
 * the label rule of a lit mark's row; leaving clears them. CSS does the
 * rest: a lit mark shows its crosshair, a lit run takes its hover face.
 *
 * **One message is one list cell.** The transcript renders each entry in
 * one `.tug-list-view-cell` (`tug-list-view.tsx` wraps every cell renderer
 * in exactly one, and an assistant turn — prose and figures alike — is one
 * renderer), so the cell is the scope. A figure outside any cell — a body
 * page of its own — scopes to itself.
 *
 * **Attached once per scope, read at event time.** A delegated
 * `pointerover`/`pointerout` pair on the cell, guarded by a `WeakSet`, serves
 * every annotation the cell will ever hold: prose the annotator marks later,
 * a figure re-rendered, a set list opened. Nothing is cached, so a recycled
 * cell is harmless. The same payload is read from the same dataset the
 * clicks read, so what lights together is what acts the same.
 *
 * Laws: [L06] the light is an attribute, never React state; [L27] the
 * listeners live as long as the cell they serve.
 *
 * @module lib/chart/chart-ref-light
 */

import { annotationFromEvent, readAnnotation } from "@/lib/annotator/annotation-element";
import { entityKey } from "@/lib/annotator/entity-key";
import { ANNOTATION_CLASS } from "@/lib/annotator/types";

/** The attribute a lit element carries. */
export const REF_LIT_ATTR = "data-tugx-ref-lit";

/** The transcript's one-message wrapper. */
const CELL_SELECTOR = ".tug-list-view-cell";

/** Scopes whose listeners are attached; a scope is attached once. */
const attached = new WeakSet<Element>();

/** The element whose light a scope is showing, if any. */
const litBy = new WeakMap<Element, Element>();

/** Clear every light in `scope`. */
function clearLight(scope: Element): void {
  if (!litBy.has(scope)) return;
  litBy.delete(scope);
  for (const el of scope.querySelectorAll(`[${REF_LIT_ATTR}]`)) el.removeAttribute(REF_LIT_ATTR);
}

/** Light every annotation in `scope` naming `key`, and the rule of each lit mark's row. */
function lightKey(scope: Element, key: string): void {
  for (const el of scope.querySelectorAll<HTMLElement | SVGElement>(`.${ANNOTATION_CLASS}`)) {
    const payload = readAnnotation(el);
    if (payload === null || entityKey(payload) !== key) continue;
    el.setAttribute(REF_LIT_ATTR, "");
    const row = el.classList.contains("tgh") ? el.getAttribute("data-row") : null;
    if (row === null) continue;
    el.closest(".tugx-chart")?.querySelector(`.tgl[data-row="${row}"]`)?.setAttribute(REF_LIT_ATTR, "");
  }
}

/**
 * Attach the light to the message `figure` stands in. Called by the chart
 * renderer for a figure that carries refs; a second call on the same
 * message is a no-op.
 */
export function attachRefLight(figure: HTMLElement): void {
  const scope = figure.closest<HTMLElement>(CELL_SELECTOR) ?? figure;
  if (attached.has(scope)) return;
  attached.add(scope);
  scope.addEventListener("pointerover", (ev) => {
    const hit = annotationFromEvent(ev);
    if (hit === null) {
      clearLight(scope);
      return;
    }
    if (litBy.get(scope) === hit.element) return;
    clearLight(scope);
    const key = entityKey(hit.payload);
    if (key === null) return;
    litBy.set(scope, hit.element);
    lightKey(scope, key);
  });
  scope.addEventListener("pointerout", (ev) => {
    const lit = litBy.get(scope);
    if (lit === undefined) return;
    const to = ev.relatedTarget;
    if (to instanceof Node && lit.contains(to)) return;
    clearLight(scope);
  });
}
