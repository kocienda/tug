/**
 * The `FILESYSTEM` feed's wire shape — one decoder, for every consumer.
 *
 * tugcast's `FileWatcher` broadcasts what happened under each watched
 * workspace and `FilesystemFeed` forwards it as a `FILESYSTEM` frame
 * (`FeedId.FILESYSTEM`, `0x10`). The frame carries the workspace it speaks
 * for and a batch of events; every path inside is **relative to that
 * workspace**, which is why {@link frameRoot} exists rather than each
 * consumer remembering to trim the key's trailing slash.
 *
 * This module is only the decode. What an event *means* is the consumer's:
 * a Text card asks whether its own file moved; the path resolver asks which
 * of its verdicts the world just contradicted. Both read the same bytes the
 * same way, which is the point — a second decoder is a second thing to be
 * wrong about the wire.
 *
 * @module lib/filesystem-feed
 */

/**
 * One `FILESYSTEM` event.
 *
 * `path` is present for `Created` / `Modified` / `Removed`; `from` and `to`
 * for a `Renamed` (the Linux/Windows path — macOS FSEvents delivers renames
 * as `Removed` + `Created` pairs instead). The kinds are the producer's own
 * spellings, capitalized: see `FsEvent` in `tugcast-core/src/types.rs`.
 */
export interface FilesystemEvent {
  kind: string;
  path?: string;
  from?: string;
  to?: string;
}

/** One `FILESYSTEM` frame, after the workspace_key splice. */
export interface FilesystemFrame {
  workspace_key: string;
  events: FilesystemEvent[];
}

/**
 * Parse a `FILESYSTEM` frame payload; `null` when malformed.
 *
 * Field-by-field rather than a cast: the wire is a trust boundary, an event
 * naming nothing is dropped rather than carried as a hole, and a frame that
 * does not parse is silence rather than a throw in a feed callback.
 */
export function parseFilesystemFrame(
  payload: Uint8Array,
): FilesystemFrame | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payload)) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.workspace_key !== "string") return null;
    if (!Array.isArray(obj.events)) return null;
    const events: FilesystemEvent[] = [];
    for (const raw of obj.events) {
      if (raw === null || typeof raw !== "object") continue;
      const e = raw as Record<string, unknown>;
      if (typeof e.kind !== "string") continue;
      if (
        typeof e.path !== "string" &&
        typeof e.from !== "string" &&
        typeof e.to !== "string"
      ) {
        continue;
      }
      events.push({
        kind: e.kind,
        path: typeof e.path === "string" ? e.path : undefined,
        from: typeof e.from === "string" ? e.from : undefined,
        to: typeof e.to === "string" ? e.to : undefined,
      });
    }
    return { workspace_key: obj.workspace_key, events };
  } catch {
    return null;
  }
}

/**
 * The absolute directory a frame's relative paths are joined onto — the
 * workspace key with any trailing separator taken off, so the join is one
 * `/` rather than two.
 */
export function frameRoot(frame: FilesystemFrame): string {
  return frame.workspace_key.replace(/\/+$/, "");
}
