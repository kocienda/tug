/**
 * Unit tests for system-metadata-fixture (D5).
 *
 * Reads the actual shipped `capabilities/<LATEST>/system-metadata.jsonl`
 * from disk and exercises the pure factory + position-0 gate helper. The
 * singleton `getFixtureSessionMetadataStore` is deliberately not tested
 * here — it depends on the Vite virtual module which bun-test can't
 * resolve.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type React from "react";

import { createFixtureSessionMetadataStore } from "../components/tugways/cards/completion-fixtures/system-metadata-fixture";
import { wrapPositionZero } from "../components/tugways/cards/completion-providers/position-zero";
import type { CompletionProvider } from "../lib/tug-text-types";
import type { TugPromptEntryDelegate } from "../components/tugways/tug-prompt-entry";

// ---------------------------------------------------------------------------
// Load the shipped capture.
// ---------------------------------------------------------------------------

const CAPABILITIES_ROOT = join(import.meta.dir, "..", "..", "..", "capabilities");
const latestVersion = readFileSync(
  join(CAPABILITIES_ROOT, "LATEST"),
  "utf-8",
).trim();
const rawJsonl = readFileSync(
  join(CAPABILITIES_ROOT, latestVersion, "system-metadata.jsonl"),
  "utf-8",
);

// ---------------------------------------------------------------------------
// createFixtureSessionMetadataStore
// ---------------------------------------------------------------------------

describe("createFixtureSessionMetadataStore", () => {
  it("parses the captured payload and surfaces all commands via the provider", () => {
    const store = createFixtureSessionMetadataStore(rawJsonl);
    const snapshot = store.getSnapshot();

    // Payload counts for the shipped v2.1.258 capture. The tugplug skills
    // are the prefixed set (dash/dash-audit/dash-devise/dash-implement/
    // dash-plan/dash-review/draft/tripwire; spike-card is repo-local and
    // was in this capture); the agent list is the built-in Claude Code set:
    //   slash_commands: 58  (26 upgrade to "skill", 32 stay "local")
    //   agents: 5
    //   total after dedup: 63
    expect(snapshot.slashCommands.length).toBe(63);

    const byCategory = new Map<string, number>();
    for (const cmd of snapshot.slashCommands) {
      byCategory.set(cmd.category, (byCategory.get(cmd.category) ?? 0) + 1);
    }
    expect(byCategory.get("local")).toBe(32);
    expect(byCategory.get("skill")).toBe(26);
    expect(byCategory.get("agent")).toBe(5);
  });

  it("ranks the `tugplug:` prefix matches for `tug` ahead of fuzzy hits", () => {
    const store = createFixtureSessionMetadataStore(rawJsonl);
    const provider = store.getCommandCompletionProvider();
    const hits = provider("tug");
    // Eight commands start with `tug` (the `tugplug:` family) — those are the
    // strong prefix matches and must lead. Fuzzy/subsequence hits (e.g.
    // `extra-usage`, where t…u…g appears in order) are still offered — that's
    // the @-file popup's behavior — but rank strictly below the prefix matches.
    const prefixed = hits.filter((h) => h.label.startsWith("tugplug:"));
    expect(prefixed.length).toBe(8);
    expect(hits.slice(0, 8).every((h) => h.label.startsWith("tugplug:"))).toBe(true);
    for (const h of hits) {
      expect(h.atom.type).toBe("command");
    }
  });

  it("narrows `com` to the two compact commands, prefix match first", () => {
    // `tugplug:commit` left the capture at v2.1.217 — landing is the
    // user's gesture (`/commit` in the composer), not a plugin skill.
    // `autocompact` arrived in v2.1.222 and carries `com` as a substring,
    // so it is offered but ranks below the `compact` prefix match.
    const store = createFixtureSessionMetadataStore(rawJsonl);
    const provider = store.getCommandCompletionProvider();
    const names = provider("com").map((h) => h.label);
    expect(names).toEqual(["compact", "autocompact"]);
  });

  it("rejects empty JSONL", () => {
    expect(() => createFixtureSessionMetadataStore("")).toThrow(/empty/);
  });
});

// ---------------------------------------------------------------------------
// wrapPositionZero
// ---------------------------------------------------------------------------

function makeEntryRef(text: string): React.RefObject<TugPromptEntryDelegate | null> {
  const editor = { textContent: text } as unknown as HTMLElement;
  const delegate = {
    getEditorElement: () => editor,
  } as unknown as TugPromptEntryDelegate;
  return { current: delegate };
}

describe("wrapPositionZero", () => {
  const inner: CompletionProvider = ((q: string) => [
    {
      label: `hit:${q}`,
      atom: { kind: "atom", type: "command", label: q, value: q },
    },
  ]) as CompletionProvider;

  it("returns [] when the editor is empty", () => {
    const gated = wrapPositionZero(makeEntryRef(""), "/", inner);
    expect(gated("x")).toEqual([]);
  });

  it("returns [] when the first character is not `/`", () => {
    const gated = wrapPositionZero(makeEntryRef("hello /world"), "/", inner);
    expect(gated("world")).toEqual([]);
  });

  it("passes through when the first character is `/`", () => {
    const gated = wrapPositionZero(makeEntryRef("/tugplug:plan"), "/", inner);
    const hits = gated("plan");
    expect(hits.length).toBe(1);
    expect(hits[0].label).toBe("hit:plan");
  });

  it("gates on the trigger it was given, not on `/` specifically", () => {
    // The gate is generic over its trigger character — a provider wrapped
    // for `@` opens on a leading `@` and stays shut on a leading `/`.
    const slashDoc = wrapPositionZero(makeEntryRef("/model"), "@", inner);
    expect(slashDoc("model")).toEqual([]);
    const mentionDoc = wrapPositionZero(makeEntryRef("@plan.md"), "@", inner);
    expect(mentionDoc("plan").length).toBe(1);
  });

  it("returns [] when the ref is null (pre-mount)", () => {
    const ref: React.RefObject<TugPromptEntryDelegate | null> = { current: null };
    const gated = wrapPositionZero(ref, "/", inner);
    expect(gated("x")).toEqual([]);
  });
});
