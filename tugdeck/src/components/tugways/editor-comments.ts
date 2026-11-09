/**
 * editor-comments.ts — Un/Comment Lines and Un/Comment Block, the comment
 * pair both CM6 editing surfaces bind.
 *
 * Both are CM6's own commands (`toggleLineComment`, `toggleBlockComment`),
 * which read the active language's `commentTokens` language data, so the
 * comment syntax follows the document: `//` in Rust, `#` in Python, and in
 * Markdown, which declares only a block comment, `<!-- -->`. Neither falls
 * back to the other — a language with no line comment has no Un/Comment
 * Lines, and its menu item dims rather than writing a block comment the
 * user did not ask for.
 *
 * The commands are wrapped as transaction specs over an `EditorState`, the
 * shape `editor-quote-lines.ts` gives the quote pair, so each press is one
 * transaction (⌘Z reverts it whole) and both are testable as pure logic.
 *
 * Both the prompt substrate (`tug-text-editor.tsx`) and the file editor
 * (`tug-text-card-editor.tsx`) dispatch these from their responder handlers
 * for `toggle-line-comment` / `toggle-block-comment`.
 *
 * @module components/tugways/editor-comments
 */

import { toggleBlockComment, toggleLineComment } from "@codemirror/commands";
import { Transaction } from "@codemirror/state";
import type { EditorState, StateCommand, TransactionSpec } from "@codemirror/state";

/** The shape of CM6's `commentTokens` language data. */
interface CommentTokens {
  line?: string;
  block?: { open: string; close: string };
}

/** The tokens the language at the main selection's head declares. */
function commentTokens(state: EditorState): readonly CommentTokens[] {
  return state.languageDataAt<CommentTokens>("commentTokens", state.selection.main.head);
}

/** Whether the language at the caret has a line comment to toggle. */
export function hasLineComment(state: EditorState): boolean {
  return commentTokens(state).some((tokens) => tokens.line !== undefined);
}

/** Whether the language at the caret has a block comment to toggle. */
export function hasBlockComment(state: EditorState): boolean {
  return commentTokens(state).some((tokens) => tokens.block !== undefined);
}

/** Run a CM6 state command against `state` and keep what it would dispatch. */
function specOf(command: StateCommand, state: EditorState): TransactionSpec | null {
  let spec: TransactionSpec | null = null;
  command({
    state,
    dispatch: (tr) => {
      spec = {
        changes: tr.changes,
        selection: tr.selection,
        userEvent: tr.annotation(Transaction.userEvent),
        scrollIntoView: true,
      };
    },
  });
  return spec;
}

/**
 * The Un/Comment Lines transaction for `state`: every touched line gains the
 * language's line comment, or loses it when all of them already carry one.
 * Null on a read-only document, or when the language has no line comment.
 */
export function toggleLineCommentSpec(state: EditorState): TransactionSpec | null {
  return specOf(toggleLineComment, state);
}

/**
 * The Un/Comment Block transaction for `state`: the selection is wrapped in
 * the language's block comment tokens, or unwrapped when it already is.
 * Null on a read-only document, or when the language has no block comment.
 */
export function toggleBlockCommentSpec(state: EditorState): TransactionSpec | null {
  return specOf(toggleBlockComment, state);
}
