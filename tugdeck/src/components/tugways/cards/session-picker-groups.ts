/**
 * The Choose Session sheet's project groups, as data.
 *
 * The sheet is one list of sessions grouped by project, and which projects it
 * shows is decided here: the workspace's own projects first — every project a
 * bound card in this deck has open, frontmost first — then the recent
 * projects in their stored order, minus any already shown, and nothing else
 * the list adds on its own — save that when neither names a project, the
 * seed's last rungs (the default-project setting, the host's hint, home) do,
 * so a first launch opens on somewhere rather than on an empty list. The one
 * other group is a folder the user TYPED behind the "another folder" row: it
 * is listed last, beside the field that named it, so what that folder already
 * holds is in view before a session is started there. A project is a group
 * whether or not it holds sessions, so a workspace project with none still
 * offers somewhere to start one.
 *
 * A group is a DIRECTORY, not a spelling. One directory reached through a
 * symlink and through its target is two strings and one project, and only the
 * server can say so ([L29]), so every candidate path is identified by its
 * canonical spelling from the server's gateway (`canonical-dir-store`) and a
 * group's `projectDir` is that spelling — the one it is listed, compared and
 * opened under. Until the server has answered, a path stands for itself.
 *
 * Each group's rows come from its own `list_sessions` listing: there is no
 * cross-project listing on the wire, and the store already caches one
 * snapshot per path. So a group settles on its own, and until it does it
 * says so rather than reading as empty.
 *
 * The derivations are pure functions over data, so the sheet's render and a
 * read taken outside one ({@link readPickerGroupSpecs}) agree; the hook
 * ({@link usePickerGroups}) only feeds them their live inputs.
 *
 * @module components/tugways/cards/session-picker-groups
 */

import { useMemo } from "react";

import { basename } from "@/lib/display-path";
import {
  canonicalDirStore,
  readCanonicalOf,
  useCanonicalDirs,
  type CanonicalOf,
} from "@/lib/canonical-dir-store";
import {
  useWorkspaceProjectDirs,
  workspaceProjectDirs,
} from "@/lib/frontmost-project";
import {
  useSessionLedgers,
  type WorkspaceSnapshot,
} from "@/lib/session-ledger-store";
import type { SessionRow } from "@/protocol";

import {
  readFallbackProjectDir,
  readRecents,
  useFallbackProjectDir,
  useRecents,
} from "./session-picker-seed";

/** Which project a group is, and why it is in the sheet. */
export interface PickerGroupSpec {
  projectDir: string;
  /** Open in a bound card of the workspace the sheet stands in. */
  inWorkspace: boolean;
  /** Named by the user in the "another folder" field, not by the deck or the recents. */
  typed?: boolean;
  /**
   * The seed's last rungs standing in for a list that named nothing — the
   * default-project setting, the host's hint, or home. Not a recent project,
   * so there is nothing to remove it from.
   */
  fallback?: boolean;
}

/**
 * The groups the sheet shows, in order: the workspace's projects, then the
 * recents not already among them — or, when those two name nothing, the
 * fallback project — then the typed folder when it is none of those.
 * Every path is identified by `canonicalOf` — the server's canonical spelling
 * ([L29]) — and a group's `projectDir` is that identity, so two spellings of
 * one directory are one group whichever list named it first. Empty paths are
 * dropped. The first group is the seed path (`seedPathFrom`), by construction.
 */
export function pickerGroupSpecsFrom(
  workspaceDirs: readonly string[],
  recents: readonly string[],
  fallbackDir = "",
  typedDir = "",
  canonicalOf: CanonicalOf = (path) => path,
): PickerGroupSpec[] {
  const specs: PickerGroupSpec[] = [];
  const seen = new Set<string>();
  const add = (spec: PickerGroupSpec): void => {
    if (spec.projectDir === "" || seen.has(spec.projectDir)) return;
    seen.add(spec.projectDir);
    specs.push(spec);
  };
  const id = (dir: string): string => (dir === "" ? "" : canonicalOf(dir));
  for (const dir of workspaceDirs) add({ projectDir: id(dir), inWorkspace: true });
  for (const dir of recents) add({ projectDir: id(dir), inWorkspace: false });
  if (specs.length === 0) {
    add({ projectDir: id(fallbackDir), inWorkspace: false, fallback: true });
  }
  add({ projectDir: id(typedDir), inWorkspace: false, typed: true });
  return specs;
}

/**
 * The groups that open unfolded: the workspace's, or — when no card in the
 * workspace is bound — the first group, so the sheet always opens on one.
 */
export function defaultOpenDirs(specs: readonly PickerGroupSpec[]): string[] {
  const workspace = specs.filter((s) => s.inWorkspace).map((s) => s.projectDir);
  if (workspace.length > 0) return workspace;
  return specs.length > 0 ? [specs[0].projectDir] : [];
}

/**
 * Where a group's listing stands. `pending` until its first `list_sessions`
 * settles; `missing` when the host says the directory is not there, which
 * outranks the rows (there are none to offer, and Open would fail);
 * `error` when the listing failed; `ready` otherwise.
 */
export type PickerGroupStatus = "pending" | "ready" | "missing" | "error";

/** One group as the sheet draws it. */
export interface PickerGroup extends PickerGroupSpec {
  /** The project's name: the path's last segment. */
  name: string;
  status: PickerGroupStatus;
  /**
   * The sessions the sheet lists for the group — those with resumable
   * content ({@link hasResumableContent}) — in the ledger's newest-first
   * order. Empty unless `ready`.
   */
  rows: readonly SessionRow[];
  /**
   * Every row the listing holds, shown or not. The Trash sweep takes these:
   * a session with nothing in it is not listed, but it is still the group's.
   */
  listed: readonly SessionRow[];
  /** Listed sessions open right now, in Tug or in a terminal. */
  live: number;
  /** Listed sessions that could be moved to the Trash: those not live. */
  trashable: number;
  /** The host is still scanning on-disk transcripts for this folder. */
  scanning: boolean;
  /** How far that scan has got, when the host has said. */
  scanProgress?: { parsed: number; total: number };
}

const NO_ROWS: readonly SessionRow[] = Object.freeze([]);

/**
 * Whether a group is one of the recent projects, and so carries the band's
 * remove-from-recents button: the workspace's own projects are there because a
 * bound card is, and a typed folder or the fallback was never in the recents.
 */
export function isRecentGroup(spec: PickerGroupSpec): boolean {
  return !spec.inWorkspace && spec.typed !== true && spec.fallback !== true;
}

/** Whether a row is open right now — such a row can be neither trashed nor resumed twice. */
export function isLiveSessionRow(row: SessionRow): boolean {
  return row.state === "live" || row.terminal_live !== null;
}

/**
 * Whether a session has anything to resume, by ANY signal: on-disk bytes, a
 * canonical turn, or a live process. Only a truly empty row — an opened and
 * closed card with nothing in it — is left out of the list.
 */
export function hasResumableContent(row: SessionRow): boolean {
  return (row.file_size ?? 0) > 0 || row.turn_count > 0 || row.state === "live";
}

/** A group's facts, from its spec and its listing's snapshot. */
export function pickerGroupFrom(
  spec: PickerGroupSpec,
  snapshot: WorkspaceSnapshot,
): PickerGroup {
  const name = basename(spec.projectDir) || spec.projectDir;
  const status: PickerGroupStatus =
    snapshot.dirExists === false
      ? "missing"
      : snapshot.status === "ready"
        ? "ready"
        : snapshot.status === "error"
          ? "error"
          : "pending";
  const listed = status === "ready" ? snapshot.rows : NO_ROWS;
  const rows = listed.length === 0 ? NO_ROWS : listed.filter(hasResumableContent);
  const live = rows.filter(isLiveSessionRow).length;
  return {
    ...spec,
    name,
    status,
    rows,
    listed,
    live,
    trashable: rows.length - live,
    scanning: snapshot.scanning === true,
    scanProgress: snapshot.scanProgress,
  };
}

/**
 * The group set as it stands, read outside a render (no typed folder: none is
 * typed yet), and whether the server has named every candidate's canonical
 * spelling — until it has, two spellings of one directory may still read as
 * two groups.
 */
export function readPickerGroupSpecs(): { specs: PickerGroupSpec[]; resolved: boolean } {
  const workspaceDirs = workspaceProjectDirs();
  const recents = readRecents();
  const fallbackDir = readFallbackProjectDir();
  const resolved = canonicalDirStore.allResolved([
    ...workspaceDirs,
    ...recents,
    fallbackDir,
  ]);
  return {
    specs: pickerGroupSpecsFrom(workspaceDirs, recents, fallbackDir, "", readCanonicalOf),
    resolved,
  };
}

/**
 * The sheet's groups, live: the group set from the workspace's bound cards,
 * the recents and the typed folder, each with its own listing's facts ([L02]
 * — both stores and every listing are read through `useSyncExternalStore`).
 * Reading a group's listing is what asks for it, so the fan-out happens here.
 */
export function usePickerGroups(typedDir = ""): readonly PickerGroup[] {
  const workspaceDirs = useWorkspaceProjectDirs();
  const recents = useRecents();
  const fallbackDir = useFallbackProjectDir();
  const canonicalOf = useCanonicalDirs();
  const specs = useMemo(
    () => pickerGroupSpecsFrom(workspaceDirs, recents, fallbackDir, typedDir, canonicalOf),
    [workspaceDirs, recents, fallbackDir, typedDir, canonicalOf],
  );
  const dirs = useMemo(() => specs.map((s) => s.projectDir), [specs]);
  const snapshots = useSessionLedgers(dirs);
  return useMemo(
    () => specs.map((spec, i) => pickerGroupFrom(spec, snapshots[i])),
    [specs, snapshots],
  );
}
