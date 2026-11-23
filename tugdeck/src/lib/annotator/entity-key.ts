/**
 * `entityKey` — the one string under which two annotations name the same
 * thing.
 *
 * A prose mention and a chart mark can both stand for one file, one commit
 * or one session, and when they do the deck lights them together. "The
 * same thing" is decided here, once, from the payload the resolver already
 * stamped — never from the spelling the author used:
 *
 *  - a path's verdict is its identity already, so `file-path` and
 *    `directory` key on the canonical path;
 *  - a commit is keyed by its root and its first seven hex characters,
 *    because prose and refs spell one sha at different lengths;
 *  - a session is keyed by the confirmed full id its payload carries;
 *  - an arc by its root and name; a url by itself; a command by its text.
 *
 * `email`, `image` and `help` have no entity a chart can name, so they key
 * to `null` and never light anything.
 *
 * @module lib/annotator/entity-key
 */

import type { AnnotationPayload } from "./payloads";

/** How many characters of a sha the key keeps: enough to tell shas apart in any repository the deck opens. */
const SHA_KEY_LENGTH = 7;

/**
 * The entity `payload` names, or `null` for a kind that names none.
 */
export function entityKey(payload: AnnotationPayload): string | null {
  switch (payload.kind) {
    case "file-path":
    case "directory":
      return `path:${payload.path}`;
    case "commit-sha":
      return `commit:${payload.root}:${payload.sha.slice(0, SHA_KEY_LENGTH).toLowerCase()}`;
    case "session":
      return `session:${payload.target}`;
    case "arc":
      return `arc:${payload.root}:${payload.name}`;
    case "docket":
      return `docket:${payload.id}`;
    case "url":
      return `url:${payload.url}`;
    case "slash-command":
      return `slash:${payload.name} ${payload.args}`;
    case "shell-command":
      return `shell:${payload.command}`;
    default:
      return null;
  }
}
