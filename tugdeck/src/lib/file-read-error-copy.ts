/**
 * One sentence a reader can act on for each `FileReadErrorKind`.
 *
 * Every surface that can open a file — the Text card, and the Changes shade's
 * notes editor mode — owes the reader the same sentence for the same failure,
 * so the copy has one home rather than one per surface.
 *
 * **Its own module, deliberately, rather than a function in `file-io.ts`.** Four
 * store suites replace `@/lib/file-io` wholesale with `mock.module`, and a
 * `mock.module` leaks process-wide in bun — so an export added there fails to
 * link for every module loaded after one of those suites runs, which is a red
 * in a file that never touched either. Presentation copy is not I/O and does not
 * need to share the module anything mocks.
 */

/** Human-readable sentence for a read failure. `size` refines `too_large`. */
export function describeFileReadError(kind: string, size?: number): string {
  switch (kind) {
    case "not_found":
      return "The file does not exist.";
    case "denied":
      return "Tug can't open this file (permission refused or a protected file type).";
    case "binary":
      return "This file isn't text — binary content can't be edited here.";
    case "too_large":
      return `This file is too large to edit here${
        size !== undefined ? ` (${Math.round(size / (1024 * 1024))} MB)` : ""
      }.`;
    case "bad_path":
      return "That path isn't a file Tug can open.";
    case "network":
      return "Tug couldn't reach its file service.";
    default:
      return "The file couldn't be opened.";
  }
}
