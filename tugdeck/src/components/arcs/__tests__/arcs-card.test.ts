/**
 * The Arcs card's projection, over the shared golden snapshot.
 *
 * The fact worth pinning hardest is the **membership law**: every arc in
 * every state is a row. The card used to hold only unbound arcs and to
 * vanish at zero; now it is always on, and bound-vs-unbound is the eyebrow's
 * register (worker atom vs verbs), never a membership test.
 */

import { describe, expect, test } from "bun:test";

import golden from "@/__tests__/fixtures/workspaces-changeset-snapshot.golden.json";
import type {
  ArcChangesetEntry,
  ProjectChangeset,
  WorkspacesChangesetSnapshot,
} from "@/lib/changeset-types";
import {
  ARC_STAGE_RANK,
  compareArcRows,
  arcRowsFromSnapshot,
  compareDocumentArcRows,
  documentArcRowsFromSnapshot,
  resolveBindTarget,
  resolveWorkerCard,
  type ArcRow,
  type DocumentArcRow,
} from "../arcs-card";

const DATA = golden as WorkspacesChangesetSnapshot;

/** The golden project, with `changesets` replaced wholesale. */
function projectWith(entries: ProjectChangeset["changesets"]): ProjectChangeset {
  return { ...DATA.projects[0]!, changesets: entries };
}

const GOLDEN_ARC = DATA.projects
  .flatMap((project) => project.changesets)
  .find((entry): entry is ArcChangesetEntry => entry.kind === "arc")!;

/** The golden arc with nobody on it. */
const UNBOUND: ArcChangesetEntry = { ...GOLDEN_ARC, bound_sessions: [] };

describe("arcRowsFromSnapshot — the membership law", () => {
  test("a worked arc is a row — bound-ness is a register, not membership", () => {
    // The golden arc carries a bound session, and it is here anyway: the
    // section holds every arc in every state.
    expect(GOLDEN_ARC.bound_sessions?.length).toBeGreaterThan(0);
    const rows = arcRowsFromSnapshot(DATA);
    expect(rows.map((r) => r.ownerId)).toContain(GOLDEN_ARC.owner_id);
  });

  test("bound and unbound sit in one list, in one order", () => {
    const worked: ArcChangesetEntry = { ...GOLDEN_ARC, display_name: "worked" };
    const napping: ArcChangesetEntry = {
      ...UNBOUND,
      owner_id: "tugarc/napping#2",
      display_name: "napping",
    };
    const rows = arcRowsFromSnapshot({
      projects: [projectWith([worked, napping])],
    });
    expect(rows.map((r) => r.entry.display_name).sort()).toEqual([
      "napping",
      "worked",
    ]);
  });

  test("the row carries the whole wire entry, for the eyebrow and the meta line", () => {
    const rows = arcRowsFromSnapshot({ projects: [projectWith([UNBOUND])] });
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.ownerId).toBe(GOLDEN_ARC.owner_id);
    expect(row.entry.display_name).toBe("fix-join");
    expect(row.entry.stage).toBe("draft-ready");
  });

  test("session entries never become rows", () => {
    const sessions = DATA.projects
      .flatMap((project) => project.changesets)
      .filter((entry) => entry.kind === "session");
    expect(sessions.length).toBeGreaterThan(0);
    expect(
      arcRowsFromSnapshot({
        projects: [projectWith([...sessions, UNBOUND])],
      }).length,
    ).toBe(1);
  });

  test("the row carries its project's dir and label, always", () => {
    // The dir is what a bind names; the label is Bind's refusal sentence.
    const rows = arcRowsFromSnapshot({ projects: [projectWith([UNBOUND])] });
    expect(rows[0]!.projectLabel).toBe(DATA.projects[0]!.display_name);
    expect(rows[0]!.projectDir).toBe(DATA.projects[0]!.project_dir);
  });

  test("the order crosses projects: grouping by project is not a key", () => {
    const second: ProjectChangeset = {
      ...projectWith([
        {
          ...UNBOUND,
          owner_id: "tugarc/landing#2",
          display_name: "landing-one",
          stage: "joining",
        },
      ]),
      display_name: "other-project",
      project_dir: "/tmp/other-project",
    };
    const rows = arcRowsFromSnapshot({
      projects: [
        projectWith([{ ...UNBOUND, display_name: "napping", stage: "created" }]),
        second,
      ],
    });
    expect(rows.map((r) => r.entry.display_name)).toEqual([
      "landing-one",
      "napping",
    ]);
    expect(rows.map((r) => r.projectLabel)).toEqual([
      "other-project",
      DATA.projects[0]!.display_name,
    ]);
  });

  test("one arc under two projects is one row — first in snapshot order wins", () => {
    // Two projects opening one repository both carry the repo's arcs; the
    // owner key is the identity that collapses them.
    const twin: ProjectChangeset = {
      ...projectWith([{ ...UNBOUND }]),
      display_name: "twin-spelling",
      project_dir: "/tmp/twin-spelling",
    };
    const rows = arcRowsFromSnapshot({
      projects: [projectWith([UNBOUND]), twin],
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.projectDir).toBe(DATA.projects[0]!.project_dir);
  });

  test("a shared name with distinct owner keys is two rows", () => {
    // Two unrelated repos may both call an arc `fix-join`; the owner key is
    // what tells them apart, and the name never dedupes.
    const other: ProjectChangeset = {
      ...projectWith([{ ...UNBOUND, owner_id: "tugarc/fix-join#other" }]),
      display_name: "other-project",
      project_dir: "/tmp/other-project",
    };
    const rows = arcRowsFromSnapshot({
      projects: [projectWith([UNBOUND]), other],
    });
    expect(rows.length).toBe(2);
  });

  test("the survivors' order is still compareArcRows' order", () => {
    const twin: ProjectChangeset = {
      ...projectWith([
        { ...UNBOUND },
        {
          ...UNBOUND,
          owner_id: "tugarc/landing#2",
          display_name: "landing-one",
          stage: "joining",
        },
      ]),
      display_name: "twin-spelling",
      project_dir: "/tmp/twin-spelling",
    };
    const rows = arcRowsFromSnapshot({
      projects: [projectWith([UNBOUND]), twin],
    });
    // `joining` outranks `draft-ready`, duplicate collapsed, order intact.
    expect(rows.map((r) => r.entry.display_name)).toEqual([
      "landing-one",
      "fix-join",
    ]);
  });
});

describe("compareArcRows", () => {
  /** A row with only the keys the comparator reads. */
  function row(
    name: string,
    stage: string | null,
    lastActivity: string | null = null,
  ): ArcRow {
    return {
      ownerId: `tugarc/${name}#1`,
      entry: {
        ...UNBOUND,
        owner_id: `tugarc/${name}#1`,
        display_name: name,
        stage: stage ?? undefined,
        last_activity: lastActivity ?? undefined,
      },
      projectDir: "/tmp/p",
      workspaceKey: "/tmp/p",
      projectLabel: "p",
    };
  }

  const order = (rows: ArcRow[]): string[] =>
    [...rows].sort(compareArcRows).map((r) => r.entry.display_name);

  test("nearest-to-done first", () => {
    expect(
      order([
        row("c", "created"),
        row("l", "joining"),
        row("w", "working"),
        row("b", "built"),
        row("d", "draft-ready"),
        row("a", "audited"),
        row("i", "implementing"),
      ]),
    ).toEqual(["l", "d", "a", "b", "i", "w", "c"]);
  });

  test("stage dominates age", () => {
    expect(
      order([
        row("stale-but-close", "draft-ready", "2020-01-01T00:00:00Z"),
        row("fresh-but-new", "created", "2026-08-17T00:00:00Z"),
      ]),
    ).toEqual(["stale-but-close", "fresh-but-new"]);
  });

  test("within a stage, freshest first", () => {
    expect(
      order([
        row("older", "built", "2026-08-10T09:00:00Z"),
        row("newer", "built", "2026-08-16T09:00:00Z"),
      ]),
    ).toEqual(["newer", "older"]);
  });

  // The comparison is lexical on ISO-8601 UTC, so a date whose ordering differs
  // from its string ordering would break it. These two cross a month boundary,
  // where zero-padding is what keeps the two orders the same.
  test("compares raw ISO strings, never parsed dates", () => {
    expect(
      order([
        row("sept", "built", "2026-09-02T00:00:00Z"),
        row("aug", "built", "2026-08-30T00:00:00Z"),
      ]),
    ).toEqual(["sept", "aug"]);
  });

  test("an absent age sorts last within its stage", () => {
    expect(
      order([
        row("undated", "built", null),
        row("ancient", "built", "2020-01-01T00:00:00Z"),
      ]),
    ).toEqual(["ancient", "undated"]);
  });

  test("name breaks a tie, not snapshot order", () => {
    expect(order([row("zebra", "built"), row("alpha", "built")])).toEqual([
      "alpha",
      "zebra",
    ]);
  });

  test("an unrecognized or absent stage sorts last rather than throwing", () => {
    expect(
      order([
        row("mystery", "from-the-future"),
        row("none", null),
        row("known", "created"),
      ]),
    ).toEqual(["known", "mystery", "none"]);
    expect(ARC_STAGE_RANK["from-the-future"]).toBeUndefined();
  });
});

describe("resolveBindTarget", () => {
  const HOME = { projectDir: "/tmp/tugtool", projectLabel: "tugtool" };

  test("the followed card's session, when its project owns the arc", () => {
    expect(
      resolveBindTarget({
        ...HOME,
        followedCardId: "A",
        binding: { tugSessionId: "sess-1", projectDir: "/tmp/tugtool" },
      }),
    ).toEqual({ tugSessionId: "sess-1", reason: null });
  });

  // Each refusal below names what is missing. A control that declines without
  // saying why is exactly the failure this section used to have — its old
  // activation was a silent no-op on every unbound row ([L31]).
  test("no followed card names the gesture that would fix it", () => {
    const target = resolveBindTarget({
      ...HOME,
      followedCardId: null,
      binding: undefined,
    });
    expect(target.tugSessionId).toBeNull();
    expect(target.reason).toBe("Focus a session card to bind this arc");
  });

  test("a followed card with no session says so", () => {
    const target = resolveBindTarget({
      ...HOME,
      followedCardId: "A",
      binding: undefined,
    });
    expect(target.tugSessionId).toBeNull();
    expect(target.reason).toBe("The focused card has no session");
  });

  test("a project mismatch names the project, so a real refusal is self-reporting", () => {
    const target = resolveBindTarget({
      ...HOME,
      followedCardId: "A",
      binding: { tugSessionId: "sess-1", projectDir: "/tmp/elsewhere" },
    });
    expect(target.tugSessionId).toBeNull();
    expect(target.reason).toBe("This arc belongs to tugtool");
  });

  test("exactly one of target and reason is ever set", () => {
    const cases = [
      { followedCardId: null, binding: undefined },
      { followedCardId: "A", binding: undefined },
      {
        followedCardId: "A",
        binding: { tugSessionId: "s", projectDir: "/tmp/elsewhere" },
      },
      {
        followedCardId: "A",
        binding: { tugSessionId: "s", projectDir: "/tmp/tugtool" },
      },
    ];
    for (const input of cases) {
      const target = resolveBindTarget({ ...HOME, ...input });
      expect((target.tugSessionId === null) !== (target.reason === null)).toBe(true);
    }
  });
});

/**
 * Where activating a row goes — and, just as load-bearing, when it goes
 * nowhere. Null is the ordinary answer in a list of every arc in every open
 * project, and it is what makes the row inert *and* what stops it presenting
 * as clickable, since both read this one value.
 */
describe("resolveWorkerCard", () => {
  const bindings = (
    entries: Array<[string, string]>,
  ): ReadonlyMap<string, { tugSessionId: string }> =>
    new Map(entries.map(([cardId, tugSessionId]) => [cardId, { tugSessionId }]));

  test("an arc nobody holds has no room to open", () => {
    expect(resolveWorkerCard([], bindings([["A", "sess-1"]]))).toBeNull();
  });

  test("a held arc whose worker has no card open here is inert too", () => {
    // The session is live on the server; this instance simply has no card on
    // it. The row is still worth showing — it is just not a door.
    expect(resolveWorkerCard(["sess-9"], bindings([["A", "sess-1"]]))).toBeNull();
  });

  test("the card bound to the holding session is the destination", () => {
    expect(
      resolveWorkerCard(["sess-2"], bindings([["A", "sess-1"], ["B", "sess-2"]])),
    ).toBe("B");
  });

  test("with several holders, the first match is the answer and stays the answer", () => {
    // Any of them is a correct room; what matters is that two renders of the
    // same snapshot agree, so activation does not front a different card each
    // time.
    const map = bindings([["A", "sess-1"], ["B", "sess-2"]]);
    expect(resolveWorkerCard(["sess-1", "sess-2"], map)).toBe("A");
    expect(resolveWorkerCard(["sess-2", "sess-1"], map)).toBe("A");
  });

  test("no bindings at all is null, not a throw", () => {
    expect(resolveWorkerCard(["sess-1"], bindings([]))).toBeNull();
  });
});

describe("documentArcRowsFromSnapshot — the planning phase in flight", () => {
  test("every project's document arcs are rows, keyed uniquely", () => {
    const rows = documentArcRowsFromSnapshot(DATA);
    expect(rows.map((r) => r.entry.display_name)).toEqual([
      "arc-cockpit",
      "arc-hardening",
    ]);
    // The key namespaces the name under its project: two projects may both
    // carry an arc called `plan`, and they are different rows.
    expect(rows[0]!.key).toBe(`${DATA.projects[0]!.project_dir}:arc-cockpit`);
  });

  test("a project with no document-only arc contributes nothing", () => {
    // The golden's second project carries no `document_arcs` key at all —
    // the shape an older sender or a project with no arcs produces.
    expect(DATA.projects[1]!.document_arcs).toBeUndefined();
    const rows = documentArcRowsFromSnapshot({ projects: [DATA.projects[1]!] });
    expect(rows).toEqual([]);
  });

  test("one plan under two projects is one row — deduped on owner_id, never key", () => {
    // The row key namespaces the name under its project, so the very
    // duplicates being removed carry DIFFERENT keys; only `owner_id` can
    // collapse them. First in snapshot order wins.
    const twin: ProjectChangeset = {
      ...DATA.projects[0]!,
      display_name: "twin-spelling",
      project_dir: "/tmp/twin-spelling",
    };
    const rows = documentArcRowsFromSnapshot({
      projects: [DATA.projects[0]!, twin],
    });
    const names = rows.map((r) => r.entry.display_name);
    expect(names).toEqual([...new Set(names)]);
    expect(rows.map((r) => r.key)).toEqual(
      documentArcRowsFromSnapshot({ projects: [DATA.projects[0]!] }).map(
        (r) => r.key,
      ),
    );
  });

  test("a shared plan name with distinct owner ids is two rows", () => {
    const first = DATA.projects[0]!;
    const plan = (first.document_arcs ?? [])[0]!;
    const other: ProjectChangeset = {
      ...first,
      display_name: "other-project",
      project_dir: "/tmp/other-project",
      document_arcs: [{ ...plan, owner_id: `${plan.owner_id}#other` }],
    };
    const rows = documentArcRowsFromSnapshot({
      projects: [
        { ...first, document_arcs: [plan] },
        other,
      ],
    });
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.entry.display_name)).toEqual([
      plan.display_name,
      plan.display_name,
    ]);
  });
});

describe("compareDocumentArcRows — nearest to starting work first", () => {
  const row = (
    review: string,
    name: string,
    progress?: { done: number; begun: number },
  ): DocumentArcRow => ({
    key: `/p:${name}`,
    entry: {
      owner_id: `tugarc/${name}`,
      display_name: name,
      documents: { plan: `/p/.tug/arcs/${name}/plan.md` },
      review,
      step_total: 3,
      steps_done: progress?.done ?? 0,
      steps_begun: progress?.begun ?? 0,
    },
  });

  // Work in flight is nearer done than work not started — the same
  // nearest-to-done principle the arc rows encode. A begun plan whose review
  // went stale still outranks a freshly reviewed one nobody has touched.
  test("a begun arc outranks every unstarted one", () => {
    const rows = [
      row("reviewed", "a"),
      row("stale", "b", { done: 1, begun: 2 }),
      row("never-reviewed", "c"),
    ].sort(compareDocumentArcRows);
    expect(rows.map((r) => r.entry.display_name)).toEqual(["b", "a", "c"]);
  });

  test("among begun arcs, review rank then name still decide", () => {
    const rows = [
      row("stale", "z", { done: 1, begun: 1 }),
      row("reviewed", "y", { done: 2, begun: 3 }),
      row("stale", "a", { done: 0, begun: 1 }),
    ].sort(compareDocumentArcRows);
    expect(rows.map((r) => r.entry.display_name)).toEqual(["y", "a", "z"]);
  });

  test("reviewed outranks stale outranks never-reviewed", () => {
    const rows = [
      row("never-reviewed", "c"),
      row("reviewed", "a"),
      row("stale", "b"),
    ].sort(compareDocumentArcRows);
    expect(rows.map((r) => r.entry.review)).toEqual([
      "reviewed",
      "stale",
      "never-reviewed",
    ]);
  });

  test("within a review state, by name", () => {
    const rows = [row("reviewed", "zulu"), row("reviewed", "alpha")].sort(
      compareDocumentArcRows,
    );
    expect(rows.map((r) => r.entry.display_name)).toEqual(["alpha", "zulu"]);
  });

  test("an unrecognized review spelling sorts last and never throws", () => {
    const rows = [row("who-knows", "a"), row("never-reviewed", "b")].sort(
      compareDocumentArcRows,
    );
    expect(rows.map((r) => r.entry.review)).toEqual([
      "never-reviewed",
      "who-knows",
    ]);
  });
});
