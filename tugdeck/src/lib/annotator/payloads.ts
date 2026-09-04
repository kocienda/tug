/**
 * Annotation payloads and their dataset round-trip.
 *
 * An annotation's *payload* is the structured value a gesture acts on —
 * the URL to open, the command name and arguments to seed. It has to
 * survive a trip through the DOM, because detection happens when a block
 * renders and action happens when the user clicks, possibly much later,
 * on an element the listener finds by `closest()` rather than by
 * identity. Dataset attributes are that carrier.
 *
 * These functions are the whole of that translation, and they are pure —
 * they take and return plain string records, never elements. The DOM pass
 * and the delegated listeners are thin shells over them, which is what
 * lets the contract be pinned by unit test in a project that runs no
 * fake-DOM tests.
 *
 * @module lib/annotator/payloads
 */

import {
  parseShellCommandLine,
  parseSlashCommandLine,
} from "./command-grammar";
import {
  detectPathReference,
  type PathReference,
} from "./detect-path-reference";
import type { PathVerdict } from "./path-resolution";
import type { AnnotationKind } from "./types";
import { resolveAtomFilePath, type AtomPathRoots } from "@/lib/atom-file-path";
import { COMMIT_ATOM_TYPE } from "@/lib/command-atom";

/** A URL in transcript ink. */
export interface UrlPayload {
  kind: "url";
  url: string;
}

/** An email address in transcript ink. */
export interface EmailPayload {
  kind: "email";
  address: string;
}

/** A slash command a click can seed into the prompt. */
export interface SlashCommandPayload {
  kind: "slash-command";
  /** Bare command name, no leading slash. */
  name: string;
  /** Argument text after the name, `""` when there is none. */
  args: string;
}

/** A project shell command a click can seed into the prompt. */
export interface ShellCommandPayload {
  kind: "shell-command";
  /** The whole command line, as written. */
  command: string;
}

/** A file that exists on disk, optionally at a cited line. */
export interface FilePathPayload {
  kind: "file-path";
  /** Absolute canonical path — what the endpoint resolved, not what was written. */
  path: string;
  /** 1-based line to open at. */
  line?: number;
  /** 1-based last line of a cited range; `line` is its start. */
  endLine?: number;
  /**
   * Character range within `line` the reference actually names — 0-based and
   * half-open, as a search result carries its match span. Only a reference
   * that knows its columns has this; prose citing a line does not.
   */
  columns?: readonly [number, number];
}

/** A directory that exists on disk. */
export interface DirectoryPayload {
  kind: "directory";
  /** Absolute path, with no trailing separator. */
  path: string;
}

/**
 * An image carried as bytes rather than as a file — a paste, or a
 * screenshot dropped into the prompt. It has an id and no path, so the
 * only thing "open" can mean is the attachment strip's own lightbox.
 */
export interface ImagePayload {
  kind: "image";
  /** The atom id the bytes are stored under. */
  atomId: string;
  /** What the chip reads, for the clipboard and the prompt. */
  label: string;
}

/** A commit that exists in the card's repository. */
export interface CommitShaPayload {
  kind: "commit-sha";
  /** The sha as written — short or full; git resolves either. */
  sha: string;
  /** The repository the commit belongs to. */
  root: string;
  /** The files the commit touched, which scope the diff a click opens. */
  paths: string[];
}

/**
 * A session the ledger holds, named in prose.
 *
 * The target is the FULL session id however the prose spelled it — a
 * `project/callsign` pair resolves through its callsign half and comes back
 * with the id, which is what a citation chip and a raise both need.
 */
export interface SessionPayload {
  kind: "session";
  /** The full session id the ledger answered with. */
  target: string;
}

/** The payload of any annotation, discriminated by kind. */
export type AnnotationPayload =
  | UrlPayload
  | EmailPayload
  | SlashCommandPayload
  | ShellCommandPayload
  | FilePathPayload
  | DirectoryPayload
  | ImagePayload
  | CommitShaPayload
  | SessionPayload;

/** The fields of an atom this needs to decide what it is. */
export interface AtomLike {
  type: string;
  value: string;
  label?: string;
  id?: string;
}

/**
 * The absolute path a **mention's** value names, or `null` when there is
 * no root to count a relative one from.
 *
 * Only the types an `@` mention mints go through here. A mention's value
 * comes from the file index, which reports paths relative to the project
 * root, so joining it onto that root recovers the address it was written
 * against. An image atom is deliberately not one of those: a dropped image
 * carries the bare filename the browser was willing to disclose, and
 * joining THAT onto a root would invent an address rather than recover one.
 */
function mentionPathOf(value: string, roots?: AtomPathRoots): string | null {
  if (value.startsWith("/")) return value;
  if (roots === undefined) return null;
  const resolved = resolveAtomFilePath(value, roots);
  return resolved.startsWith("/") ? resolved : null;
}

/**
 * The annotation an attached atom carries, or `null` when nothing sensible
 * can be done with it.
 *
 * Born confirmed: the user picked this thing, which is better evidence
 * than a probe, so an atom never waits on verification.
 *
 * Every atom type the prompt can mint is answered here, because an inert
 * chip is a promise the transcript does not keep — it looks like an object
 * and behaves like text. A file or directory opens by path; an image
 * pasted as bytes has no path, so it opens the attachment strip's own
 * lightbox by atom id.
 *
 * A file or directory atom does not have to carry an absolute value: an
 * `@` mention takes its value from the file index, which counts from the
 * project root. Such a value is resolved against `roots` — the same roots
 * the mention was written against ({@link mentionPathOf}). With no roots to
 * resolve against, a relative value is still refused: the contract is an
 * openable target, and guessing what a bare name is relative to is how a
 * link starts dead-ending.
 *
 * **A commit resolves the same way, through the same root.** Its value is the
 * sha and nothing else, so the repository the sha belongs to has to come from
 * somewhere — and that somewhere is `roots.projectDir`, the card's own project
 * directory, exactly the root a relative file value counts from. With no root
 * the answer is `null`, for the file arm's reason: a diff descriptor naming no
 * repository opens nothing, and an atom that looked actionable and was not is
 * the failure this whole function exists to avoid.
 *
 * The touched-file list a commit payload can carry comes back EMPTY here, and
 * that is correct rather than a gap. `paths` scopes the diff as an
 * optimization — it is optional on the descriptor — and the only thing that
 * knows which files a commit touched is the repository, which the resolver
 * asks over the wire and caches per workspace. This function is pure by
 * contract, and acquiring a store to consult would cost that for a field the
 * diff re-derives anyway.
 */
export function payloadForAtom(
  atom: AtomLike,
  roots?: AtomPathRoots,
): AnnotationPayload | null {
  const { type, value } = atom;
  if (type === "file") {
    const path = mentionPathOf(value, roots);
    return path === null ? null : { kind: "file-path", path };
  }
  if (type === "directory") {
    const path = mentionPathOf(value, roots);
    // The index form carries a trailing separator; the path form does not.
    return path === null
      ? null
      : { kind: "directory", path: path.replace(/\/+$/, "") };
  }
  if (type === "image") {
    // A dropped image file has somewhere to go on disk; a pasted one has
    // only its bytes, and is opened through the strip that holds them.
    if (value.startsWith("/")) return { kind: "file-path", path: value };
    if (atom.id !== undefined && atom.id !== "") {
      return { kind: "image", atomId: atom.id, label: atom.label ?? value };
    }
    return null;
  }
  if (type === "link" && value !== "") return { kind: "url", url: value };
  if (type === COMMIT_ATOM_TYPE && value !== "") {
    const root = roots?.projectDir ?? null;
    return root === null
      ? null
      : { kind: "commit-sha", sha: value, root, paths: [] };
  }
  return null;
}

/**
 * Whether acting on this kind opens another surface. Those annotations
 * need the focus discipline a card-opening gesture requires: the press
 * must not move DOM focus or activate the host pane, or the prompt's
 * caret goes with it.
 */
export function annotationOpensSurface(kind: AnnotationKind): boolean {
  // Not `session`: the citation chip owns its whole gesture, including
  // whether to offer one, so the press needs none of the card-opening focus
  // discipline from this layer.
  return (
    kind === "file-path" ||
    kind === "directory" ||
    kind === "image" ||
    kind === "commit-sha"
  );
}

/**
 * The dataset a payload occupies, as a plain record of attribute-name →
 * value. Keys are `dataset` property names (camelCase), so a caller
 * assigns them straight onto `element.dataset`.
 *
 * The kind attribute itself is not included — it is stamped separately
 * alongside the annotation class, since it identifies the element rather
 * than describing it.
 */
export type AnnotationDataset = Record<string, string>;

/** Dataset keys an annotation may occupy, for wholesale removal. */
export const ANNOTATION_DATASET_KEYS = [
  "url",
  "email",
  "slashCommand",
  "slashArgs",
  "shellCommand",
  "path",
  "line",
  "endLine",
  "columns",
  "atomId",
  "atomLabel",
  "sha",
  "root",
  "commitPaths",
  "target",
] as const;

/** Compose the dataset that carries `payload` through the DOM. */
export function datasetForPayload(payload: AnnotationPayload): AnnotationDataset {
  switch (payload.kind) {
    case "url":
      return { url: payload.url };
    case "email":
      return { email: payload.address };
    case "slash-command":
      return { slashCommand: payload.name, slashArgs: payload.args };
    case "shell-command":
      return { shellCommand: payload.command };
    case "file-path": {
      const record: AnnotationDataset = { path: payload.path };
      if (payload.line !== undefined) record.line = String(payload.line);
      if (payload.endLine !== undefined) {
        record.endLine = String(payload.endLine);
      }
      if (payload.columns !== undefined) {
        // Two numbers in one dataset value — a dataset holds text, and the
        // pair travels together or not at all.
        record.columns = `${payload.columns[0]},${payload.columns[1]}`;
      }
      return record;
    }
    case "directory":
      return { path: payload.path };
    case "image":
      return { atomId: payload.atomId, atomLabel: payload.label };
    case "commit-sha":
      // The path list rides as a newline-joined string: a dataset value is
      // text, and a path cannot contain a newline.
      return {
        sha: payload.sha,
        root: payload.root,
        commitPaths: payload.paths.join("\n"),
      };
    case "session":
      return { target: payload.target };
  }
}

/**
 * The same dataset as `data-*` attribute names, for a React surface that
 * renders an annotation as JSX and cannot assign to `element.dataset`.
 *
 * Spreading this is the point: a surface that named the attributes by hand
 * would silently render a new kind's payload as nothing, and the
 * annotation would look right and do nothing.
 */
export function dataAttributesForPayload(
  payload: AnnotationPayload,
): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(datasetForPayload(payload))) {
    attributes[`data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] =
      value;
  }
  return attributes;
}

/** Parse a 1-based line number from a dataset value, or `undefined`. */
function lineFromRecord(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 1 ? value : undefined;
}

/** Recover the `start,end` column pair. Half-open, so an empty span is no
 *  span at all — a bare caret is the line reveal, not a zero-width wash. */
function columnsFromRecord(
  raw: string | undefined,
): readonly [number, number] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw.split(",");
  if (parts.length !== 2) return undefined;
  const start = Number.parseInt(parts[0], 10);
  const end = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  if (start < 0 || end <= start) return undefined;
  return [start, end] as const;
}

/**
 * Recover a payload from the dataset of an annotated element. Returns
 * `null` when the record does not carry what the kind requires — a
 * half-stamped element is not actionable, and the caller treats it as a
 * miss rather than acting on a partial value.
 */
export function payloadFromDataset(
  kind: AnnotationKind,
  record: Readonly<AnnotationDataset>,
): AnnotationPayload | null {
  switch (kind) {
    case "url": {
      const url = record.url;
      return url === undefined || url === "" ? null : { kind, url };
    }
    case "email": {
      const address = record.email;
      return address === undefined || address === ""
        ? null
        : { kind, address };
    }
    case "slash-command": {
      const name = record.slashCommand;
      return name === undefined || name === ""
        ? null
        : { kind, name, args: record.slashArgs ?? "" };
    }
    case "shell-command": {
      const command = record.shellCommand;
      return command === undefined || command === ""
        ? null
        : { kind, command };
    }
    case "file-path": {
      const path = record.path;
      if (path === undefined || path === "") return null;
      const payload: FilePathPayload = { kind, path };
      const line = lineFromRecord(record.line);
      if (line !== undefined) payload.line = line;
      const endLine = lineFromRecord(record.endLine);
      if (endLine !== undefined) payload.endLine = endLine;
      const columns = columnsFromRecord(record.columns);
      if (columns !== undefined) payload.columns = columns;
      return payload;
    }
    case "directory": {
      const path = record.path;
      return path === undefined || path === "" ? null : { kind, path };
    }
    case "image": {
      const atomId = record.atomId;
      if (atomId === undefined || atomId === "") return null;
      return { kind, atomId, label: record.atomLabel ?? atomId };
    }
    case "commit-sha": {
      const sha = record.sha;
      const root = record.root;
      if (sha === undefined || sha === "") return null;
      if (root === undefined || root === "") return null;
      const raw = record.commitPaths ?? "";
      return { kind, sha, root, paths: raw === "" ? [] : raw.split("\n") };
    }
    case "session": {
      const target = record.target;
      return target === undefined || target === "" ? null : { kind, target };
    }
  }
}

/**
 * The annotation's canonical value as text: what Copy puts on the
 * clipboard and what Insert into Prompt sends back into the
 * conversation. A slash command regains its leading slash, so the
 * inserted text is a command line the prompt can act on rather than a
 * bare name.
 */
export function annotationValue(payload: AnnotationPayload): string {
  switch (payload.kind) {
    case "url":
      return payload.url;
    case "email":
      return payload.address;
    case "slash-command":
      return payload.args === ""
        ? `/${payload.name}`
        : `/${payload.name} ${payload.args}`;
    case "shell-command":
      return payload.command;
    case "file-path": {
      // Copy and Insert reproduce the citation as written, so pasting the
      // value back says where in the file, not just which one.
      if (payload.line === undefined) return payload.path;
      if (payload.endLine === undefined) {
        return `${payload.path}:${payload.line}`;
      }
      return `${payload.path}:${payload.line}-${payload.endLine}`;
    }
    case "directory":
      return payload.path;
    case "image":
      // The bytes have no textual form; the chip's label is what the
      // conversation calls this image, so it is what Copy yields.
      return payload.label;
    case "commit-sha":
      return payload.sha;
    case "session":
      // The full id, not the `project/callsign` spelling the prose used: a
      // paste of this has to name the session anywhere it is pasted, and the
      // sentence already carries the readable form.
      return payload.target;
  }
}

/**
 * Classify one inline `<code>` span's text, given the live known-command
 * gate. Returns the payload to stamp, or `null` when the span is ordinary
 * code.
 *
 * The precedence is the contract: a span is at most one kind, and the
 * families are tried in decreasing strictness — a known slash command
 * first (grammar plus catalog), then a project shell command (grammar
 * alone). Ordering them this way means a span that satisfies two shapes
 * resolves the same way on every pass, so re-running the pass can never
 * flip an element between kinds.
 */
export function classifyInlineCode(
  text: string,
  isKnownSlashCommand: (name: string) => boolean,
  resolvePath: (reference: PathReference) => PathVerdict,
): AnnotationPayload | null {
  const slash = parseSlashCommandLine(text);
  if (slash !== null && isKnownSlashCommand(slash.name)) {
    return { kind: "slash-command", name: slash.name, args: slash.args };
  }
  const shell = parseShellCommandLine(text);
  if (shell !== null) return { kind: "shell-command", command: shell };

  const reference = detectPathReference(text);
  if (reference === null) return null;
  return payloadForReference(reference, resolvePath(reference));
}

/**
 * The file-path payload a resolved reference carries, or `null` when the
 * reference is not actionable.
 *
 * Only a path confirmed to exist becomes a payload. Every other verdict —
 * never asked, still asking, known missing — leaves the text alone, and a
 * later pass reconsiders if the answer changes. The payload carries the
 * *canonical* path the resolver returned rather than the text as written,
 * so the gesture opens the file the reference named however it spelled it.
 */
export function payloadForReference(
  reference: PathReference,
  verdict: PathVerdict,
): FilePathPayload | DirectoryPayload | null {
  if (verdict.state !== "confirmed") return null;
  // A folder earns the folder gesture. The reference looked the same in
  // ink either way — only the filesystem knows which it is — so the kind
  // is decided here rather than by the grammar.
  if (verdict.isDir) return { kind: "directory", path: verdict.canonical };
  const payload: FilePathPayload = {
    kind: "file-path",
    path: verdict.canonical,
  };
  if (reference.line !== undefined) payload.line = reference.line;
  if (reference.endLine !== undefined) payload.endLine = reference.endLine;
  return payload;
}
