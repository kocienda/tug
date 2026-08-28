/**
 * landing-message — a landing message's parts, read off its shape.
 *
 * A draft the skill writes is `subject`, a blank line, a short summary
 * paragraph, a blank line, then the detail. The message is one string on
 * the wire and in git — the split is a reading of that shape, made in one
 * place so every surface that fronts a subject or a summary fronts the same
 * one. The summary is the first paragraph after the subject that is prose
 * rather than a bullet list; a message whose first paragraph is bullets has
 * no summary, and everything past the subject is its body.
 *
 * @module lib/landing-message
 */

/** A message read as the parts a reading surface fronts. */
export interface LandingMessageParts {
  /** The first line. */
  subject: string;
  /** The summary paragraph, joined on single spaces; empty when the message
   *  has none. */
  summary: string;
  /** Everything after the subject and the summary, trimmed. */
  body: string;
}

function isBullet(line: string): boolean {
  return /^\s*[-*•]\s/.test(line);
}

export function landingMessageParts(message: string): LandingMessageParts {
  const lines = message.replace(/\r\n?/g, "\n").split("\n");
  const subject = (lines[0] ?? "").trim();
  const { summaryLines } = landingMessageLayout(message);
  if (summaryLines === null) {
    return { subject, summary: "", body: lines.slice(1).join("\n").trim() };
  }
  const summary = lines
    .slice(summaryLines.from - 1, summaryLines.to - 1)
    .map((line) => line.trim())
    .join(" ");
  const body = lines.slice(summaryLines.to - 1).join("\n").trim();
  return { subject, summary, body };
}

/**
 * The reading as line numbers, for a surface that styles the message in
 * place rather than reprinting its parts: the 1-based line the subject is,
 * and the 1-based first and one-past-last lines of the summary paragraph —
 * `null` when the message has none. {@link landingMessageParts} is this
 * reading with the lines filled in, so the two cannot disagree.
 */
export interface LandingMessageLayout {
  subjectLine: number;
  summaryLines: { from: number; to: number } | null;
}

export function landingMessageLayout(message: string): LandingMessageLayout {
  const lines = message.replace(/\r\n?/g, "\n").split("\n");
  let at = 1;
  while (at < lines.length && lines[at]!.trim() === "") at += 1;
  let end = at;
  let prose = end < lines.length && lines[end]!.trim() !== "";
  while (end < lines.length && lines[end]!.trim() !== "") {
    if (isBullet(lines[end]!)) prose = false;
    end += 1;
  }
  return {
    subjectLine: 1,
    summaryLines: prose ? { from: at + 1, to: end + 1 } : null,
  };
}
