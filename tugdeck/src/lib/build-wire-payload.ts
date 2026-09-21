/**
 * `build-wire-payload` — pure flattening of the substrate's
 * `(text, atoms)` pair into Anthropic-API-shaped `ContentBlock[]`,
 * paired with a resolver mapping image-block index → originating atom
 * id.
 *
 * ## What this module does
 *
 * The substrate stores user input in two parallel halves: a string
 * with `U+FFFC` (object replacement character) placeholders at every
 * atom position, and a parallel `AtomSegment[]` whose entries carry
 * the chip data. The substrate keeps both halves because the
 * editor's chip renderer walks `text` looking for `U+FFFC` and reads
 * the corresponding atom for placement — substituting in the
 * substrate would erase the chip-position information.
 *
 * The wire, by contrast, is Anthropic's content-block array: an
 * ordered sequence of `{ type: "text", text }` and
 * `{ type: "image", source }` blocks. To preserve image-atom
 * **positions** through JSONL round-trip (Anthropic records `messages`
 * verbatim), this builder emits **interleaved** blocks rather than
 * flattening all images into a leading attachment list. The shape
 * lands in claude's JSONL unchanged; restoring an interleaved
 * sequence reconstitutes which slots in the message were image atoms
 * without any side-channel substrate journaling.
 *
 * Per [Step 5c](arc/dev-atoms.md#step-5c) and
 * [Spec S03](arc/dev-atoms.md#s03-build-wire-payload) (revised).
 *
 * ## Atom-to-wire mapping
 *
 * The discriminator is **bytes in the store, not atom type**: any
 * atom whose `id` resolves to a bytes-store entry emits a standalone
 * `image` block at its position; all other atoms substitute their
 * `value` into the surrounding text block.
 *
 *  - `image` + id + bytes (drop / paste of an image) → standalone
 *    `image` content block at the atom's position. The surrounding
 *    text blocks have the atom's `U+FFFC` removed.
 *  - `file` / `doc` (no id — `@`-completion of a workspace path) →
 *    `atom.value` substituted into the current text block. Claude's
 *    `Read` tool fetches the path on demand.
 *  - `file` + id + bytes (drop of a `.md` / source file from Finder) →
 *    today: same as the no-id case — substitute the label / path into
 *    text. (Inline text-file attachments rode the legacy `Attachment`
 *    `text/*` shape; the content-block wire doesn't carry a parallel
 *    `text-file` source. We can revisit if a need arises.)
 *  - `image` (no id; defensive) → substituted text only.
 *  - `link` → substituted text (the URL).
 *  - `session` → a TYPED mention marker,
 *    `` `@session:<project>/<callsign>` ``. The one kind whose type rides
 *    the wire, because a session's value is spelled like a relative path
 *    and nothing in it tells a replay what it is. See
 *    {@link wrapSessionMention}.
 *  - `command` → a clean `/<name>` string (not the mention marker), so
 *    claude expands it as a user-invoked slash command. See
 *    {@link commandWireText}.
 *
 * ## The trailing reference block
 *
 * A message carrying any session atom ends with one extra text block — the
 * `tug:session-refs` fact sheet, naming each distinct reference's uuid,
 * project dir and verdict. A marker is a NAME, and the model holds no ledger
 * to look a callsign up in; the block is what makes the reference actionable.
 * A message with no session atom gets no block and is byte-identical to what
 * it was before this existed. See `session-ref-block.ts`, and
 * `synthesize-user-message.ts` for the strip on the way back in.
 *
 * ## Returned `atomIdAt` resolver
 *
 * The walk that produces blocks also tracks which atoms became image
 * blocks (atoms with bytes in the store) and in what order. The
 * returned `atomIdAt(imageBlockIndex)` is a closure over that
 * mapping; passing it to `synthesizeUserMessageFromBlocks` ensures
 * the synthesized substrate's atoms reuse the editor's original atom
 * ids — bytes-store entries from drop / paste stay live across the
 * submit boundary instead of orphaning under fresh UUIDs.
 *
 * The resolver returns `undefined` for any index outside the
 * emitted image-block range (defensive against caller bugs).
 *
 * ## Invariants per [Spec S03] (revised)
 *
 *  - **Pure on inputs.** The bytes-store is read-only here; mutations
 *    live in the drop / paste / synthesizer paths. Same inputs always
 *    yield the same `(content, atomIdAt)` pair.
 *  - **No `U+FFFC` in any text block** when `atoms.length` matches
 *    `count(U+FFFC, text)`. The substrate maintains this on every
 *    state mutation; we walk in lockstep.
 *  - **Defensive on count mismatch.** If `atoms.length <
 *    count(U+FFFC, text)`, extra `U+FFFC` chars pass through into the
 *    current text block (visible-regression rather than crash).
 *  - **Adjacent text segments coalesce.** A walk over alternating
 *    text + atom produces one text block per contiguous text run —
 *    consecutive image atoms emit consecutive image blocks with no
 *    empty text block between them; an image at the start or end of
 *    text doesn't generate an empty surrounding text block.
 *  - **Silent skip on missing bytes.** An image atom whose id is not
 *    in the store contributes only its substituted text to the
 *    current text block — no image block, and `atomIdAt` doesn't
 *    count this position.
 *
 * ## Why this lives outside the reducer
 *
 * The reducer is pure with no side effects. The bytes-store IS
 * external state — looking up bytes by id is a side-effecting read.
 * Doing the read here, in the impure store wrapper
 * (`CodeSessionStore.send`), keeps the reducer pure.
 *
 * Laws: [L02] — bytes-store is external state, not React-observable.
 *       [L07] — `code-session-store.send` reads the live store at the
 *       moment of dispatch. [L19] — file structure / docstring
 *       discipline.
 */

import type { ContentBlock } from "@/protocol";
import { TUG_ATOM_CHAR, type AtomSegment } from "./tug-atom-img";
import type { AtomBytesStore } from "./atom-bytes-store";
import { wrapAtomMention, wrapSessionMention } from "./atom-mention-marker";
import { commandWireText } from "./command-atom";
import { isSessionAtomType } from "./session-atom-shape";
import {
  buildSessionRefBlock,
  type SessionRefEntry,
  type SessionRefVerdict,
} from "./session-ref-block";

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------

/**
 * Wire payload built by {@link buildWirePayload}. The `content` array
 * is forwarded verbatim on the `user_message` IPC frame; the
 * `atomIdAt` resolver is consumed by the synthesizer so the
 * synthesized substrate reuses the editor's original atom ids.
 */
export interface WirePayload {
  content: ContentBlock[];
  /**
   * For each image block in `content`, the originating
   * `AtomSegment.id`. Index is the 0-based position of the image
   * block among image blocks (not among all blocks). Returns
   * `undefined` for any index outside the emitted range.
   */
  atomIdAt: (imageBlockIndex: number) => string | undefined;
}

/** Optional knobs for {@link buildWirePayload}. */
export interface WirePayloadOptions {
  /**
   * What the client knows about one session atom, at the moment of the send.
   *
   * Injected rather than reached for so this module stays pure: the live path
   * passes a reader over `sessionCitationStore`, and omitting it makes every
   * reference `unverified`, which is the honest answer for a caller that
   * holds no verdicts rather than a claim that the sessions are absent.
   */
  sessionVerdict?: (atom: AtomSegment) => {
    verdict: SessionRefVerdict;
    sessionId?: string;
    projectDir?: string;
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Build the wire-ready `ContentBlock[]` from the substrate's
 * `(text, atoms)` form.
 *
 * Walks `text` character-by-character. A `U+FFFC` consumes the next
 * atom; an image atom (id + bytes in the store) closes any pending
 * text block, emits an image block, and opens a fresh text
 * accumulator. A non-image (or bytes-less) atom appends its `value`
 * wrapped as a backtick-`@` mention marker (`` `@<value>` `` — see
 * {@link wrapAtomMention}) into the current text accumulator, so the
 * atom's position and value round-trip through JSONL on replay.
 * Single pass, O(n) in `text.length`.
 */
export function buildWirePayload(
  text: string,
  atoms: ReadonlyArray<AtomSegment>,
  bytesStore: AtomBytesStore,
  options?: WirePayloadOptions,
): WirePayload {
  const content: ContentBlock[] = [];
  // Per-image-block atom id, captured during the walk so the
  // resolver mirrors exactly which atoms became blocks.
  const imageBlockAtomIds: Array<string | undefined> = [];
  let textBuf = "";
  let atomIdx = 0;
  // Distinct session atoms, in first-appearance order — the reference block's
  // rows. Keyed by `value`, which is the spelling the marker carries, so two
  // chips naming one session earn one line rather than two.
  const sessionAtoms = new Map<string, AtomSegment>();

  function flushText(): void {
    if (textBuf.length > 0) {
      content.push({ type: "text", text: textBuf });
      textBuf = "";
    }
  }

  // Walk characters via `for…of` so surrogate pairs (emoji, rare
  // CJK) don't accidentally split a code point. `U+FFFC` is in the
  // Basic Multilingual Plane (a single 16-bit code unit), so the
  // visit count for that char is unchanged either way; but using the
  // code-point iterator is safer for future UTF-16 edge cases.
  for (const ch of text) {
    if (ch !== TUG_ATOM_CHAR) {
      textBuf += ch;
      continue;
    }
    const atom = atoms[atomIdx];
    if (atom === undefined) {
      // Defensive: `U+FFFC` with no paired atom passes through into
      // the current text block. Substrate maintains parity; this is
      // the visible-regression branch.
      textBuf += ch;
      continue;
    }
    atomIdx += 1;
    const bytes = atom.id !== undefined ? bytesStore.get(atom.id) : null;
    // `content.length > 0` skips preview-only entries — a recalled image
    // re-seeded from a durable history thumbnail carries a thumbnail but no
    // full bytes, so it can't be re-sent. It falls through to a mention
    // marker rather than shipping an empty `image` block.
    if (
      atom.type === "image" &&
      bytes !== null &&
      bytes.content.length > 0 &&
      atom.id !== undefined
    ) {
      flushText();
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: bytes.mediaType,
          data: bytes.content,
        },
      });
      imageBlockAtomIds.push(atom.id);
      continue;
    }
    // A `command` atom must reach claude as a *clean* slash-command
    // string — claude's CLI expands `/plugin:skill` into a user-invoked
    // skill (bypassing a skill's `disable-model-invocation` guard) only
    // when the message text is exactly the command. The mention marker
    // (`` `@/tugplug:commit` ``) defeats expansion: the literal text
    // reaches the model, which then tries the Skill tool and is refused
    // on any `disable-model-invocation` skill. Emit the bare `/name` so
    // expansion fires. Round-trip-to-chip on replay is moot — claude
    // rewrites the turn to the expanded `<command-name>` echo, which the
    // transcript reconstructs into a command chip separately.
    if (atom.type === "command") {
      textBuf += commandWireText(atom.value);
      continue;
    }
    // A session atom names its type on the wire. Every other kind is
    // recovered on replay from its value's own shape, and a session's value
    // — `<project>/<callsign>` — has the shape of a relative file path, so
    // there is nothing to recover it from. Before this, the replay asked the
    // local tag store, which made the chip depend on what the reading client
    // had seen rather than on what the JSONL said.
    if (isSessionAtomType(atom.type)) {
      textBuf += wrapSessionMention(atom.value);
      if (!sessionAtoms.has(atom.value)) sessionAtoms.set(atom.value, atom);
      continue;
    }
    // Non-image, bytes-less, or otherwise not promoted to an image
    // block — substitute the atom's value into the current text run
    // wrapped as a backtick-`@` mention marker so the atom's position
    // and value round-trip through JSONL on replay. See
    // {@link wrapAtomMention} for the marker syntax + rationale; the
    // substrate synthesizer reverses this on the way back via
    // {@link parseAtomMentionSegments}.
    textBuf += wrapAtomMention(atom.value);
  }
  flushText();

  // The reference block is one trailing text block, after every block the
  // message itself produced. It resolves each marker to a uuid the model can
  // act on, and it is written only when there is a reference to resolve — a
  // message with no session atom is byte-identical to what it was before this
  // block existed.
  const refEntries: SessionRefEntry[] = [];
  for (const atom of sessionAtoms.values()) {
    const answer = options?.sessionVerdict?.(atom);
    refEntries.push({
      value: atom.value,
      verdict: answer?.verdict ?? "unverified",
      // The atom's own identity first: it was minted from the ledger and is
      // what this client is surest of. A store answer fills the gap for an
      // atom that arrived by replay, carrying the name alone.
      sessionId: atom.session?.id ?? answer?.sessionId,
      projectDir: atom.session?.projectDir ?? answer?.projectDir,
    });
  }
  const refBlock = buildSessionRefBlock(refEntries);
  if (refBlock !== null) content.push({ type: "text", text: refBlock });

  return {
    content,
    atomIdAt: (i) => imageBlockAtomIds[i],
  };
}
