/**
 * diff-card.tsx — a standalone Diff card: one {@link TugDiffDocument} in its
 * own resizable card ([P20]).
 *
 * Two guises, one card. Seeded with an **unscoped head descriptor** it is the
 * **Project Diff** card — the repo-wide `git diff HEAD` for a project, opened
 * by `/diff` and Session ▸ Show Project Diff, and it publishes that title via
 * `cardTitleStore`. Seeded with a scoped descriptor (a pathspec, a range, a
 * commit) it is a pop-out from the changeset card or the Changes shade and
 * keeps the registry's plain "Diff" title. Deliberately unconnected to the
 * Changes route: session-scoped review lives in the shade's session diff
 * document, and this card never consults the attribution ledger.
 *
 * The card carries a {@link DiffDescriptor} (head, range, or commit) instead
 * of a file path. It owns a standalone {@link GitDiffStore} (via
 * `createGitDiffStore`), fires the request when its descriptor is set/changed,
 * and renders the shared document with a Refresh control. Loading / error /
 * clean / no-repo states get a centered notice.
 *
 * The descriptor is seeded through `addCard`'s initial-content channel and read
 * back via `useCardStatePreservation`'s restore, so a Maker ▸ Reload restores
 * the same diff. The card registers in `diff-card-open-registry` so `open-diff`
 * reuses an already-open card for the same descriptor rather than duplicating.
 *
 * Laws: [L02] store reads via `useSyncExternalStore`; [L06] appearance via CSS;
 *       [L20] the composed TugDiffDocument keeps its own tokens.
 *
 * @module components/tugways/cards/diff-card
 */

import "./diff-card.css";

import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { registerCard } from "@/card-registry";
import type { CardIdentityFacts } from "@/card-registry";
import { parkedCardBag } from "@/lib/card-identity";
import { cardTitleStore } from "@/lib/card-title-store";
import { CONTENT_WIDTH_COMFY_PX } from "@/lib/layout-imposer";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugDiffDocument } from "@/components/tugways/tug-diff-document";
import { useCardStatePreservation } from "@/components/tugways/use-card-state-preservation";
import {
  createGitDiffStore,
} from "@/lib/changeset-diff-store";
import {
  diffDescriptorKey,
  type DiffDescriptor,
  type GitDiffSnapshot,
} from "@/lib/git-diff-store";
import {
  getOpenDiffCard,
  registerOpenDiffCard,
  unregisterOpenDiffCard,
} from "@/lib/diff-card-open-registry";
import type { DiffCardSeed } from "@/lib/open-diff-in-card";

const IDLE_SNAPSHOT: GitDiffSnapshot = {
  phase: "idle",
  requestId: null,
  payload: null,
  error: null,
};

const NOOP_SUBSCRIBE = (): (() => void) => () => {};

/** Narrow an unknown restore bag into a `DiffDescriptor`. */
function coerceDescriptor(value: unknown): DiffDescriptor | null {
  if (typeof value !== "object" || value === null) return null;
  const descriptor = (value as { descriptor?: unknown }).descriptor;
  if (typeof descriptor !== "object" || descriptor === null) return null;
  const kind = (descriptor as { kind?: unknown }).kind;
  if (kind === "head" || kind === "range" || kind === "commit") {
    return descriptor as DiffDescriptor;
  }
  return null;
}

/** True for the repo-wide guise: `git diff HEAD` with no pathspec. */
function isProjectDiffDescriptor(descriptor: DiffDescriptor): boolean {
  return (
    descriptor.kind === "head" &&
    (descriptor.paths === undefined || descriptor.paths.length === 0)
  );
}

/**
 * The single file a scoped pop-out is about, or null when the descriptor
 * scopes to something other than one file — a range, or several paths. Only a
 * one-file scope has a filename to put on a masthead.
 */
function scopedFilePath(descriptor: DiffDescriptor): string | null {
  if (descriptor.kind === "range") return null;
  const paths = descriptor.paths ?? [];
  return paths.length === 1 ? paths[0]! : null;
}

/** The final path segment — what a document masthead calls the file. */
function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * The scoped file's path as the READER knows it, not as git names it.
 *
 * A descriptor's `paths` are repo-relative, which for a file at the repo root
 * is the bare filename — and a masthead whose first line is `notes.md` and
 * whose second line is also `notes.md` has spent a line saying nothing. The
 * descriptor carries the project dir that resolves it (`tug-changes-list`
 * builds every scoped pop-out with one), so the line answers *where* with a
 * whole path and falls back to the relative one only when there is no root to
 * resolve against.
 */
function scopedDisplayPath(descriptor: DiffDescriptor, scopedPath: string): string {
  const root = descriptor.root;
  if (root === undefined || root.length === 0) return scopedPath;
  return `${root.replace(/\/+$/, "")}/${scopedPath}`;
}

/** The header label for a descriptor's document. */
function descriptorLabel(descriptor: DiffDescriptor): string {
  if (descriptor.kind === "range") {
    return `${descriptor.base}…${descriptor.branch}`;
  }
  if (descriptor.kind === "commit") {
    return `Commit ${descriptor.sha.slice(0, 9)}`;
  }
  return "Uncommitted changes (git diff HEAD)";
}

/**
 * What a Diff card holds, from a descriptor — the one place this card's name
 * is spelled for the resolver, so a mounted card and a parked one cannot
 * disagree about it.
 *
 * The three cases are the masthead's own, and deliberately so: a whole-project
 * diff is "Project Diff", a pop-out scoped to one file is that file, and
 * anything else takes {@link descriptorLabel}. A scoped one carries its path
 * too, which is what lets the row file as the FILE it is showing rather than
 * as a nameless entry in the Files group.
 *
 * Note what this does NOT touch: the string channel of `cardTitleStore`, which
 * the card still publishes only for a project diff, because that override
 * replaces the registry title and a tab wants to keep saying "Diff". Naming a
 * card and titling its tab are two questions, and this answers the first.
 */
function diffIdentityOf(descriptor: DiffDescriptor): CardIdentityFacts {
  if (isProjectDiffDescriptor(descriptor)) return { title: "Project Diff" };
  const scopedPath = scopedFilePath(descriptor);
  if (scopedPath !== null) {
    return {
      title: basename(scopedPath),
      path: scopedDisplayPath(descriptor, scopedPath),
    };
  }
  return { title: descriptorLabel(descriptor) };
}

/** The diff a MOUNTED card is pointed at. */
function liveDiffIdentity(cardId: string): CardIdentityFacts | null {
  const descriptor = getOpenDiffCard(cardId)?.getDescriptor() ?? null;
  return descriptor === null ? null : diffIdentityOf(descriptor);
}

/**
 * The diff a PARKED card's bag remembers ([P08]).
 *
 * Read through the card's own {@link coerceDescriptor}, so what the resolver
 * believes the bag holds is exactly what `onRestore` will put back rather than
 * a second guess at the same shape.
 */
function parkedDiffIdentity(cardId: string): CardIdentityFacts | null {
  const descriptor = coerceDescriptor(parkedCardBag(cardId));
  return descriptor === null ? null : diffIdentityOf(descriptor);
}

export function DiffCardContent({ cardId }: { cardId: string }): React.ReactElement {
  const [descriptor, setDescriptor] = useState<DiffDescriptor | null>(null);
  // One store per card, created at mount; owned here, disposed on unmount.
  const [store] = useState(() => createGitDiffStore());

  useEffect(() => () => store?.dispose(), [store]);

  // Fire a fresh request whenever the descriptor lands or changes.
  useEffect(() => {
    if (descriptor !== null && store !== null) store.requestDiff(descriptor);
  }, [descriptor, store]);

  // Seed the descriptor from the card's initial content; persist it so a
  // Maker ▸ Reload restores the same diff.
  useCardStatePreservation<DiffCardSeed | undefined>({
    onSave: () => (descriptor !== null ? { descriptor } : undefined),
    onRestore: (state) => {
      const restored = coerceDescriptor(state);
      if (restored !== null) setDescriptor(restored);
    },
  });

  // Register for descriptor-keyed reuse ([P20]). The ref keeps the key live
  // without re-registering on every descriptor change ([L07]).
  const descriptorRef = useRef(descriptor);
  descriptorRef.current = descriptor;
  useLayoutEffect(() => {
    registerOpenDiffCard(cardId, {
      getKey: () =>
        descriptorRef.current !== null
          ? diffDescriptorKey(descriptorRef.current)
          : null,
      getDescriptor: () => descriptorRef.current,
      setDescriptor: (next) => setDescriptor(next),
    });
    return () => unregisterOpenDiffCard(cardId);
  }, [cardId]);

  const snapshot = useSyncExternalStore(
    store?.subscribe ?? NOOP_SUBSCRIBE,
    store?.getSnapshot ?? (() => IDLE_SNAPSHOT),
  );
  const refresh = (): void => store?.requestDiff();

  const payload = snapshot.payload;

  // ---- Title + masthead sync (pane chrome) ----
  //
  // Declared below the subscription, because it reads the snapshot: the
  // effect used to sit above it and had only the descriptor to go on.
  //
  // Published FROM MOUNT, with the description filled in when the diff
  // resolves. Gating the payload's existence on `ready` would swap the pane
  // between 36px and 72px while the user is looking at the card and jump the
  // body 36px with it — a tab switch may change the tier, data arriving may
  // not. `no_repo` keeps a null description for the same reason: there is
  // nothing to say, which is not the same as having no masthead.
  //
  // The STRING channel keeps its old rule — it replaces the registry title,
  // so it is published only when the card has a better name than "Diff" —
  // while the masthead publishes for both guises. Both go out in one `set`.
  //
  // A LAYOUT effect, like the other two document cards: "from mount" means
  // before the first paint, and a passive effect would let one 36px frame
  // reach the screen before the tier resolved. Teardown is the separate
  // effect below, keyed on the card alone — a `clear` in this effect's
  // cleanup would run before every re-publish and notify unconditionally,
  // which is what the store's equality guard exists to avoid.
  useLayoutEffect(() => {
    if (descriptor === null) {
      cardTitleStore.clear(cardId);
      return;
    }
    const project = isProjectDiffDescriptor(descriptor);
    const scopedPath = scopedFilePath(descriptor);
    const file =
      scopedPath === null
        ? undefined
        : payload?.files.find((f) => f.path === scopedPath);
    const stats = (added: number, removed: number): string =>
      `+${added} −${removed}`;

    // What a whole-diff masthead says on its second line. The counted summary
    // when there is one; otherwise a STAND-IN, never `null` — the tier is a
    // fixed three lines, so an absent description is a hole between two filled
    // ones rather than a shorter masthead, and a fact standing in for a line
    // nobody has written yet paints a step quieter ([D132]).
    const summary: { text: string; standIn: boolean } =
      payload === null
        ? { text: "Reading the diff…", standIn: true }
        : payload.no_repo
          ? { text: "No repository here", standIn: true }
          : {
              text: `${payload.file_count} ${payload.file_count === 1 ? "file" : "files"} · ${stats(payload.total_added, payload.total_removed)}`,
              standIn: false,
            };

    if (project) {
      cardTitleStore.set(cardId, "Project Diff", {
        kind: "card-masthead",
        icon: "GitCompareArrows",
        title: "Project Diff",
        description: summary.text,
        descriptionStandIn: summary.standIn,
        detail: payload === null ? null : `vs ${payload.base}`,
      });
      return;
    }

    // A scoped pop-out is about one file, so its masthead says which — while
    // the string channel stays the registry's "Diff", the name a tab wants.
    const masthead =
      scopedPath !== null
        ? {
            kind: "card-masthead" as const,
            icon: "GitCompareArrows",
            title: basename(scopedPath),
            description: scopedDisplayPath(descriptor, scopedPath),
            descriptionKind: "path" as const,
            detail:
              file === undefined ? null : stats(file.added, file.removed),
          }
        : {
            kind: "card-masthead" as const,
            icon: "GitCompareArrows",
            title: descriptorLabel(descriptor),
            description: summary.text,
            descriptionStandIn: summary.standIn,
            detail: payload === null ? null : `vs ${payload.base}`,
          };
    cardTitleStore.setMasthead(cardId, masthead);
  }, [cardId, descriptor, payload]);

  // The chrome goes away with the card, and only then ([L27]).
  useLayoutEffect(() => () => cardTitleStore.clear(cardId), [cardId]);

  const hasFiles = (payload?.files.length ?? 0) > 0;

  let body: React.ReactElement;
  if (store === null) {
    body = (
      <p className="diff-card-notice" role="alert">
        Not connected to tugcast.
      </p>
    );
  } else if (snapshot.phase === "error") {
    body = (
      <p className="diff-card-notice" role="alert">
        {snapshot.error ?? "Couldn't load the diff."}
      </p>
    );
  } else if (snapshot.phase === "loading" || payload === null) {
    body = (
      <p className="diff-card-notice" role="status">
        Loading changes…
      </p>
    );
  } else if (payload.no_repo) {
    body = (
      <div className="diff-card-notice" role="status">
        <TugLabel emphasis="proposal" size="lg" align="center">
          Not a git repository
        </TugLabel>
      </div>
    );
  } else if (!hasFiles) {
    body = (
      <div className="diff-card-notice" role="status">
        <TugLabel emphasis="proposal" size="lg" align="center">
          No changes to show
        </TugLabel>
      </div>
    );
  } else {
    body = (
      <TugDiffDocument
        payload={payload}
        cardId={cardId}
        label={descriptor !== null ? descriptorLabel(descriptor) : undefined}
        headerActions={
          <TugPushButton
            size="2xs"
            emphasis="ghost"
            onClick={refresh}
            data-testid="diff-card-refresh"
          >
            Refresh
          </TugPushButton>
        }
      />
    );
  }

  return (
    // `data-tug-scroll-key` is the card's scroll identity: it puts this
    // scroller on the region-preservation seam, so its position survives a
    // cross-mount ([A9]) and a card width change alike.
    <div data-slot="diff-card" className="diff-card" data-tug-scroll-key="diff-card">
      {body}
    </div>
  );
}

/** Register the Diff card. Call from `main.tsx` before any `addCard("diff")`. */
export function registerDiffCard(): void {
  registerCard({
    componentId: "diff",
    contentFactory: (cardId) => <DiffCardContent cardId={cardId} />,
    defaultMeta: { title: "Diff", icon: "GitCompareArrows", closable: true },
    category: { label: "Files", icon: "GitCompareArrows" },
    identity: { live: liveDiffIdentity, parked: parkedDiffIdentity },
    sizePolicy: {
      // Opens at the deck's content width, the one the Session, Text, and File
      // cards open at, so a diff popped out beside one reads at the same
      // stature. The width floor stays below every preset — a diff still shrinks
      // to a narrow column when the reader wants it beside something else.
      min: { width: 480, height: 320 },
      preferred: { width: CONTENT_WIDTH_COMFY_PX, height: 640 },
    },
    takesContentWidth: true,
  });
}
