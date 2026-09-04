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
 *    kinds whose value gives them away — a directory, a session and a
 *    commit — are recovered instead (see {@link mentionAtomType}).
 *  - `thumbnailBake`: a promise that resolves when all newly-fired
 *    thumbnail bakes have settled. Production callers fire-and-forget;
 *    tests can await for deterministic ordering.
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
   * Whether a callsign is one this client has seen — the discriminator that
   * recovers a session mention from a value shaped like a relative path (see
   * {@link mentionAtomType}). Injected rather than reached for so this module
   * stays pure and testable; the live path passes `sessionTagStore`'s known
   * set, and omitting it makes every mention a file, which is the behavior
   * that predates session atoms.
   */
  isKnownTag?: (tag: string) => boolean;
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
 * Atom type for a replayed `@`-mention. The wire doesn't carry the
 * original type, so it is recovered from the value's shape and, for a
 * session, from what the tag store knows.
 *
 * A directory mention's value always ends in `/` (tugcast's index form), so
 * directory chips round-trip. A session mention is `<project>/<callsign>`,
 * which is shaped exactly like a relative file path — nothing in the string
 * tells the two apart, and no marker grammar change could tell them apart
 * without giving the session a parallel mechanism, which is the one thing it
 * must not have. So the callsign is the discriminator: a two-segment value
 * whose tail is a tag this client has seen is a session. Collision needs a
 * real file named for a minted `adjective-noun` from the curated lexicon
 * sitting one directory deep, and the cost of one is a chip with the wrong
 * icon. Everything else defaults to `"file"`.
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
function mentionAtomType(
  value: string,
  isKnownTag?: (tag: string) => boolean,
): string {
  if (value.endsWith("/")) return "directory";
  if (isCommitSha(value)) return COMMIT_ATOM_TYPE;
  if (isKnownTag !== undefined) {
    const parts = value.split("/");
    if (parts.length === 2 && isKnownTag(parts[1])) return "session";
  }
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
  const isKnownTag = options?.isKnownTag;

  // Command-expansion echo: when claude expands a typed `/command`, it
  // rewrites the user turn to a `<command-name>` envelope rather than the
  // literal the editor sent. The atom type doesn't survive on the wire,
  // so reconstruct the command atom from the envelope here — yielding the
  // same command chip the editor showed (the bare `value` matches the
  // editor atom's, so optimistic and replayed echoes render identically).
  // Commands never ride the `@`-mention marker, so this is the only path
  // that re-mints a `command` atom. See {@link detectCommandEcho}.
  const commandEcho = detectCommandEcho(blocks);
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
        const type = mentionAtomType(seg.value, isKnownTag);
        echoAtoms.push({
          kind: "atom",
          type,
          label: mentionAtomLabel(type, seg.value),
          value: seg.value,
        });
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

  for (const block of blocks) {
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
        // kinds are recovered from the value's own shape instead — a
        // trailing `/` is a directory, a known callsign one segment
        // deep is a session, and a bare run of sha-shaped hex is a
        // commit, which also takes back its `commit:<8>` spelling.
        textBuf += TUG_ATOM_CHAR;
        const type = mentionAtomType(seg.value, isKnownTag);
        atoms.push({
          kind: "atom",
          type,
          label: mentionAtomLabel(type, seg.value),
          value: seg.value,
        });
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
