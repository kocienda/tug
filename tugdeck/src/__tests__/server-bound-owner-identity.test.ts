/**
 * A server-bound owner identity is derived, never a card's frozen binding id.
 *
 * A card's `tugSessionId` is its **address**: fixed at bind time, correct for
 * every frame the card stamps with itself, and deliberately unmoved by a
 * rotation. The *server* keys a changeset entry by the line's current **seat**,
 * which a rotation does move. So an identity that travels to the server in an
 * owner or session position must be derived from the resolved entry
 * (`ChangesRouteController.requestOwnerId`), not read off the binding.
 *
 * Sending the binding id instead is the silent kind of wrong. The server has
 * no entry under a demoted segment, so it matches nothing; the display goes on
 * being correct because it resolves line-first; and the failure is a button
 * that does nothing and a row written where nothing reads it ([D167]). The
 * class was already closed on
 * the server side by `no_raw_session_id_reads` and `no_ad_hoc_binding_writes`;
 * this is the deck's half of the same fence.
 *
 * **What it checks.** Every call to a verb that carries identity on the wire —
 * the changeset draft store's writes and the changeset verb store's commands —
 * is read for `tugSessionId` anywhere in its argument list. A hit is either
 * routed through `requestOwnerId()`, or listed in {@link ALLOWED} with the
 * reason it is already right, or — for the three the fence caught outside the
 * Changes shade — pinned in {@link PENDING_SCOPE_CALL} until the user says
 * whether they are in scope. Entries are **counted, not whole-file-skipped**,
 * so a second raw use added to a listed file is still caught.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..");

/**
 * The verbs that put an owner or session id on the wire. Each one takes its
 * identity as an argument rather than reading it, which is what makes the
 * argument list the place to look.
 */
const WIRE_VERBS = [
  "setDraft",
  "requestDraft",
  "cancelDraft",
  "claim",
  "disclaim",
  "commit",
  "join",
  "discard",
  "replay",
  "expectServerJoin",
] as const;

/**
 * Calls allowed to name `tugSessionId`, by file, with a count and a reason.
 *
 * A count rather than a file exemption: the point is that *this* call is
 * already right, not that the file is exempt from the rule. **Empty on
 * purpose** — the only binding-id fallback in the shade lives inside
 * `requestOwnerId` itself, which is a derivation rather than a call, so
 * nothing here needs an exception yet. An entry added later should say why
 * that particular call is already line-aware, not that its file is tired of
 * the rule.
 */
const ALLOWED: { file: string; count: number; why: string }[] = [];

/**
 * The hits this fence caught that are **not** the Changes shade's, recorded
 * exactly and awaiting a scope call.
 *
 * Writing the guard was always going to catch uses beyond the shade, and the
 * brief settled in advance that those would be *measured and reported* rather
 * than quietly fixed or quietly waved through. This list is that report. It is
 * not an allowlist: it is asserted **exactly**, so a fourth raw use fails the
 * build the same way any other would, and fixing one of these three fails it
 * too until the entry comes out. Either direction is a change somebody has to
 * look at.
 *
 * Each of the three sends a card's binding id where the server wants the
 * line's seat. None of them is silent the way the draft path was — a discard,
 * a replay and a join all produce a visible outcome either way — so what is at
 * stake is the *receipt*: the landing row, the pane bulletin and the trailer
 * are addressed to a segment the server will not match, so they go to the
 * wrong place or nowhere. That is a real defect and a small one, and whether
 * it lands here or as follow-on work is the user's call, not this run's.
 *
 * Pinned by file and verb rather than by line. A line number would make every
 * edit above one of these three fail the build as though a raw use had been
 * added, which is a fence that cries wolf; the multiset is just as exact,
 * because a fourth call still adds an entry this list does not have. Where
 * they actually are is reported by the failing assertion, which reads the
 * lines off the tree as it stands.
 */
const PENDING_SCOPE_CALL: string[] = [
  "components/tugways/cards/session-changes/session-changes-view.tsx — discard(… tugSessionId …)",
  "components/tugways/cards/session-changes/session-changes-view.tsx — replay(… tugSessionId …)",
  "lib/join-mode-controller.ts — join(… tugSessionId …)",
];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (
      (name.endsWith(".ts") || name.endsWith(".tsx")) &&
      !name.endsWith(".test.ts")
    ) {
      found.push(path);
    }
  }
  return found;
}

/**
 * The text between a call's parentheses, by matching them. A regex cannot do
 * this: every one of these calls spans several lines and nests parens and
 * braces, and a lazy match stops at the first `)` inside an object literal.
 */
function callArguments(text: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(openParen + 1, i);
    }
  }
  return text.slice(openParen + 1);
}

interface Hit {
  file: string;
  line: number;
  verb: string;
}

/** How a hit is pinned: the call, without the line that moves under it. */
function label(hit: Hit): string {
  return `${hit.file} — ${hit.verb}(… tugSessionId …)`;
}

/** Every wire-verb call in one file's text whose arguments name `tugSessionId`. */
function scanText(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  for (const verb of WIRE_VERBS) {
    // `.verb(` or `verb(` at a call position — never `function verb(` or a
    // type's method signature, which declare rather than call.
    const pattern = new RegExp(`(?<![\\w$])${verb}\\s*\\(`, "g");
    for (const match of text.matchAll(pattern)) {
      const openParen = match.index + match[0].length - 1;
      const before = text.slice(Math.max(0, match.index - 40), match.index);
      if (/\b(function|interface|type)\s*$/.test(before)) continue;
      const args = callArguments(text, openParen);
      if (!/\btugSessionId\b/.test(args)) continue;
      hits.push({
        file,
        line: text.slice(0, match.index).split("\n").length,
        verb,
      });
    }
  }
  return hits;
}

/** Every wire-verb call in the deck whose arguments name `tugSessionId`. */
function rawIdentityCalls(): Hit[] {
  return sourceFiles(SRC).flatMap((path) =>
    scanText(path.slice(SRC.length + 1), readFileSync(path, "utf8")),
  );
}

describe("a server-bound owner identity is derived, not the card's binding", () => {
  test("no wire verb is handed a card's frozen tugSessionId", () => {
    const hits = rawIdentityCalls();
    const budget = new Map(ALLOWED.map((a) => [a.file, a.count]));
    const offenders: Hit[] = [];
    for (const hit of hits) {
      const left = budget.get(hit.file) ?? 0;
      if (left > 0) {
        budget.set(hit.file, left - 1);
        continue;
      }
      offenders.push(hit);
    }
    const found = offenders.map(label).sort();
    // Where they are, for the reader of a failure — read off the tree rather
    // than pinned, so it is right whatever has moved.
    const located = offenders
      .map((hit) => `  ${hit.file}:${hit.line} — ${hit.verb}`)
      .sort()
      .join("\n");

    expect(
      found,
      "these calls send a card's frozen binding id where the server expects the " +
        "line's current seat. After a rotation the server matches nothing and " +
        "answers nothing, and the failure is invisible because the display " +
        "resolves line-first and goes on being right. Derive the identity with " +
        "`changesController.requestOwnerId()`, or add the call to `ALLOWED` " +
        "with the reason it is already correct. If this is one of the three " +
        "already-known hits outside the Changes shade, `PENDING_SCOPE_CALL` is " +
        "where it is recorded — and if you have just fixed one, take it out of " +
        "that list in the same change. Where they are on the tree as it " +
        `stands:\n${located}`,
    ).toEqual([...PENDING_SCOPE_CALL].sort());
  });

  test("every allowlisted call is still there", () => {
    // An allowlist describing a workspace that has moved on is a guard that
    // has quietly stopped guarding.
    const hits = rawIdentityCalls();
    for (const allowed of ALLOWED) {
      expect(
        hits.filter((h) => h.file === allowed.file).length,
        `${allowed.file} is allowlisted for ${allowed.count} call(s) but does not have that many — drop or correct the entry`,
      ).toBeGreaterThanOrEqual(allowed.count);
    }
  });

  test("the sweep actually read source", () => {
    // A scan over an empty file list passes forever.
    expect(sourceFiles(SRC).length).toBeGreaterThan(100);
  });

  test("a reintroduced raw use is caught", () => {
    // The fence, shown working. A guard nobody has watched fail is a guard
    // that might be matching nothing — and this one's whole value is that the
    // *next* raw use fails the build rather than shipping as another silence.
    const reintroduced = [
      'getChangesetDraftStore()?.setDraft(',
      '  this.workspaceKey,',
      '  "session",',
      '  this.tugSessionId,',
      '  { message: text, edited: true },',
      ');',
    ].join("\n");
    expect(scanText("lib/somewhere.ts", reintroduced).map((h) => h.verb)).toEqual([
      "setDraft",
    ]);

    // The same call written correctly is not caught, so the fence is reading
    // the identity rather than the verb.
    const derived = reintroduced.replace("this.tugSessionId", "this.requestOwnerId()");
    expect(scanText("lib/somewhere.ts", derived)).toEqual([]);
  });
});
