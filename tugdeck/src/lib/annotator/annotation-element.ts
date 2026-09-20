/**
 * The DOM face of an annotation: stamping one onto an element, and
 * reading one back off the element a gesture landed on.
 *
 * Everything an interaction layer needs to know about an annotated
 * element is in its class and dataset, which is what lets a delegated
 * listener on the transcript root service ink it never rendered — prose
 * the annotator marked, a tool header a component stamped, a chip host
 * grafted in after the fact. They are indistinguishable here by design.
 *
 * The decision logic these functions carry out lives in `payloads.ts` and
 * is pure; this module is the thin DOM shell over it.
 *
 * @module lib/annotator/annotation-element
 */

import {
  ANNOTATION_DATASET_KEYS,
  annotationOpensSurface,
  datasetForPayload,
  payloadFromDataset,
  type AnnotationDataset,
  type AnnotationPayload,
} from "./payloads";
import { ANNOTATION_CLASS, type AnnotationKind } from "./types";

/** An annotation resolved from the DOM: the element and what it carries. */
export interface ResolvedAnnotation {
  element: HTMLElement;
  payload: AnnotationPayload;
}

/** How a stamp treats the press that lands on it. */
export interface StampOptions {
  /**
   * Whether a press on this annotation is guarded — DOM focus held off the
   * element and the host pane left unactivated. Defaults to true for the
   * kinds that open a surface, which is right for a run the annotator split
   * out of prose: it is a reference, and the card it opens claims focus.
   *
   * A surface whose annotation is a whole element of its own — a list row's
   * path — passes `false`. The guard is enforced by preventing the
   * mousedown's default, and that default is also what begins a text
   * selection: guarded, the element cannot be selected at all. A row owns
   * its own focus policy and its text stays selectable.
   */
  guardPress?: boolean;
}

/**
 * Mark `element` as an annotation carrying `payload`. Idempotent: the
 * dataset is synced, not merely added, so an element that changed kind
 * sheds the keys of the kind it left behind.
 *
 * **The shed only runs over an element that already carried an annotation.**
 * An element with no `data-tug-annotation` has no previous kind, so there is
 * nothing of this contract's to clear — and clearing anyway would reach past
 * this contract into whatever else the element's dataset holds. Two of these
 * keys (`atomId`, `atomLabel`) are spelled the same as the attributes an atom
 * chip carries in its own right, so a first stamp onto a chip used to delete
 * the label the chip is drawn and found by.
 */
export function stampAnnotation(
  element: HTMLElement,
  payload: AnnotationPayload,
  options: StampOptions = {},
): void {
  const next: AnnotationDataset = datasetForPayload(payload);
  if (element.dataset.tugAnnotation !== undefined) {
    for (const key of ANNOTATION_DATASET_KEYS) {
      if (next[key] === undefined) delete element.dataset[key];
    }
  }
  element.classList.add(ANNOTATION_CLASS);
  element.dataset.tugAnnotation = payload.kind;
  for (const [key, value] of Object.entries(next)) {
    element.dataset[key] = value;
  }
  // An annotation that opens another surface must not take focus or
  // activate its own pane on the way: the target card claims both, and
  // whatever the user was typing in keeps its caret. Stamped here rather
  // than by each surface, so every file reference is protected the same
  // way whoever produced it.
  if (annotationOpensSurface(payload.kind) && options.guardPress !== false) {
    element.dataset.tugFocus = "refuse";
    element.dataset.noActivate = "";
  } else {
    delete element.dataset.tugFocus;
    delete element.dataset.noActivate;
  }
}

/**
 * Mark `element` as an annotation of `kind` whose payload the DOM already
 * holds — the anchor case, where `href` *is* the URL or address. Stamping
 * a second copy of it into the dataset would create two places for one
 * value to live; {@link readAnnotation} reads the href instead.
 */
export function stampAnnotationKind(
  element: HTMLElement,
  kind: AnnotationKind,
): void {
  element.classList.add(ANNOTATION_CLASS);
  element.dataset.tugAnnotation = kind;
}

/**
 * Remove every trace of an annotation from `element`. Safe on an element
 * that never carried one.
 */
export function clearAnnotation(element: HTMLElement): void {
  if (element.dataset.tugAnnotation === undefined) return;
  element.classList.remove(ANNOTATION_CLASS);
  delete element.dataset.tugAnnotation;
  delete element.dataset.tugFocus;
  delete element.dataset.noActivate;
  for (const key of ANNOTATION_DATASET_KEYS) delete element.dataset[key];
}

/**
 * Read the annotation `element` carries, or `null` when it carries none
 * (or carries a half-stamped one — a partial payload is not actionable).
 *
 * An anchor is its own payload: `linkify-element` produces a real `<a>`
 * whose `href` already holds the URL or `mailto:` address, so the
 * annotation stamps no duplicate copy of a value the DOM is already
 * storing. This is where that asymmetry is resolved, once.
 */
export function readAnnotation(element: HTMLElement): AnnotationPayload | null {
  const kind = element.dataset.tugAnnotation as AnnotationKind | undefined;
  if (kind === undefined) return null;
  const record: AnnotationDataset = {};
  for (const key of ANNOTATION_DATASET_KEYS) {
    const value = element.dataset[key];
    if (value !== undefined) record[key] = value;
  }
  if (element instanceof HTMLAnchorElement) {
    const href = element.getAttribute("href") ?? "";
    if (kind === "url" && record.url === undefined) record.url = href;
    if (kind === "email" && record.email === undefined) {
      record.email = href.replace(/^mailto:/i, "");
    }
  }
  return payloadFromDataset(kind, record);
}

/**
 * Resolve the annotation a pointer event landed on by walking up from the
 * event target, or `null` when the gesture missed every annotation.
 */
export function annotationFromEvent(
  event: MouseEvent,
): ResolvedAnnotation | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>(`.${ANNOTATION_CLASS}`);
  if (element === null) return null;
  const payload = readAnnotation(element);
  return payload === null ? null : { element, payload };
}

/**
 * The id of the card `element` stands in — its nearest `[data-card-id]`
 * ancestor, the attribute every card frame carries — or `undefined` outside
 * any card. How a click on annotated ink names the card it was made in.
 */
export function hostCardIdOf(element: Element): string | undefined {
  return element.closest("[data-card-id]")?.getAttribute("data-card-id") ?? undefined;
}
