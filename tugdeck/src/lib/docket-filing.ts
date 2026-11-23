/**
 * docket-filing.ts — what an atom placed on a docket asks the server to file,
 * and the sentence the card says about how the filing went.
 *
 * Pure: no store, no connection, no DOM. The Docket card's filing field
 * hands its atoms here, sends what comes back through `docketVerbs`, and
 * words the answer with {@link filingSentence}.
 *
 * @module lib/docket-filing
 */

import type { DocketFileItem, DocketFileOutcome } from "../protocol";
import type { DocketThread } from "./docket-types";
import type { AtomSegment } from "./tug-atom-img";
import { arcAtomName, isArcAtomType, isSketchAtomType } from "./record-atom-shape";
import { isSessionAtomType, sessionAtomCallsign } from "./session-atom-shape";

/**
 * The file item an atom names, or null for an atom a docket cannot hold.
 *
 * - an arc atom files its arc, in the checkout its value recorded or else the
 *   card's own, at the generation it pinned or else the newest;
 * - a sketch atom files its sketch;
 * - a session atom files its session by uuid when it carries one, else by
 *   callsign in the card's checkout;
 * - a commit atom files its commit;
 * - a file atom whose path ends in `.md` files that markdown file as a brief.
 *
 * Every other atom — an image, a directory, a link, a command, a file of any
 * other kind — is null, and the field never sends it.
 */
export function fileItemOf(segment: AtomSegment, projectDir: string): DocketFileItem | null {
  const value = segment.value;
  if (value.length === 0) return null;
  if (isArcAtomType(segment.type)) {
    return {
      kind: "arc",
      name: arcAtomName(value),
      project_dir: segment.arc?.projectDir ?? projectDir,
      ...(segment.arc?.created !== undefined ? { created: segment.arc.created } : {}),
    };
  }
  if (isSketchAtomType(segment.type)) return { kind: "sketch", id: value };
  if (isSessionAtomType(segment.type)) {
    if (segment.session !== undefined) {
      return {
        kind: "session",
        uuid: segment.session.id,
        project_dir: segment.session.projectDir,
      };
    }
    return { kind: "session", callsign: sessionAtomCallsign(value), project_dir: projectDir };
  }
  if (segment.type === "commit") return { kind: "commit", sha: value };
  if (segment.type === "file" && value.toLowerCase().endsWith(".md")) {
    return { kind: "brief", path: value };
  }
  return null;
}

/** The server's sentence for another checkout's work, which the card says short. */
const NOT_THIS_CHECKOUT_PREFIX = "It belongs to another checkout";

/** A refusal reason as a clause: short, lowercase, no closing period. */
function reasonClause(reason: string | null): string | null {
  if (reason === null) return null;
  if (reason.startsWith(NOT_THIS_CHECKOUT_PREFIX)) return "not this checkout";
  const trimmed = reason.trim().replace(/\.$/, "");
  if (trimmed.length === 0) return null;
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

/** Names joined as `*A*`, `*A* and *B*`, `*A*, *B* and *C*`. */
function nameList(names: readonly string[]): string {
  const marked = names.map((n) => `*${n}*`);
  if (marked.length <= 1) return marked.join("");
  return `${marked.slice(0, -1).join(", ")} and ${marked[marked.length - 1]}`;
}

/**
 * One line saying how a filing went, in the order filed · moved · already ·
 * refused, each part present only when it counts something:
 * `Filed 2 · moved 1 from *Rail work* · 1 refused: not this checkout`.
 *
 * A moved item's source is named by its current name in `docketNames` (id →
 * name) when the card knows it, else by the name the answer carried. Empty
 * for an empty filing.
 */
export function filingSentence(
  outcomes: readonly DocketFileOutcome[],
  docketNames: ReadonlyMap<string, string>,
): string {
  const of = (word: DocketFileOutcome["outcome"]) =>
    outcomes.filter((o) => o.outcome === word);
  const parts: string[] = [];

  const filed = of("filed").length;
  if (filed > 0) parts.push(`filed ${filed}`);

  const moved = of("moved");
  if (moved.length > 0) {
    const sources: string[] = [];
    for (const o of moved) {
      if (o.from === null) continue;
      const name = docketNames.get(o.from.id) ?? o.from.name;
      if (!sources.includes(name)) sources.push(name);
    }
    parts.push(
      sources.length > 0
        ? `moved ${moved.length} from ${nameList(sources)}`
        : `moved ${moved.length}`,
    );
  }

  const already = of("already").length;
  if (already > 0) parts.push(`${already} already here`);

  const refused = of("refused");
  if (refused.length > 0) {
    const reasons: string[] = [];
    for (const o of refused) {
      const clause = reasonClause(o.reason);
      if (clause !== null && !reasons.includes(clause)) reasons.push(clause);
    }
    parts.push(
      reasons.length > 0
        ? `${refused.length} refused: ${reasons.join("; ")}`
        : `${refused.length} refused`,
    );
  }

  if (parts.length === 0) return "";
  const sentence = parts.join(" · ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * What a thread holds that was filed directly — the items a Move re-files and
 * a Remove takes off. A thread's other cells are drawn because a filed item
 * reaches them, and moving those would file work the user never placed.
 *
 * The keys are the thread's own `filed_keys`, the store's grammar as the
 * server derived it. A filed brief is a snapshot: it moves by filing its
 * source again, which only a brief whose source file is known can do.
 */
export function filedItemsOf(
  thread: DocketThread,
  projectDir: string,
): { items: DocketFileItem[]; keys: string[] } {
  const items: DocketFileItem[] = [];
  if (thread.arc?.filed === true) {
    items.push({
      kind: "arc",
      name: thread.arc.name,
      project_dir: projectDir,
      created: thread.arc.created,
    });
  }
  if (thread.sketch?.filed === true) {
    items.push({ kind: "sketch", id: thread.sketch.id });
  }
  if (thread.brief?.filed === true && typeof thread.brief.source_path === "string") {
    items.push({ kind: "brief", path: thread.brief.source_path });
  }
  for (const session of thread.sessions) {
    if (!session.filed) continue;
    items.push({ kind: "session", uuid: session.uuid, project_dir: projectDir });
  }
  for (const commit of thread.commits) {
    if (!commit.filed) continue;
    items.push({ kind: "commit", sha: commit.sha });
  }
  return { items, keys: [...thread.filed_keys] };
}
