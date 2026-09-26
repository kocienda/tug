/**
 * The paths a tool result says landed.
 *
 * The path resolver has two doors an answer comes in through: a probe it
 * asked for, and the filesystem feed telling it the world moved. Both are
 * reports *about* a write that some other process made. This is the third,
 * and it is the only one where the deck watched the write happen: a `Write`
 * or an `Edit` that returned without an error wrote the file its input names,
 * and a shell result carrying a `TUG-FILE-RECEIPT` names every file the verb
 * behind it moved.
 *
 * It matters because of the order those two clocks run in. A turn that writes
 * a file names its path in the tool block *before* the file is on disk, the
 * annotator probes it then and records `missing`, and the verdict is trusted
 * for a minute — so a hand-off line printed at the end of the same turn reads
 * as pointing at nothing, and the menu over it is dimmed, until the retry
 * comes round. The write was never in doubt; nobody had told the resolver
 * about it.
 *
 * **Only what landed.** A `deleted` op names a path that is now gone and this
 * module returns nothing for it: the door is a confirm, and a removal is the
 * filesystem frame's to report, which it does by re-probing rather than by
 * asserting. A `renamed` op names its destination, which did land, and says
 * nothing here about the origin it left.
 *
 * Pure, so the reducer can call it: deciding what a result claims is not a
 * side effect, and handing the claim to the store is.
 *
 * @module lib/annotator/written-paths
 */

/** The stdout marker every `tugtool file` verb testifies with. */
const RECEIPT_PREFIX = "TUG-FILE-RECEIPT: ";

/**
 * The tools whose input's `file_path` is the file they wrote. Each returns
 * an error result when it did not write, which is the check the caller makes.
 */
const WRITING_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** The receipt ops that leave a file standing at `path`. */
const LANDING_OPS = new Set(["created", "modified", "renamed"]);

/** The `file_path` a writing tool's input names, when it names one. */
function filePathOf(input: unknown): string | null {
  if (input === null || typeof input !== "object") return null;
  const raw = (input as { file_path?: unknown }).file_path;
  return typeof raw === "string" && raw !== "" ? raw : null;
}

/**
 * Every path a `TUG-FILE-RECEIPT` line in `output` says landed.
 *
 * A result may carry more than one — `file run` emits one receipt per
 * command it watched — so every line is read, and a line whose JSON does not
 * parse is skipped rather than failing the rest.
 */
export function receiptPaths(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    const start = line.indexOf(RECEIPT_PREFIX);
    if (start === -1) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(start + RECEIPT_PREFIX.length));
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const ops = (parsed as { ops?: unknown }).ops;
    if (!Array.isArray(ops)) continue;
    for (const op of ops) {
      if (op === null || typeof op !== "object") continue;
      const { op: kind, path } = op as { op?: unknown; path?: unknown };
      if (typeof kind !== "string" || !LANDING_OPS.has(kind)) continue;
      if (typeof path === "string" && path !== "") paths.push(path);
    }
  }
  return paths;
}

/**
 * The paths one settled tool call says are now on disk, or an empty list
 * when it says nothing about any.
 *
 * `isError` is the whole of the check for a writing tool: the tools refuse
 * rather than half-write, so a result that is not an error is the tool's own
 * word that the file its input named is there.
 */
export function writtenPaths(
  toolName: string,
  input: unknown,
  result: unknown,
  isError: boolean,
): string[] {
  if (isError) return [];
  if (WRITING_TOOLS.has(toolName)) {
    const path = filePathOf(input);
    return path === null ? [] : [path];
  }
  return typeof result === "string" ? receiptPaths(result) : [];
}
