/**
 * `PromptInsertTarget` — the composer an entity is sent into, named by what
 * the gesture needs of it rather than by which composer it is.
 *
 * `Insert Atom into Prompt` and its siblings used to take a
 * {@link CodeSessionStore}, which is why the Overview never offered them: the
 * Overview has no session, so the item was filtered out of its menu and the
 * feature was skipped rather than adapted. But nothing about sending a file
 * reference into a composer is a fact about a session. Three operations are
 * the whole of what the menu and the click layer ask:
 *
 *  - **insert an atom** — the chip an `@` mention mints, at the caret;
 *  - **insert text** with the atoms standing in it, at a point or appended;
 *  - **raise** the composer that is about to receive it, so the prompt the
 *    entity lands in is the one the user is looking at.
 *
 * Those three are the whole of the required interface, and a composer that
 * can do them can be sent to. The Session card satisfies it through
 * {@link sessionPromptInsertTarget}, an adapter over the store's own
 * pending-insert slots, so the Session path is byte-for-byte what it was.
 * The Overview satisfies it over its editor delegate.
 *
 * **`insertCommand`, `runCommand` and `insertFiles` are optional, and that is
 * the seam between the two.** Seeding a clicked slash or shell command as a
 * ready-to-run draft — and running one outright — is a session semantic:
 * the Overview protocol has no commands to run, so a target that cannot do
 * it simply does not offer it, and the registry's `seedCommand` returns
 * without one. Taking a dropped file is the same kind of fact: it needs an
 * attachment pipeline, which not every composer has. Every other operation
 * is required, because every composer can do them.
 *
 * @module lib/prompt-insert-target
 */

import type { AtomSegment } from "@/lib/tug-text-types";
import type { CodeSessionStore } from "@/lib/code-session-store";
import { dictationHandleFor } from "@/components/tugways/tug-text-editor/dictation-span";

/** A point in client coordinates — a drop's, resolved to a document offset. */
export interface PromptInsertPoint {
  x: number;
  y: number;
}

/** A composer an annotation can be sent into. */
export interface PromptInsertTarget {
  /**
   * Drop one atom at the caret. Additive: an in-progress draft survives it,
   * because an atom is one more thing the prompt mentions.
   */
  insertAtom(segment: AtomSegment): void;
  /**
   * Insert `text` with `atoms` standing in it — at the document offset `at`
   * resolves to, or appended when `at` is `null` (an empty composer takes the
   * text as-is, a mid-compose draft gets it on its own line).
   */
  insertText(
    text: string,
    atoms: ReadonlyArray<AtomSegment>,
    at: PromptInsertPoint | null,
  ): void;
  /** Bring the receiving composer forward before typing into it. */
  raise(): void;
  /**
   * Seed a clicked command as a ready-to-run draft. Omitted by a composer
   * with no commands to run; the caller then does nothing rather than
   * inventing a text insert that would submit as prose.
   */
  insertCommand?(name: string, args: string): void;
  /**
   * Seed a command as a draft and SEND it, as this composer's next turn.
   * Optional on the same seam and for the same reason as `insertCommand`: a
   * composer with no turns to take has nothing to run. A caller that finds
   * it absent does nothing — a menu row that would have called it is dimmed
   * rather than dropped, so what the surface cannot do is visible.
   */
  runCommand?(name: string, args: string): void;
  /**
   * Hand dropped files to the composer, to land at the caret through
   * whatever pipeline that composer uses for an attachment — images become
   * atoms, other files their basename, and this seam decides none of that.
   * Additive, like {@link insertAtom}: an in-progress draft survives it.
   *
   * Optional on the same seam and for the same reason as `insertCommand` /
   * `runCommand`: a composer with no attachment pipeline has nothing to do
   * with a file. A caller that finds it absent declines the drop — leaves
   * `preventDefault` uncalled, so the drag reads as refused — rather than
   * accepting a payload it cannot deliver.
   */
  insertFiles?(files: readonly File[]): void;
  /**
   * Take dictated speech, as it is being recognised.
   *
   * Optional on the same seam and for the same reason as `insertCommand` /
   * `runCommand` / `insertFiles`: a composer without a live editor behind it
   * has nowhere to put provisional text, and the mic button renders nothing
   * when this is absent rather than offering a microphone whose output has
   * nowhere to land.
   *
   * It is a **handle** and not a method, because dictation is the one
   * operation here that is a *session* rather than an act. Every other member
   * of this interface happens once and is over; this one opens, receives a
   * stream of revisions, and closes — and the tail it has most recently shown
   * has to be replaceable, which means the composer keeps state for the
   * duration and the store needs one object to talk to about it.
   */
  dictation?: DictationHandle;
}

/**
 * The composer's end of a dictation session: a span it owns, and four things
 * the store can tell it.
 *
 * Every call goes straight into the editor and none of them goes through React
 * ([L06]) — a recogniser revises its reading several times a second, and a
 * render per revision would repaint the composer under the user's hands. The
 * per-event work belongs inside CodeMirror, which is the whole argument for
 * putting it behind a handle ([P05]).
 */
export interface DictationHandle {
  /**
   * Open the span. Called before the host is asked to start, so the caret is
   * already parked where the text will land by the time any arrives.
   */
  begin(): void;
  /**
   * Show `text` as the provisional tail, replacing whatever the last call
   * showed. Provisional text is visibly unsettled and is not part of the
   * draft the composer would submit.
   */
  volatile(text: string): void;
  /**
   * Settle `text` into the draft, replacing the provisional tail. Settled
   * text is ordinary draft content from here on — the user can edit it, and a
   * submit carries it.
   */
  final(text: string): void;
  /**
   * Close the span. Everything already settled stays either way; `promote`
   * decides what becomes of a tail the recogniser never called settled.
   *
   * `false` **drops** it — the truncating ends, which are Escape and the
   * involuntary ones. `true` **promotes** it to ordinary draft text — the
   * ends where the user said they were done and the recogniser's settled
   * reading could not be waited for.
   */
  end(promote: boolean): void;
}

/**
 * The Session card's target: the store's pending-insert slots, which
 * `TugPromptEntry` already observes and consumes. `raise` is supplied by the
 * caller because bringing a card forward is the deck's act and the store
 * knows nothing about decks.
 */
export function sessionPromptInsertTarget(
  store: CodeSessionStore,
  raise: () => void,
): PromptInsertTarget {
  return {
    insertAtom: (segment) => store.insertAtomDraft(segment),
    insertText: (text, atoms, at) => store.insertJot(text, atoms, at),
    raise,
    insertCommand: (name, args) => store.insertCommandDraft(name, args),
    runCommand: (name, args) => store.runCommandDraft(name, args),
    insertFiles: (files) => store.insertFiles(files),
    // The store's `editorView` is the entry's own view, bound in its editor
    // ref callback. Read per call, so a session that outlives a remount
    // writes into the live editor rather than a detached one.
    dictation: dictationHandleFor(() => store.editorView()),
  };
}
