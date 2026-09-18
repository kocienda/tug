/**
 * card-title-store.test.ts — the masthead sidecar's equality guard.
 *
 * The guard is what makes a card's publish effect safe to re-run: every
 * document card republishes its whole payload on any snapshot change, and the
 * store is expected to stay silent unless something a reader could see moved.
 * A field left out of the comparison is therefore invisible in the worst way —
 * the chrome simply keeps the stale line, with nothing to log.
 */

import { describe, test, expect, afterEach } from "bun:test";

import {
  cardTitleStore,
  type CommitMastheadPayload,
  type DocumentMastheadPayload,
} from "@/lib/card-title-store";

const BASE: DocumentMastheadPayload = {
  kind: "card-masthead",
  icon: "FileText",
  title: "notes.md",
  description: "/tmp/notes.md",
  descriptionKind: "path",
  detail: "Saved",
};

/** Publish `payload` twice over, and count the notifications it drew. */
function notifiesFor(payloads: readonly DocumentMastheadPayload[]): number {
  let notifies = 0;
  const unsubscribe = cardTitleStore.subscribe(() => {
    notifies += 1;
  });
  for (const payload of payloads) cardTitleStore.set("card", payload.title, payload);
  unsubscribe();
  return notifies;
}

afterEach(() => cardTitleStore.clear("card"));

describe("the masthead equality guard", () => {
  test("an unchanged payload notifies once, not once per publish", () => {
    expect(notifiesFor([BASE, { ...BASE }, { ...BASE }])).toBe(1);
  });

  test("every displayed field is compared", () => {
    // One case per line the tier draws, plus the two attributes that decide
    // how a line is PAINTED — a stand-in rung is a different reading from a
    // real one, and a path clips at the other end from prose.
    const changed: readonly DocumentMastheadPayload[] = [
      { ...BASE, title: "other.md" },
      { ...BASE, description: "/tmp/other.md" },
      { ...BASE, detail: "Edited" },
      { ...BASE, icon: "GitCompareArrows" },
      { ...BASE, descriptionKind: "text" },
      { ...BASE, descriptionStandIn: true },
    ];
    for (const next of changed) {
      expect(notifiesFor([BASE, next]), JSON.stringify(next)).toBe(2);
    }
  });
});

const COMMIT: CommitMastheadPayload = {
  kind: "commit-masthead",
  root: "/work/repo",
  sha: "0123456789abcdef0123456789abcdef01234567",
  subject: "Widen the commit-files reply",
  author: "Ken Kocienda",
  dateIso: "2026-09-18T09:31:04-07:00",
  body: "The card fills its masthead from the one round trip.",
  authorEmail: "kocienda@pobox.com",
  files: [
    { path: "tugrust/crates/tugcast/src/feeds/git.rs", status: "modified", added: 40, removed: 8 },
  ],
};

/** The same two publishes, against the masthead-only channel a card uses. */
function commitNotifiesFor(payloads: readonly CommitMastheadPayload[]): number {
  let notifies = 0;
  const unsubscribe = cardTitleStore.subscribe(() => {
    notifies += 1;
  });
  for (const payload of payloads) cardTitleStore.setMasthead("commit", payload);
  unsubscribe();
  return notifies;
}

afterEach(() => cardTitleStore.clear("commit"));

describe("the commit masthead's equality guard", () => {
  test("an unchanged payload notifies once, not once per publish", () => {
    // A Commit card publishes on EVERY snapshot change, and a store delivers
    // more snapshots than it does distinct records.
    expect(commitNotifiesFor([COMMIT, { ...COMMIT }, { ...COMMIT }])).toBe(1);
  });

  test("every displayed field is compared", () => {
    const changed: readonly CommitMastheadPayload[] = [
      { ...COMMIT, sha: "fedcba9876543210fedcba9876543210fedcba98" },
      { ...COMMIT, subject: "Carve the expansion into CommitRecordBody" },
      { ...COMMIT, author: "Grace Hopper" },
      { ...COMMIT, dateIso: "2026-09-17T09:31:04-07:00" },
      // Not a drawn line, but the descriptor the tier's Open Diff is scoped
      // by — the same sha in two checkouts is two different diffs.
      { ...COMMIT, root: "/work/other" },
      // Nor are these drawn. They are what the tier's menu COPIES, and a
      // record left out of the comparison is a menu still writing the last
      // commit's message.
      { ...COMMIT, body: "A different message." },
      { ...COMMIT, authorEmail: "ken@example.com" },
      { ...COMMIT, files: [] },
      {
        ...COMMIT,
        files: [
          { path: "tugrust/crates/tugcast/src/feeds/git.rs", status: "modified", added: 41, removed: 8 },
        ],
      },
    ];
    for (const next of changed) {
      expect(commitNotifiesFor([COMMIT, next]), JSON.stringify(next)).toBe(2);
    }
  });

  test("a kind change is never equal, whatever the fields say", () => {
    let notifies = 0;
    const unsubscribe = cardTitleStore.subscribe(() => {
      notifies += 1;
    });
    cardTitleStore.setMasthead("commit", COMMIT);
    cardTitleStore.setMasthead("commit", BASE);
    unsubscribe();
    expect(notifies).toBe(2);
  });
});
