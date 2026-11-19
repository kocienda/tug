/**
 * landing-notice — what a landing surface should be saying right now ([L31]).
 *
 * The face is what a landing surface renders: two independent notices, each
 * carrying a cause in the user's frame, the remedy, and git's own words to
 * fold. The surface that renders it is the Changes shade's own notice band,
 * `session-changes-notice.tsx`; this module decides the words and the identity,
 * and nothing about visibility.
 *
 * The words are separated from the surface that renders them because the
 * surface is a React component with no substrate to test against, while the
 * words are the part that can be wrong: which of two competing conditions
 * speaks, what a given stderr means, whether a repeat press speaks again.
 * Keeping it a pure function over what the mode published makes those
 * answerable without a DOM, and leaves the component with nothing to decide.
 *
 * @module lib/landing-notice
 */

import type { LandingKind, LandingSnapshot } from "@/lib/landing-mode";
import type { StagedPath } from "@/lib/changeset-types";

/**
 * The one act a notice offers beyond Dismiss.
 *
 * `retry` presses land again and is offered only where pressing again can
 * come out differently — a held lock releases, a hook's complaint gets fixed.
 * `unstage` presses land with the staged paths put back first. `none` is every
 * failure a second press would answer in the same words: the remedy is the
 * user's, somewhere else, and a button that cannot work is worse than none.
 */
export type LandingNoticeAct = "retry" | "unstage" | "none";

/** One notice a landing surface can render — the words plus its identity. */
export interface LandingNotice {
  /** Identity for local dismiss / fade: the detail string for an error, `String(seq)` for a refusal. */
  key: string;
  channel: "error" | "refusal";
  tone: "danger" | "caution";
  title: string;
  /** The remedy sentence, or the refusal's sentence. */
  remedy: string;
  /** Verbatim detail to fold, or null when there is nothing beyond the title. */
  detail: string | null;
  /** The staged paths this notice is about, or null when it is about none. */
  staged: readonly StagedPath[] | null;
  /** What the notice's button does; always `none` on the refusal channel. */
  act: LandingNoticeAct;
}

/** Both channels at once, because both can be true ([P02]). */
export interface LandingNoticeFace {
  error: LandingNotice | null;
  refusal: LandingNotice | null;
}

/** One row of the cause table — a match over the lowercased detail, and what to say. */
interface CauseRow {
  match: (lower: string) => boolean;
  title: string;
  remedy: string;
  /** Whether pressing land again can come out differently for this cause. */
  act: "retry" | "none";
}

const KEPT = "try again — your message is kept.";

/**
 * The causes git actually produces, in the order they are tried (Table T01).
 *
 * Substring matching over the whole detail, case-insensitively, first row wins.
 * A row's title names the cause in the user's frame and its remedy names the
 * one thing to do; git's own text is never thrown away, it is folded.
 */
const COMMIT_CAUSES: CauseRow[] = [
  {
    match: (lower) => lower.includes("index.lock") && lower.includes("exists"),
    title: "Another git process is holding the repository lock",
    remedy: `Couldn't take .git/index.lock. If nothing else is running git here, remove the lock file and ${KEPT}`,
    act: "retry",
  },
  {
    match: (lower) =>
      lower.includes("please tell me who you are") ||
      lower.includes("author identity unknown") ||
      lower.includes("empty ident name"),
    title: "Git doesn't know who you are yet",
    remedy: `Set user.name and user.email with git config, then ${KEPT}`,
    act: "none",
  },
  {
    match: (lower) =>
      lower.includes("hook") &&
      (lower.includes("failed") ||
        lower.includes("declined") ||
        lower.includes("rejected") ||
        lower.includes("exit code")),
    title: "A commit hook refused the commit",
    remedy: "Read the hook's output below, fix what it names, and try again.",
    act: "retry",
  },
  {
    match: (lower) =>
      lower.includes("nothing to commit") || lower.includes("no changes added to commit"),
    title: "Nothing left to commit",
    remedy:
      "These files were already committed — likely by another session. Close the shade and check the transcript.",
    act: "none",
  },
  {
    match: (lower) => lower.includes("hunk drift:"),
    title: "The hunks you picked have moved",
    remedy:
      "The file changed under your selection. Reopen the Changes shade, pick the hunks again, and try again.",
    act: "none",
  },
];

/**
 * The index holds content the commit was not asked to land.
 *
 * Not a row of the table above, because it is not read out of a sentence: the
 * engine names the paths as data and the surface draws them as rows. The
 * title carries the count so it says something at a glance, and the remedy
 * says what the button does to the user's work, which is nothing — unstaging
 * leaves every byte in the working tree.
 */
export function describeStagedIndex(staged: readonly StagedPath[]): {
  title: string;
  remedy: string;
} {
  const count = staged.length;
  return {
    title:
      count === 1
        ? "1 staged file would ride along with this commit"
        : `${count} staged files would ride along with this commit`,
    remedy:
      "This commit lands part of a file, and that commits everything staged, so nothing was committed. Unstage and commit to land without them — their changes stay in your working tree.",
  };
}

/** git's first line, with the prefix that names a severity the title doesn't need. */
function firstLine(detail: string): string {
  const line = detail.split("\n", 1)[0]?.trim() ?? "";
  return line.replace(/^(?:fatal|error):\s*/i, "");
}

/**
 * What a landing failure means, and what to do about it.
 *
 * The evidence is always kept: `detail` comes back verbatim so the surface can
 * fold it, and goes null only when folding it would show the title a second
 * time. A commit detail that matches no row falls back to git's own first line
 * as the title, which is worse prose than a translated row and still better
 * than "Commit failed" — the fallback is what makes the table extensible
 * without a gap in the meantime. A join detail is always its first line: the
 * engine's refusals are already sentences in the user's frame ([P01]).
 */
export function describeLandingFailure(
  kind: LandingKind,
  detail: string,
): { title: string; remedy: string; detail: string | null; act: "retry" | "none" } {
  const lower = detail.toLowerCase();
  const row =
    kind === "commit" ? COMMIT_CAUSES.find((candidate) => candidate.match(lower)) : undefined;

  const title = row ? row.title : firstLine(detail);
  const remedy = row
    ? row.remedy
    : kind === "commit"
      ? `Read git's message below, fix what it names, and ${KEPT}`
      : `Fix what it names and ${KEPT}`;

  const spent = !detail.includes("\n") && detail.trim() === title;
  // A cause the table does not name is one nobody has judged, and a join's
  // refusals clear outside the shade — both keep the press.
  return { title, remedy, detail: spent ? null : detail, act: row ? row.act : "retry" };
}

/**
 * The two notices a landing mode is publishing right now.
 *
 * `active` is not read here — the band gates on it. That keeps this function
 * about words and identity, and leaves the visibility rule in one place.
 *
 * Refusals are keyed on `seq`, never on the sentence: pressing a refusing
 * button twice usually produces the identical words, and a surface that
 * compared text would go silent exactly when the user asked a second time. An
 * error is keyed on its detail for the same reason inverted — the same failure
 * settling twice is the same notice, and a dismiss of it should hold.
 */
export function landingNoticeFace(kind: LandingKind, snapshot: LandingSnapshot): LandingNoticeFace {
  const noun = kind === "commit" ? "Commit" : "Join";

  const failure = snapshot.landError;
  const staged = snapshot.landErrorStaged;
  const error: LandingNotice | null =
    failure === null
      ? null
      : staged !== null && staged.length > 0
        ? {
            key: failure,
            channel: "error",
            // Nothing is broken and nothing was lost: the commit waited
            // rather than take work it was not shown.
            tone: "caution",
            ...describeStagedIndex(staged),
            // The rows are the evidence; the engine's sentence would only
            // list the same paths again, in prose.
            detail: null,
            staged,
            act: "unstage",
          }
        : {
            key: failure,
            channel: "error",
            tone: "danger",
            staged: null,
            ...describeLandingFailure(kind, failure),
          };

  const refused = snapshot.landRefusal;
  const refusal: LandingNotice | null =
    refused === null
      ? null
      : {
          key: String(refused.seq),
          channel: "refusal",
          tone: refused.kind === "fault" ? "danger" : "caution",
          title: refused.kind === "fault" ? `${noun} cannot run` : `${noun} not sent`,
          remedy: refused.sentence,
          detail: null,
          staged: null,
          act: "none",
        };

  return { error, refusal };
}
