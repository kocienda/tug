/**
 * `useArcStatements` — make the statements of arcs in one markdown block live.
 *
 * A `tugarcs` fence is drawn by the markdown enhance pass, which knows nothing
 * of the card it is in, so the frame it builds names each arc and says nothing
 * of where it stands. This hook is the card's half: handed to the block as
 * `onAnnotated`, it adopts the frames after every pass and writes each row
 * from the cycles of the card's project, and, for an arc no entry names, from
 * what the project's arc log says became of it.
 *
 * Laws:
 *  - [L22] the stores drive DOM writes, so they are observed directly and
 *    nothing round-trips through a render.
 *  - [L06] a row's state is its `data-state` and its word, written by the
 *    sync, never React state.
 *  - [L03] the store subscriptions are made in a layout effect, before the
 *    first pass could read them.
 *  - [L07] the sync reads the project and the container through refs.
 *  - [L27] both subscriptions hand back a release, called when the block
 *    unmounts or the project changes.
 *
 * @module components/tugways/cards/use-arc-statements
 */

import React from "react";

import { arcCitationStore } from "@/lib/arc-citation-store";
import { arcRowReading, entryForArc, type ArcRowReading } from "@/lib/arc-statement";
import { getChangesetAllStore } from "@/lib/changeset-all-store";
import type { CycleWire } from "@/lib/changeset-types";
import { cycleIndex } from "@/lib/cycle-store";
import { arcStatementFrames, syncArcStatementFrame } from "@/lib/markdown/enhance-arc-statement";

const NO_CYCLES: readonly CycleWire[] = Object.freeze([]);

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * Whether a cycle of `cycleDir` is the project of a card at `root`: the same
 * checkout, or an arc's worktree inside it, whose cycles are its checkout's.
 */
export function isCycleOfProject(cycleDir: string, root: string): boolean {
  const cycle = trimSlash(cycleDir);
  const card = trimSlash(root);
  return card === cycle || card.startsWith(`${cycle}/.tug/worktrees/`);
}

/** The cycles of the project at `root`, from the aggregate as it stands. */
function projectCycles(root: string): readonly CycleWire[] {
  const store = getChangesetAllStore();
  if (store === null) return NO_CYCLES;
  return cycleIndex(store.getSnapshot()).all.filter((cycle) => isCycleOfProject(cycle.project_dir, root));
}

/**
 * `projectDir` is the card's project, the root its annotation context resolves
 * references against; with none, no row can be read and the frames stay as
 * the enhance pass built them.
 *
 * Returns the callback to hand `TugMarkdownBlock` as `onAnnotated`.
 */
export function useArcStatements(projectDir: string | null): (container: HTMLElement) => void {
  const root = React.useRef(projectDir);
  root.current = projectDir;

  /** The container last annotated. */
  const container = React.useRef<HTMLElement | null>(null);

  const sync = React.useCallback((): void => {
    const el = container.current;
    const at = root.current;
    if (el === null || at === null || at === "") return;
    const frames = arcStatementFrames(el);
    if (frames.length === 0) return;
    const cycles = projectCycles(at);
    const read = (name: string): ArcRowReading => {
      if (entryForArc(name, cycles) !== null) return arcRowReading({ name }, cycles, { status: "pending" });
      // An arc no entry names is asked of the arc log. The answer is pending
      // until the store's notification, which syncs the frame again.
      arcCitationStore.request(at, name);
      return arcRowReading({ name }, cycles, arcCitationStore.getAnswer(at, name));
    };
    for (const frame of frames) syncArcStatementFrame(frame, read);
  }, []);

  const onAnnotated = React.useCallback(
    (el: HTMLElement): void => {
      container.current = el;
      sync();
    },
    [sync],
  );

  // A cycle moving and an arc's fate arriving both move a row.
  React.useLayoutEffect(() => {
    const store = getChangesetAllStore();
    const releaseCycles = store?.subscribe(sync);
    const releaseFates = arcCitationStore.subscribe(sync);
    sync();
    return () => {
      releaseCycles?.();
      releaseFates();
    };
  }, [projectDir, sync]);

  React.useLayoutEffect(
    () => () => {
      container.current = null;
    },
    [],
  );

  return onAnnotated;
}
