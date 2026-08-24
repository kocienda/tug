/**
 * The Lens Dashes section's projection and its collapsed summary, over the
 * shared golden snapshot.
 *
 * The fact worth pinning hardest is the **membership law**: every dash in
 * every state is a row. The section used to hold only unbound dashes and to
 * vanish at zero; now it is always on, and bound-vs-unbound is the eyebrow's
 * register (worker atom vs verbs), never a membership test.
 */

import { describe, expect, test } from "bun:test";

import golden from "@/__tests__/fixtures/workspaces-changeset-snapshot.golden.json";
import type {
  DashChangesetEntry,
  ProjectChangeset,
  WorkspacesChangesetSnapshot,
} from "@/lib/changeset-types";
import {
  DASH_STAGE_RANK,
  compareDashRows,
  dashRowsFromSnapshot,
  dashesCollapsedSummary,
  comparePlanRows,
  planRowsFromSnapshot,
  resolveBindTarget,
  resolveWorkerCard,
  type DashRow,
  type PlanRow,
} from "../dashes-section";

const DATA = golden as WorkspacesChangesetSnapshot;

/** The golden project, with `changesets` replaced wholesale. */
function projectWith(entries: ProjectChangeset["changesets"]): ProjectChangeset {
  return { ...DATA.projects[0]!, changesets: entries };
}

const GOLDEN_DASH = DATA.projects
  .flatMap((project) => project.changesets)
  .find((entry): entry is DashChangesetEntry => entry.kind === "dash")!;

/** The golden dash with nobody on it. */
const UNBOUND: DashChangesetEntry = { ...GOLDEN_DASH, bound_sessions: [] };

describe("dashRowsFromSnapshot — the membership law", () => {
  test("a worked dash is a row — bound-ness is a register, not membership", () => {
    // The golden dash carries a bound session, and it is here anyway: the
    // section holds every dash in every state.
    expect(GOLDEN_DASH.bound_sessions?.length).toBeGreaterThan(0);
    const rows = dashRowsFromSnapshot(DATA);
    expect(rows.map((r) => r.ownerId)).toContain(GOLDEN_DASH.owner_id);
  });

  test("bound and unbound sit in one list, in one order", () => {
    const worked: DashChangesetEntry = { ...GOLDEN_DASH, display_name: "worked" };
    const napping: DashChangesetEntry = {
      ...UNBOUND,
      owner_id: "tugdash/napping#2",
      display_name: "napping",
    };
    const rows = dashRowsFromSnapshot({
      projects: [projectWith([worked, napping])],
    });
    expect(rows.map((r) => r.entry.display_name).sort()).toEqual([
      "napping",
      "worked",
    ]);
  });

  test("the row carries the whole wire entry, for the eyebrow and the meta line", () => {
    const rows = dashRowsFromSnapshot({ projects: [projectWith([UNBOUND])] });
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.ownerId).toBe(GOLDEN_DASH.owner_id);
    expect(row.entry.display_name).toBe("fix-join");
    expect(row.entry.stage).toBe("draft-ready");
  });

  test("session entries never become rows", () => {
    const sessions = DATA.projects
      .flatMap((project) => project.changesets)
      .filter((entry) => entry.kind === "session");
    expect(sessions.length).toBeGreaterThan(0);
    expect(
      dashRowsFromSnapshot({
        projects: [projectWith([...sessions, UNBOUND])],
      }).length,
    ).toBe(1);
  });

  test("the row carries its project's dir and label, always", () => {
    // The dir is what a bind names; the label is Bind's refusal sentence.
    const rows = dashRowsFromSnapshot({ projects: [projectWith([UNBOUND])] });
    expect(rows[0]!.projectLabel).toBe(DATA.projects[0]!.display_name);
    expect(rows[0]!.projectDir).toBe(DATA.projects[0]!.project_dir);
  });

  test("the order crosses projects: grouping by project is not a key", () => {
    const second: ProjectChangeset = {
      ...projectWith([
        {
          ...UNBOUND,
          owner_id: "tugdash/landing#2",
          display_name: "landing-one",
          stage: "joining",
        },
      ]),
      display_name: "other-project",
      project_dir: "/tmp/other-project",
    };
    const rows = dashRowsFromSnapshot({
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
});

describe("compareDashRows", () => {
  /** A row with only the keys the comparator reads. */
  function row(
    name: string,
    stage: string | null,
    lastActivity: string | null = null,
  ): DashRow {
    return {
      ownerId: `tugdash/${name}#1`,
      entry: {
        ...UNBOUND,
        owner_id: `tugdash/${name}#1`,
        display_name: name,
        stage: stage ?? undefined,
        last_activity: lastActivity ?? undefined,
      },
      projectDir: "/tmp/p",
      workspaceKey: "/tmp/p",
      projectLabel: "p",
    };
  }

  const order = (rows: DashRow[]): string[] =>
    [...rows].sort(compareDashRows).map((r) => r.entry.display_name);

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
    expect(DASH_STAGE_RANK["from-the-future"]).toBeUndefined();
  });
});

describe("resolveBindTarget", () => {
  const HOME = { projectDir: "/tmp/tugtool", projectLabel: "tugtool" };

  test("the followed card's session, when its project owns the dash", () => {
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
    expect(target.reason).toBe("Focus a session card to bind this dash");
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
    expect(target.reason).toBe("This dash belongs to tugtool");
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
 * nowhere. Null is the ordinary answer in a list of every dash in every open
 * project, and it is what makes the row inert *and* what stops it presenting
 * as clickable, since both read this one value.
 */
describe("resolveWorkerCard", () => {
  const bindings = (
    entries: Array<[string, string]>,
  ): ReadonlyMap<string, { tugSessionId: string }> =>
    new Map(entries.map(([cardId, tugSessionId]) => [cardId, { tugSessionId }]));

  test("a dash nobody holds has no room to open", () => {
    expect(resolveWorkerCard([], bindings([["A", "sess-1"]]))).toBeNull();
  });

  test("a held dash whose worker has no card open here is inert too", () => {
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

describe("dashesCollapsedSummary", () => {
  test("counts every dash, whatever its state", () => {
    const rows = dashRowsFromSnapshot({
      projects: [
        projectWith([
          GOLDEN_DASH,
          { ...UNBOUND, owner_id: "tugdash/idle#2", display_name: "idle" },
        ]),
      ],
    });
    expect(dashesCollapsedSummary(rows)).toBe("2 dashes");
  });

  test("one dash is singular", () => {
    expect(
      dashesCollapsedSummary(
        dashRowsFromSnapshot({ projects: [projectWith([UNBOUND])] }),
      ),
    ).toBe("1 dash");
  });

  // Reachable now: the section is always on, and the band's collapsed line
  // must say the honest zero.
  test("an empty list still reads as a sentence", () => {
    expect(dashesCollapsedSummary([])).toBe("No dashes");
  });

  test("waiting plans count too, so a folded band still shows the front half", () => {
    const plans = planRowsFromSnapshot(DATA);
    expect(plans).toHaveLength(2);
    expect(dashesCollapsedSummary([], plans)).toBe("2 plans");
    expect(dashesCollapsedSummary([], [plans[0]!])).toBe("1 plan");
  });

  test("both kinds read as one line, and a zero bucket drops", () => {
    const rows = dashRowsFromSnapshot({ projects: [projectWith([UNBOUND])] });
    const plans = planRowsFromSnapshot(DATA);
    expect(dashesCollapsedSummary(rows, plans)).toBe("1 dash · 2 plans");
    // No plans at all is the old sentence, unchanged.
    expect(dashesCollapsedSummary(rows, [])).toBe("1 dash");
  });
});

describe("planRowsFromSnapshot — the waiting paperwork", () => {
  test("every project's plans are rows, keyed uniquely across projects", () => {
    const rows = planRowsFromSnapshot(DATA);
    expect(rows.map((r) => r.entry.path)).toEqual([
      "dash/dash-cockpit.md",
      "dash/dash-hardening.md",
    ]);
    // The key namespaces the path under its project: two projects may both
    // carry `dash/plan.md`, and they are different rows.
    expect(rows[0]!.key).toBe(`${DATA.projects[0]!.project_dir}:dash/dash-cockpit.md`);
    expect(rows[0]!.projectDir).toBe(DATA.projects[0]!.project_dir);
    expect(rows[0]!.projectLabel).toBe(DATA.projects[0]!.display_name);
  });

  test("a project that declares no docs directory contributes nothing", () => {
    // The golden's second project carries no `plans` key at all — the shape an
    // older sender or an undeclared docs home produces.
    expect(DATA.projects[1]!.plans).toBeUndefined();
    const rows = planRowsFromSnapshot({ projects: [DATA.projects[1]!] });
    expect(rows).toEqual([]);
  });
});

describe("comparePlanRows — nearest to starting work first", () => {
  const row = (
    review: string,
    name: string,
    progress?: { done: number; begun: number },
  ): PlanRow => ({
    key: `/p:${name}.md`,
    entry: {
      path: `dash/${name}.md`,
      display_name: name,
      review,
      step_total: 3,
      steps_done: progress?.done ?? 0,
      steps_begun: progress?.begun ?? 0,
    },
    projectDir: "/p",
    projectLabel: "p",
  });

  // Work in flight is nearer done than work not started — the same
  // nearest-to-done principle the dash rows encode. A begun plan whose review
  // went stale still outranks a freshly reviewed one nobody has touched.
  test("a begun plan outranks every unstarted one", () => {
    const rows = [
      row("reviewed", "a"),
      row("stale", "b", { done: 1, begun: 2 }),
      row("never-reviewed", "c"),
    ].sort(comparePlanRows);
    expect(rows.map((r) => r.entry.display_name)).toEqual(["b", "a", "c"]);
  });

  test("among begun plans, review rank then name still decide", () => {
    const rows = [
      row("stale", "z", { done: 1, begun: 1 }),
      row("reviewed", "y", { done: 2, begun: 3 }),
      row("stale", "a", { done: 0, begun: 1 }),
    ].sort(comparePlanRows);
    expect(rows.map((r) => r.entry.display_name)).toEqual(["y", "a", "z"]);
  });

  test("reviewed outranks stale outranks never-reviewed", () => {
    const rows = [
      row("never-reviewed", "c"),
      row("reviewed", "a"),
      row("stale", "b"),
    ].sort(comparePlanRows);
    expect(rows.map((r) => r.entry.review)).toEqual([
      "reviewed",
      "stale",
      "never-reviewed",
    ]);
  });

  test("within a review state, by name", () => {
    const rows = [row("reviewed", "zulu"), row("reviewed", "alpha")].sort(
      comparePlanRows,
    );
    expect(rows.map((r) => r.entry.display_name)).toEqual(["alpha", "zulu"]);
  });

  test("an unrecognized review spelling sorts last and never throws", () => {
    const rows = [row("who-knows", "a"), row("never-reviewed", "b")].sort(
      comparePlanRows,
    );
    expect(rows.map((r) => r.entry.review)).toEqual([
      "never-reviewed",
      "who-knows",
    ]);
  });
});
