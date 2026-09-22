/**
 * commit-card.tsx — a standalone Commit card: one commit's whole record in its
 * own resizable card.
 *
 * A commit had no surface of its own. The only place its record was shown
 * whole was an expanded row inside the Session card's History shade, and a
 * commit atom in prose opened a Diff card — which shows what the commit
 * *changed* rather than what the commit *is*. This card is that expansion made
 * standalone: the shared {@link CommitRecordBody} under a masthead whose three
 * lines are the commit's pill, its subject, and author · date · time.
 *
 * **The card always fetches; the seed's hint covers only the first paint.** A
 * card raised from a History row carries the row's header so the masthead
 * paints at once; a card raised from a prose atom knows only a sha and shows
 * the pill with the rest of the tier empty until the reply lands. Either way
 * the fetched record is the one authority for what the card shows, so the two
 * routes cannot drift into showing the same commit differently.
 *
 * The body is the History shade's, mounted without its trailing attribution
 * line: in the shade that line exists because the row's header shows only date
 * and time, and here the masthead's third line carries author, date and time,
 * so the record ends at the file roster.
 *
 * The target is seeded through `addCard`'s initial-content channel and read
 * back via `useCardStatePreservation`'s restore, so a Maker ▸ Reload restores
 * the same commit. The card registers in `commit-card-open-registry` so
 * `open-commit` reuses an already-open card for the same commit rather than
 * duplicating.
 *
 * Laws: [L02] the commit-files store enters React through
 *       `useSyncExternalStore` (inside `CommitRecordBody`); [L06] appearance
 *       via CSS; [L20] the record body and the masthead are both composed.
 *
 * @module components/tugways/cards/commit-card
 */

import "./commit-card.css";

import React, { useLayoutEffect, useRef, useState } from "react";

import { registerCard } from "@/card-registry";
import type { CardIdentityFacts } from "@/card-registry";
import { parkedCardBag } from "@/lib/card-identity";
import {
  cardTitleStore,
  type CommitMastheadFile,
} from "@/lib/card-title-store";
import { CONTENT_WIDTH_COMFY_PX } from "@/lib/layout-imposer";
import { TugLabel } from "@/components/tugways/tug-label";
import {
  CommitRecordBody,
  useCommitFilesSnapshot,
} from "@/components/tugways/commit-presentation";
import { useCardStatePreservation } from "@/components/tugways/use-card-state-preservation";
import {
  getOpenCommitCard,
  registerOpenCommitCard,
  unregisterOpenCommitCard,
  type CommitCardTarget,
} from "@/lib/commit-card-open-registry";
import type { CommitCardSeed } from "@/lib/open-commit-in-card";

/** One stable empty roster, so a record-less publish is equal to the last one. */
const EMPTY_ROSTER: readonly CommitMastheadFile[] = [];

/** Narrow an unknown restore bag into a seed. */
function coerceSeed(value: unknown): CommitCardSeed | null {
  if (typeof value !== "object" || value === null) return null;
  const target = (value as { target?: unknown }).target;
  if (typeof target !== "object" || target === null) return null;
  const { root, sha } = target as { root?: unknown; sha?: unknown };
  if (typeof root !== "string" || typeof sha !== "string") return null;
  if (sha.length === 0) return null;
  const hint = (value as { hint?: unknown }).hint;
  const seed: CommitCardSeed = { target: { root, sha } };
  if (typeof hint === "object" && hint !== null) {
    const { subject, author, dateIso } = hint as Record<string, unknown>;
    seed.hint = {
      ...(typeof subject === "string" ? { subject } : {}),
      ...(typeof author === "string" ? { author } : {}),
      ...(typeof dateIso === "string" ? { dateIso } : {}),
    };
  }
  return seed;
}

/**
 * What a Commit card holds, from a target — the one place this card's name is
 * spelled, so the live and the parked resolver cannot disagree about it.
 *
 * `Commit <sha9>` is the Diff card's own vocabulary for a commit descriptor,
 * and the two are peers. The root rides `secondary` rather than the title
 * because it is what tells two cards on the same sha in different repositories
 * apart, and a filter is where that question gets asked.
 */
function commitIdentityOf(target: CommitCardTarget): CardIdentityFacts {
  return {
    title: `Commit ${target.sha.slice(0, 9)}`,
    secondary: target.root.length > 0 ? target.root : null,
  };
}

/** The commit a MOUNTED card is pointed at. */
function liveCommitIdentity(cardId: string): CardIdentityFacts | null {
  const target = getOpenCommitCard(cardId)?.getTarget() ?? null;
  return target === null ? null : commitIdentityOf(target);
}

/**
 * The commit a PARKED card's bag remembers ([P08]).
 *
 * Read through the card's own {@link coerceSeed}, so what the resolver
 * believes the bag holds is exactly what `onRestore` will put back rather than
 * a second guess at the same shape.
 */
function parkedCommitIdentity(cardId: string): CardIdentityFacts | null {
  const seed = coerceSeed(parkedCardBag(cardId));
  return seed === null ? null : commitIdentityOf(seed.target);
}

/**
 * The record, and the masthead it publishes. Split out from the card so the
 * fetch hook mounts only once a target exists — the card has none for the
 * frame between `addCard` and the restore that seeds it, and a hook cannot be
 * called conditionally.
 */
function CommitRecord({
  cardId,
  target,
  hint,
}: {
  cardId: string;
  target: CommitCardTarget;
  hint: CommitCardSeed["hint"];
}): React.ReactElement {
  // The card's own read of the record — the same store the body mounts, asked
  // for separately because the masthead's three lines come from it too. Two
  // requests for one commit means the server reads it twice, which is the
  // price of a body that fetches for itself ([B02]) beside a masthead only the
  // card can publish. There is no second AUTHORITY: both read the same reply
  // and neither interprets it.
  const snapshot = useCommitFilesSnapshot(target.root, target.sha);
  const record = snapshot.payload;

  // The record when it has landed, the hint until then, and empty runs when
  // there is neither — a card raised from prose. Never a stand-in phrase: the
  // tier's lines are a commit's own facts, and inventing one would put words
  // in a commit's mouth for the length of a round trip.
  const subject = record?.subject ?? hint?.subject ?? "";
  const author = record?.author ?? hint?.author ?? "";
  const dateIso = record?.author_date ?? hint?.dateIso ?? "";
  // Not drawn — the tier's right-click menu writes the whole record, and a
  // masthead handed only its three lines copied a commit without its message
  // or its roster, which is less than the History row copies for the same one.
  const body = record?.body ?? "";
  const authorEmail = record?.author_email ?? "";
  const files = record?.files ?? EMPTY_ROSTER;

  // Published FROM MOUNT and on every change, for the Diff card's reason: the
  // tier's height is a pane fact, and gating the publish on the record's
  // arrival would swap the pane between 36px and 72px while the reader is
  // looking at the card. A LAYOUT effect so "from mount" means before the
  // first paint. Teardown is the separate effect in the card below, keyed on
  // the card alone — a `clear` in this cleanup would run before every
  // re-publish and notify unconditionally, which is what the store's equality
  // guard exists to avoid.
  useLayoutEffect(() => {
    cardTitleStore.setMasthead(cardId, {
      kind: "commit-masthead",
      root: target.root,
      sha: record?.sha ?? target.sha,
      subject,
      author,
      dateIso,
      body,
      authorEmail,
      files,
    });
  }, [
    cardId,
    target.root,
    target.sha,
    record?.sha,
    subject,
    author,
    dateIso,
    body,
    authorEmail,
    files,
  ]);

  const missing =
    snapshot.phase === "ready" &&
    record !== null &&
    !record.no_repo &&
    record.subject === "" &&
    record.files.length === 0;

  if (snapshot.phase === "error") {
    return (
      <p className="commit-card-notice" role="alert">
        {snapshot.error ?? "Couldn't read the commit."}
      </p>
    );
  }
  if (record === null) {
    return (
      <p className="commit-card-notice" role="status">
        Reading the commit…
      </p>
    );
  }
  if (record.no_repo) {
    return (
      <div className="commit-card-notice" role="status">
        <TugLabel emphasis="proposal" size="lg" align="center">
          Not a git repository
        </TugLabel>
      </div>
    );
  }
  if (missing) {
    // A sha that resolves to nothing — rebased away, garbage-collected, or
    // never a commit at all. The masthead still shows the pill, so the card
    // says WHICH commit it could not find.
    return (
      <div className="commit-card-notice" role="status">
        <TugLabel emphasis="proposal" size="lg" align="center">
          No commit with this hash
        </TugLabel>
      </div>
    );
  }
  return (
    <CommitRecordBody
      root={target.root}
      sha={target.sha}
      showAttribution={false}
      className="commit-card-body"
      messageSlot="commit-card-message"
    />
  );
}

export function CommitCardContent({
  cardId,
}: {
  cardId: string;
}): React.ReactElement {
  const [seed, setSeed] = useState<CommitCardSeed | null>(null);

  // Seed the target from the card's initial content; persist it so a
  // Maker ▸ Reload restores the same commit.
  useCardStatePreservation<CommitCardSeed | undefined>({
    onSave: () => seed ?? undefined,
    onRestore: (state) => {
      const restored = coerceSeed(state);
      if (restored !== null) setSeed(restored);
    },
  });

  // Register for sha-keyed reuse. The ref keeps the target live without
  // re-registering on every change ([L07]).
  const seedRef = useRef(seed);
  seedRef.current = seed;
  useLayoutEffect(() => {
    registerOpenCommitCard(cardId, {
      getTarget: () => seedRef.current?.target ?? null,
      // A re-point drops the old hint with the old commit: a hint is the
      // header of the commit it arrived with, and carrying it across would
      // paint the previous commit's subject over the new one's pill.
      setTarget: (next) => setSeed({ target: next }),
    });
    return () => unregisterOpenCommitCard(cardId);
  }, [cardId]);

  // The chrome goes away with the card, and only then ([L27]).
  useLayoutEffect(() => () => cardTitleStore.clear(cardId), [cardId]);

  return (
    // `data-tug-scroll-key` is the card's scroll identity: it puts this
    // scroller on the region-preservation seam, so its position survives a
    // cross-mount ([A9]) and a card width change alike.
    <div
      data-slot="commit-card"
      className="commit-card tugx-commit"
      data-tug-scroll-key="commit-card"
    >
      {seed === null ? (
        <p className="commit-card-notice" role="status">
          Reading the commit…
        </p>
      ) : (
        <CommitRecord cardId={cardId} target={seed.target} hint={seed.hint} />
      )}
    </div>
  );
}

/** Register the Commit card. Call from `main.tsx` before any `addCard("commit")`. */
export function registerCommitCard(): void {
  registerCard({
    componentId: "commit",
    contentFactory: (cardId) => <CommitCardContent cardId={cardId} />,
    defaultMeta: { title: "Commit", icon: "GitCommitHorizontal", closable: true },
    category: { label: "Files", icon: "GitCommitHorizontal" },
    identity: { live: liveCommitIdentity, parked: parkedCommitIdentity },
    sizePolicy: {
      // The Diff card's stature, for the reason a commit and its diff are
      // peers: a commit popped out beside a session reads at the deck's
      // content width, the one the Session, Text, File and Diff cards all
      // open at.
      min: { width: 480, height: 320 },
      preferred: { width: CONTENT_WIDTH_COMFY_PX, height: 640 },
    },
    takesContentWidth: true,
  });
}
