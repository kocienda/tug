/**
 * The path-face audit — the mechanical check that nothing has regrown a
 * second clock.
 *
 * One sentence is the whole spec: *a path in ink acts like the file it
 * names, as that file is right now.* Its observable consequence is narrower
 * and checkable — **one path, one face**: every mention of one file, on one
 * surface, in one frame, is either all marked or all plain. A reader who
 * sees `notes/a.md` lit in one sentence and inert in the next has no way to
 * account for the difference, because there is no difference in the world.
 *
 * The fault this exists to catch is precisely that: the annotator asked the
 * resolver at two different moments and painted two different answers, and
 * nothing anywhere noticed. Every mechanism this arc built — the verdict-key
 * ledger, the store's own re-ask, the filesystem feed — exists to make the
 * two answers agree. This is the assertion that they did, run over the
 * finished DOM rather than over any of the machinery, so it stays true of a
 * mechanism nobody has written yet.
 *
 * **It compares spellings, not resolutions.** An unmarked run carries no
 * verdict and no canonical path — a plain path is plain text, which is the
 * whole point — so the only thing the marked and unmarked sides can be
 * grouped by is what the ink actually says. That is not a weakness: two
 * mentions written identically are exactly the pair a reader compares, and
 * the pair the screenshots that opened this arc were of.
 *
 * Cheap enough to run after any verdict batch: one walk of a container's
 * marked runs and one scan of the text between them.
 *
 * @module lib/annotator/path-face-audit
 */

import { scanPathReferences } from "./detect-path-reference";
import { FILE_TEXT_ATTRIBUTE } from "./annotate-content";

/** One path-shaped run, and whether it is wearing the file's face. */
export interface PathFace {
  /** The run's text, exactly as the ink spells it. */
  text: string;
  /** Whether the annotator marked it as a file or a directory. */
  marked: boolean;
}

/** One spelling that appears both marked and plain in the same container. */
export interface FaceConflict {
  text: string;
  marked: number;
  plain: number;
}

/**
 * The spellings that wear two faces at once.
 *
 * Pure over the faces, so the rule can be stated as a claim in a unit test
 * rather than only watched for in a running app.
 */
export function conflictingFaces(
  faces: readonly PathFace[],
): FaceConflict[] {
  const counts = new Map<string, { marked: number; plain: number }>();
  for (const face of faces) {
    const seen = counts.get(face.text) ?? { marked: 0, plain: 0 };
    if (face.marked) seen.marked += 1;
    else seen.plain += 1;
    counts.set(face.text, seen);
  }
  const conflicts: FaceConflict[] = [];
  for (const [text, seen] of counts) {
    if (seen.marked > 0 && seen.plain > 0) {
      conflicts.push({ text, marked: seen.marked, plain: seen.plain });
    }
  }
  return conflicts;
}

/**
 * Every path-shaped run in `container`, marked and plain alike.
 *
 * A marked run is an annotated element whose kind is a file or a directory;
 * its written text is its `textContent`, except that a confirmed run hosts a
 * portal and was emptied, which is what {@link FILE_TEXT_ATTRIBUTE} keeps the
 * words in. A plain run is found by scanning the text that is left over —
 * every text node with no annotated ancestor — with the same grammar the
 * annotator scans with, so the two sides are the same question asked twice.
 */
export function pathFacesIn(container: HTMLElement): PathFace[] {
  const faces: PathFace[] = [];
  const marked = new Set<Element>();
  for (const element of container.querySelectorAll("[data-tug-annotation]")) {
    // Every annotated run shadows its own text from the scan below,
    // whatever its kind: a commit sha or a session citation is not a plain
    // path just because a permissive grammar could read one in it.
    marked.add(element);
    const kind = element.getAttribute("data-tug-annotation");
    if (kind !== "file-path" && kind !== "directory") continue;
    const written =
      element.getAttribute(FILE_TEXT_ATTRIBUTE) ?? element.textContent ?? "";
    if (written !== "") faces.push({ text: written, marked: true });
  }

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    let inMarked = false;
    for (
      let parent = node.parentElement;
      parent !== null && parent !== container;
      parent = parent.parentElement
    ) {
      if (marked.has(parent)) {
        inMarked = true;
        break;
      }
    }
    if (inMarked) continue;
    const text = node.textContent ?? "";
    if (text === "") continue;
    for (const match of scanPathReferences(text)) {
      faces.push({ text: text.slice(match.start, match.end), marked: false });
    }
  }
  return faces;
}

/**
 * Audit `container`: the spellings it draws two ways right now. An empty
 * array is the invariant holding.
 */
export function auditPathFaces(container: HTMLElement): FaceConflict[] {
  return conflictingFaces(pathFacesIn(container));
}
