/**
 * `synthesize-user-message` — JSONL-honest substrate synthesis from
 * Anthropic-API-shaped content blocks.
 *
 * ## What this module does
 *
 * Both the live submit path (`code-session-store.send`) and the
 * JSONL replay path (`add_user_message` frame from tugcode) need to
 * produce a `(text, atoms)` substrate pair for the transcript user
 * row. Pre-Step-5c the live path inherited the editor's substrate
 * directly; the replay path cast wire-shape attachments as atoms.
 * The two halves drifted, and the cast was the visible-bug seam.
 *
 * Step 5c collapses both into one synthesizer. Given the same
 * `ContentBlock[]` array (which is what JSONL records verbatim and
 * what tugcode forwards live), this function produces:
 *
 *  - `text`: a substrate string with `U+FFFC` (object replacement)
 *    at every image-block position AND at every non-image atom
 *    mention recovered from a text block via
 *    {@link parseAtomMentionSegments}. Text-block contents otherwise
 *    copy verbatim; adjacent text blocks coalesce in the output
 *    (the walker accumulates between `U+FFFC` insertions).
 *  - `atoms`: one `AtomSegment` per image block, plus one per
 *    backtick-`@` mention span in any text block. Image atoms carry
 *    `label: "image-N"` (1-based per-message image counter) and an
 *    `id` resolved via `options.atomIdAt` (live path) or minted
 *    fresh (replay path). Mention atoms default to `type: "file"`
 *    (the wire marker doesn't preserve the original atom type) and
 *    carry the mention's value as both label and value; the three
 *    kinds that can say what they are are recovered instead: a session
 *    names its type on the marker itself, and a directory and a commit
 *    give themselves away by the shape of their value (see
 *    {@link mentionAtomType}).
 *  - `thumbnailBake`: a promise that resolves when all newly-fired
 *    thumbnail bakes have settled. Production callers fire-and-forget;
 *    tests can await for deterministic ordering.
 *
 * A trailing `tug:session-refs` block is not part of any of that. It is the
 * fact sheet `buildWirePayload` wrote for the model — the uuid behind each
 * session marker — and it is stripped before the walk begins, contributing
 * no text and no atoms. What it carried is put back where it belongs: the
 * session atom the marker re-minted takes its `session` identity from the
 * matching line, so a replayed chip is as findable as the minted one was.
 *
 * The bytes-store side-effect is the documented seam: for each image
 * block, the synthesizer ensures the bytes-store has an entry at the
 * resolved id with `content` + `mediaType` matching the block's
 * source. When the existing entry already carries
 * `thumbnailDataUrl`, no bake is fired — preserving the drop-time
 * downsample's thumbnail across the submit boundary. When no
 * thumbnail exists, the synthesizer fires `bakeImage` and updates
 * the entry with the result.
 *
 * ## Determinism caveat
 *
 * The (text, atoms-without-id) output is deterministic on the
 * inputs. Atom ids are deterministic IFF `options.atomIdAt` is
 * provided (live path); without it (replay path), fresh UUIDs are
 * minted on each call. The bytes-store puts are idempotent on
 * identical inputs given identical resolvers.
 *
 * ## Submit boundary
 *
 * Image atoms carry the unified `image-N` name on both sides of the
 * boundary: the editor mints `image-N` at attach time (the original
 * filename can't cross the wire — the image content block carries no
 * name), and this synthesizer re-mints `image-N` in document order from
 * the JSONL content blocks. So the live editor, the live transcript, and
 * a cold replay all render the same label, with no render-time address
 * decoration (see [Step 5c — submit boundary]
 * (arc/dev-atoms.md#step-5c-submit-boundary)). Non-image `@`-mention
 * atoms keep their path / URL value verbatim.
 *
 * Laws:
 *  - [L02] external state — the bytes-store mutation is documented
 *    and contained to this seam; the reducer's purity is preserved
 *    because the synthesizer runs in the impure wrapper layer.
 *  - [L19] file structure / docstring discipline.
 *
 * References:
 *  - [Step 5c](arc/dev-atoms.md#step-5c)
 *  - [Spec S03](arc/dev-atoms.md#s03-build-wire-payload) (revised)
 */

import type { ContentBlock } from "@/protocol";
import type { AtomBytesEntry, AtomBytesStore } from "./atom-bytes-store";
import { TUG_ATOM_CHAR, type AtomSegment } from "./tug-atom-img";
import { bakeThumbnail } from "./image-downsample";
import { parseAtomMentionSegments } from "./atom-mention-marker";
import { COMMIT_ATOM_TYPE, detectCommandEcho } from "./command-atom";
import {
  isSessionRefBlock,
  parseSessionRefBlock,
  type ParsedSessionRef,
} from "./session-ref-block";
import { commitAtomLabel } from "./commit-format";
import { isCommitSha } from "./annotator/detect-commit-sha";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Optional knobs for {@link synthesizeUserMessageFromBlocks}. All
 * default to production behaviour; tests inject deterministic
 * versions.
 */
export interface SynthesizeOptions {
  /**
   * Live-path resolver: given the 0-based index of an image block
   * (counting only image blocks in the input), return the atom id to
   * reuse for that block. Returning `undefined` (or omitting the
   * resolver entirely) falls through to {@link mintAtomId}.
   *
   * Live path supplies a resolver mapping image-block index → the
   * editor's original atom id (via `buildWirePayload`'s `atomIdAt`
   * closure). The bytes-store puts overwrite the drop / paste
   * entries idempotently — same id, same bytes, same mediaType.
   *
   * Replay path omits the resolver; ids are minted fresh.
   */
  atomIdAt?: (imageBlockIndex: number) => string | undefined;
  /**
   * UUID minter for atoms that didn't resolve via {@link atomIdAt}.
   * Defaults to `crypto.randomUUID()` (with a string fallback for
   * runtimes without it). Tests pass a deterministic counter.
   */
  mintAtomId?: () => string;
  /**
   * Thumbnail baker. Takes the image block's base64 + mediaType and
   * returns a `data:image/...;base64,...` URL (or `null` on bake
   * failure). Defaults to the Web-Worker-backed `bakeThumbnail`
   * (via a base64→Blob converter). Tests pass a stub returning a
   * fixed string so the production canvas pipeline isn't required.
   */
  bakeImage?: (data: string, mediaType: string) => Promise<string | null>;
}

/**
 * Output of {@link synthesizeUserMessageFromBlocks}. `text` + `atoms`
 * land on the `UserMessage` substrate; `thumbnailBake` is the
 * fire-and-forget handle production callers ignore and tests await.
 */
export interface SynthesizeResult {
  text: string;
  atoms: AtomSegment[];
  /**
   * Resolves when every newly-fired thumbnail bake has settled (the
   * matching bytes-store entry has either been updated with
   * `thumbnailDataUrl` or the bake failed and the entry was left as
   * was). Resolves immediately when no bakes were needed (every
   * image block's bytes-store entry already had a thumbnail — the
   * pure-live case where drop / paste populated everything).
   */
  thumbnailBake: Promise<void>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Atom type for a replayed `@`-mention whose marker named no type — it is
 * recovered from the shape of the value alone.
 *
 * A directory mention's value always ends in `/` (tugcast's index form), so
 * directory chips round-trip. Everything else defaults to `"file"`.
 *
 * A session is NOT recovered here, and that is the point of the typed
 * marker: `<project>/<callsign>` is shaped exactly like a relative file
 * path, so nothing in the value can tell the two apart. The discriminator
 * used to be the local tag store — a two-segment value whose tail was a
 * callsign this client had seen — which made a replay's answer depend on
 * what the reading instance happened to hold. The same JSONL read on
 * another instance, or in a project whose sessions this one had never
 * listed, gave a file chip where the user had put a session. The marker
 * carries `session:` instead, and the caller reads
 * `AtomMentionSegment.atomType` before reaching this function at all.
 *
 * A commit is recovered the same way and for the same reason — the value's
 * own shape, no second grammar on the wire. Its value is a bare sha, so the
 * discriminator is the sha grammar itself ({@link isCommitSha}: 7–40
 * lowercase hex with at least one digit), which is the same test that decides
 * whether a run of hex in prose is worth asking the repository about. A path
 * would have to be bare hex with no directory and no extension to collide,
 * and the cost of one is a mark drawn as the wrong kind of thing. Without
 * this a commit atom came back from its own submit as a FILE whose label was
 * the full forty-character sha — the mark changed kind and the label changed
 * spelling, on the surface the user was still looking at.
 */
function mentionAtomType(value: string): string {
  if (value.endsWith("/")) return "directory";
  if (isCommitSha(value)) return COMMIT_ATOM_TYPE;
  return "file";
}

/**
 * The label a recovered mention wears.
 *
 * The value is its own label for every kind whose label IS its value — a
 * path, a directory, a URL. A commit is the exception the whole app already
 * makes: its label is `commit:<8>`, the one spelling the pill prints, the
 * clipboard writes and the copy menu offers, so recovering the type without
 * recovering the spelling would put a forty-character sha inside the mark.
 */
function mentionAtomLabel(type: string, value: string): string {
  return type === COMMIT_ATOM_TYPE ? commitAtomLabel(value) : value;
}

/**
 * The atom one parsed mention becomes — the wire's word first, the value's
 * shape second.
 *
 * A marker that named its type is believed: that is the whole reason the
 * prefix is written. Only an untyped marker falls through to
 * {@link mentionAtomType}, which is where the shape rules live.
 *
 * The recovered atom carries no `session` pair. The wire marker holds the
 * `<project>/<callsign>` name and nothing more, so a replayed session atom
 * is a reference by name — the reference block the prompt carries is what
 * supplies the uuid, and inventing a half-filled pair here would make a
 * replayed chip look as findable as a minted one.
 */
function mentionAtom(seg: {
  value: string;
  atomType?: "session";
}): AtomSegment {
  const type = seg.atomType ?? mentionAtomType(seg.value);
  return {
    kind: "atom",
    type,
    label: mentionAtomLabel(type, seg.value),
    value: seg.value,
  };
}

function defaultMintAtomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `atom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function base64ToBlob(data: string, mediaType: string): Blob {
  // `atob` is available in browsers + bun. Decodes base64 → binary
  // string; we then copy into a Uint8Array for the Blob constructor.
  // Errors here surface as a `bake-failed` outcome upstream because
  // the bake's catch wraps to `null`.
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes as unknown as BlobPart], { type: mediaType });
}

async function defaultBakeImage(
  data: string,
  mediaType: string,
): Promise<string | null> {
  try {
    const blob = base64ToBlob(data, mediaType);
    return await bakeThumbnail(blob);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

/**
 * Walk `blocks` and produce a `(text, atoms)` substrate. See module
 * docstring for the full contract.
 */
export function synthesizeUserMessageFromBlocks(
  blocks: ReadonlyArray<ContentBlock>,
  bytesStore: AtomBytesStore,
  options?: SynthesizeOptions,
): SynthesizeResult {
  const mintAtomId = options?.mintAtomId ?? defaultMintAtomId;
  const bakeImage = options?.bakeImage ?? defaultBakeImage;
  const atomIdAt = options?.atomIdAt;

  // The trailing reference block is plumbing the model reads and the user
  // never does, so it is removed here before anything else looks at the
  // blocks: it contributes no text and no atoms, and every walk below —
  // including the command-echo detector — sees the message the user actually
  // sent. What it leaves behind is the identity it carried, which is put back
  // onto the atoms the markers re-mint.
  const refs = new Map<string, ParsedSessionRef>();
  const bodyBlocks: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === "text" && isSessionRefBlock(block.text)) {
      for (const ref of parseSessionRefBlock(block.text)) {
        if (!refs.has(ref.value)) refs.set(ref.value, ref);
      }
      continue;
    }
    bodyBlocks.push(block);
  }

  /**
   * Put the block's identity back on a recovered session atom.
   *
   * The marker carries the name and the block carries the uuid, so this is
   * where a replayed chip becomes as findable as the minted one was. An atom
   * the block never named keeps no pair at all, which is the honest state for
   * a message that predates the block.
   */
  const withRefIdentity = (atom: AtomSegment): AtomSegment => {
    const ref = refs.get(atom.value);
    if (atom.type !== "session" || ref === undefined) return atom;
    return { ...atom, session: { id: ref.sessionId, projectDir: ref.projectDir } };
  };

  // Command-expansion echo: when claude expands a typed `/command`, it
  // rewrites the user turn to a `<command-name>` envelope rather than the
  // literal the editor sent. The atom type doesn't survive on the wire,
  // so reconstruct the command atom from the envelope here — yielding the
  // same command chip the editor showed (the bare `value` matches the
  // editor atom's, so optimistic and replayed echoes render identically).
  // Commands never ride the `@`-mention marker, so this is the only path
  // that re-mints a `command` atom. See {@link detectCommandEcho}.
  const commandEcho = detectCommandEcho(bodyBlocks);
  if (commandEcho !== null) {
    const { value, args } = commandEcho;
    const echoAtoms: AtomSegment[] = [
      { kind: "atom", type: "command", label: value, value },
    ];
    // Argument atoms (a `@`-mention file dropped after the command) ride
    // the args text as backtick-`@` markers — the same wrap `buildWirePayload`
    // emits for any non-image atom. Reverse the wrap here so the file chip
    // returns alongside the command chip, matching the optimistic substrate
    // that `hasLeadingCommandAtom` preserved on submit. Without this the
    // marker would render as literal `` `@path` `` text on replay.
    let echoText = TUG_ATOM_CHAR;
    if (args) {
      echoText += " ";
      for (const seg of parseAtomMentionSegments(args)) {
        if (seg.kind === "text") {
          echoText += seg.text;
          continue;
        }
        echoText += TUG_ATOM_CHAR;
        echoAtoms.push(withRefIdentity(mentionAtom(seg)));
      }
    }
    return {
      text: echoText,
      atoms: echoAtoms,
      thumbnailBake: Promise.resolve(),
    };
  }

  let textBuf = "";
  const atoms: AtomSegment[] = [];
  const bakes: Array<Promise<void>> = [];
  let imageBlockIndex = 0;

  for (const block of bodyBlocks) {
    if (block.type === "text") {
      // Parse backtick-`@` mention markers out of the wire text and
      // re-mint chips at the original positions. The submit-side
      // `buildWirePayload` wraps non-image atom values as
      // `` `@<value>` ``; the parser inverts the wrap. Plain text
      // between (or surrounding) mentions concatenates verbatim. See
      // `atom-mention-marker.ts` for the marker rationale + parse
      // contract.
      for (const seg of parseAtomMentionSegments(block.text)) {
        if (seg.kind === "text") {
          textBuf += seg.text;
          continue;
        }
        // Mention atom — the original `type` (file / doc / link /
        // command) is not preserved on the wire; we default to
        // `"file"` since that's the overwhelmingly common case for
        // `@`-mention completions and the chip's icon falls back
        // gracefully if the value is actually a URL or command. Three
        // kinds come back typed instead: a session says so on the
        // marker itself, a trailing `/` is a directory, and a bare run
        // of sha-shaped hex is a commit, which also takes back its
        // `commit:<8>` spelling.
        textBuf += TUG_ATOM_CHAR;
        atoms.push(withRefIdentity(mentionAtom(seg)));
      }
      continue;
    }
    if (block.type === "image") {
      const idx = imageBlockIndex;
      imageBlockIndex += 1;
      const labelN = idx + 1;
      const label = `image-${labelN}`;
      const resolvedId = atomIdAt?.(idx);
      const id = resolvedId ?? mintAtomId();
      // Merge with any existing entry's thumbnail so the live path
      // (where drop / paste already populated thumbnailDataUrl)
      // doesn't lose it on the synthesizer's idempotent put.
      const existing = bytesStore.get(id);
      const entry: AtomBytesEntry = {
        content: block.source.data,
        mediaType: block.source.media_type,
      };
      if (existing?.thumbnailDataUrl !== undefined) {
        entry.thumbnailDataUrl = existing.thumbnailDataUrl;
      }
      bytesStore.put(id, entry);
      if (entry.thumbnailDataUrl === undefined) {
        // No prior thumbnail — fire the bake. Resolves with the
        // updated entry once the worker returns; settles even on
        // bake failure (the entry stays without a thumbnail; Step 6's
        // strip renderer falls back to a placeholder tile).
        const bake = bakeImage(block.source.data, block.source.media_type).then(
          (url) => {
            if (url === null) return;
            // Re-read in case the entry has shifted (rare; defensive
            // against concurrent puts) — preserve current `content` /
            // `mediaType` rather than re-stamping with stale values.
            const cur = bytesStore.get(id);
            if (cur === null) return;
            bytesStore.put(id, { ...cur, thumbnailDataUrl: url });
          },
          () => {
            // Bake threw — the bytes-store entry stays as-is; the
            // strip renderer will see no thumbnail and fall back.
          },
        );
        bakes.push(bake);
      }
      textBuf += TUG_ATOM_CHAR;
      atoms.push({
        kind: "atom",
        type: "image",
        label,
        value: label,
        id,
      });
    }
  }

  const thumbnailBake: Promise<void> =
    bakes.length === 0
      ? Promise.resolve()
      : Promise.allSettled(bakes).then(() => undefined);

  return { text: textBuf, atoms, thumbnailBake };
}
