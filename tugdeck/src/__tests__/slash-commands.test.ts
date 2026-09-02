/**
 * slash-commands.test.ts — pure-logic coverage for the local slash-command
 * dispatch infrastructure: the matcher's parsing behavior (bare match, trailing
 * args, unregistered/non-command rejection), case-insensitive completion
 * filtering, name extraction, and predicate-based filtering. These guard
 * behavior, not the registry's contents — adding a command is a registry edit,
 * not a test edit.
 */

import { describe, expect, test } from "bun:test";
import {
  buildCommandSubmission,
  buildSlashCommandLine,
  matchLocalSlashCommand,
  slashCommandName,
  type CommandLineAtom,
  type DraftAtom,
  type SlashCommandDraft,
} from "@/lib/slash-commands";
import { hasLeadingCommandAtom } from "@/lib/command-atom";
import { isCompactionSubmission } from "@/lib/code-session-store/compaction";
import { TUG_ATOM_CHAR } from "@/lib/tug-atom-img";
import type {
  CompletionItem,
  CompletionProvider,
} from "@/lib/tug-text-types";
import {
  filterCommandProvider,
  localCommandCompletionProvider,
  mergeCommandProviders,
} from "@/components/tugways/cards/completion-providers/local-commands";

describe("matchLocalSlashCommand", () => {
  test("bare /permissions and /model match, with surrounding whitespace tolerated", () => {
    expect(matchLocalSlashCommand("/permissions")).toEqual({
      name: "permissions",
      args: "",
    });
    expect(matchLocalSlashCommand("  /permissions  ")).toEqual({
      name: "permissions",
      args: "",
    });
    expect(matchLocalSlashCommand("/model")).toEqual({
      name: "model",
      args: "",
    });
  });

  test("a no-arg command with trailing args does not match (sent to claude)", () => {
    expect(matchLocalSlashCommand("/permissions foo")).toBeNull();
  });

  test("/resume takes a callsign, and still matches bare", () => {
    // Both forms are one command: bare opens the picker, an argument names the
    // session ([P12]). Without `takesArgs` the argument form would not match at
    // all and `/resume stocky-pixie` would be sent to claude as prose.
    expect(matchLocalSlashCommand("/resume")).toEqual({
      name: "resume",
      args: "",
    });
    expect(matchLocalSlashCommand("/resume stocky-pixie")).toEqual({
      name: "resume",
      args: "stocky-pixie",
    });
    // A lineage callsign is a callsign; nothing here parses its shape.
    expect(matchLocalSlashCommand("/resume petit-thaw-A1")).toEqual({
      name: "resume",
      args: "petit-thaw-A1",
    });
  });

  test("unregistered names and non-command text return null", () => {
    for (const input of ["/vim", "/theme", "permissions", "hello /permissions", "", "/"]) {
      expect(matchLocalSlashCommand(input)).toBeNull();
    }
  });

  test("/commit matches locally in every form — never falls through to claude", () => {
    // The pinned shadowing contract ([P04]): a matched local command is
    // dispatched via RUN_SLASH_COMMAND and never reaches codeSessionStore.send,
    // so claude's built-in /commit is dead. All three Table T01 invocations
    // must match.
    expect(matchLocalSlashCommand("/commit")).toEqual({ name: "commit", args: "" });
    expect(matchLocalSlashCommand("/commit now")).toEqual({
      name: "commit",
      args: "now",
    });
    expect(matchLocalSlashCommand("/commit Fix the flux capacitor")).toEqual({
      name: "commit",
      args: "Fix the flux capacitor",
    });
  });

  test("/shell and /btw take the rest of the line as their argument", () => {
    expect(matchLocalSlashCommand("/shell git status")).toEqual({
      name: "shell",
      args: "git status",
    });
    expect(matchLocalSlashCommand("/btw why")).toEqual({
      name: "btw",
      args: "why",
    });
    // Bare forms match too: `/shell` cautions on usage, `/btw` opens the
    // placard without asking.
    expect(matchLocalSlashCommand("/shell")).toEqual({ name: "shell", args: "" });
    expect(matchLocalSlashCommand("/btw")).toEqual({ name: "btw", args: "" });
  });

  test("/private is a bare toggle — trailing args fall through to claude", () => {
    expect(matchLocalSlashCommand("/private")).toEqual({
      name: "private",
      args: "",
    });
    // No `takesArgs`: `/private on` is not a form this command has, and
    // matching it would silently toggle on a word the user meant as a value.
    expect(matchLocalSlashCommand("/private on")).toBeNull();
  });

  test("neither composer route has a typeable name", () => {
    // A slash command is a one-shot verb; a route is a mode you stay in. The
    // route gestures are the Z4A tabs, ⌃⌘P / ⌃⌘C, and Escape.
    expect(matchLocalSlashCommand("/prompt")).toBeNull();
    expect(matchLocalSlashCommand("/changes")).toBeNull();
  });
});

describe("local-command completion", () => {
  function labels(provider: CompletionProvider, query: string): string[] {
    return provider(query).map((item) => item.label);
  }

  test("local provider filters by case-insensitive substring", () => {
    expect(labels(localCommandCompletionProvider(), "perm")).toEqual(["permissions"]);
    expect(labels(localCommandCompletionProvider(), "PERM")).toEqual(["permissions"]);
    expect(labels(localCommandCompletionProvider(), "model")).toEqual(["model"]);
    expect(labels(localCommandCompletionProvider(), "vim")).toEqual([]);
  });

  test("local provider matches a non-contiguous subsequence", () => {
    // `pm` is a subsequence of `permissions` (p…m…) but not a substring.
    expect(labels(localCommandCompletionProvider(), "pm")).toContain("permissions");
  });
});

describe("mergeCommandProviders", () => {
  function labels(provider: CompletionProvider, query: string): string[] {
    return provider(query).map((item) => item.label);
  }

  /** A provider over a fixed list of command names (no availability gating). */
  function namesProvider(...names: string[]): CompletionProvider {
    return (() =>
      names.map((name) => ({
        label: name,
        atom: { kind: "atom", type: "command", label: name, value: name },
      }))) as CompletionProvider;
  }

  test("orders by match quality, not the alphabet", () => {
    // The reported bug: `/permi` must surface `permissions` (a prefix hit)
    // above `fewer-permission-prompts` (a word-boundary hit), even though the
    // latter sorts first alphabetically.
    const merged = mergeCommandProviders(
      namesProvider("fewer-permission-prompts"),
      namesProvider("permissions"),
    );
    expect(labels(merged, "permi")).toEqual([
      "permissions",
      "fewer-permission-prompts",
    ]);
  });

  test("empty query falls back to alphabetical order", () => {
    const merged = mergeCommandProviders(
      namesProvider("zebra", "alpha"),
      namesProvider("mango"),
    );
    expect(labels(merged, "")).toEqual(["alpha", "mango", "zebra"]);
  });

  test("dedups by label, first provider wins", () => {
    const merged = mergeCommandProviders(
      namesProvider("permissions"),
      namesProvider("permissions"),
    );
    expect(labels(merged, "permi")).toEqual(["permissions"]);
  });

  test("claude's advertised commit loses to the local /commit entry", () => {
    // Exactly one /commit in the popup ([P04]): the session card lists the
    // local provider FIRST, so first-wins dedup resolves the name to the
    // local entry (described as Tug's landing verb) and claude's built-in
    // duplicate never shows. A non-colliding claude entry survives.
    const merged = mergeCommandProviders(
      localCommandCompletionProvider(),
      namesProvider("commit", "tugplug:devise"),
    );
    const items = merged("commit");
    const commitItems = items.filter((i) => i.label === "commit");
    expect(commitItems).toHaveLength(1);
    expect(commitItems[0].description).toContain("commit dialog");
    // The non-colliding claude entry survives the merge.
    expect(items.some((i) => i.label === "tugplug:devise")).toBe(true);
  });

  test("typing /dash offers the door skill, and not the surrendered alias", () => {
    // Load-bearing for the on-ramp: the query scores against `tugplug:dash`'s
    // leaf as an EXACT hit, so the front door ranks first among everything the
    // catalog offers for it. The card verbs are spelled `arc-*` now and are
    // not prefix hits for this query at all — which is the point of the split:
    // `/dash` reaches the door and nothing else competes for it.
    const merged = mergeCommandProviders(
      localCommandCompletionProvider(),
      namesProvider("tugplug:dash", "tugplug:arc-devise"),
    );
    const ranked = labels(merged, "dash");
    expect(ranked[0]).toBe("tugplug:dash");
    // And the surrendered alias is not in the popup at all — it never was
    // (aliases are excluded), and now it is not in the registry either.
    expect(ranked).not.toContain("dash");
  });

  test("typing /arc offers the card's own arc verbs", () => {
    // The other half of the split: the gestures a card answers itself are
    // `arc-bind`, `arc-join` and `arc-review`, and a bare `/arc` is how a user
    // finds all three. A skill sharing the namespace does not crowd them out —
    // it reaches PREFIX on its leaf, exactly as they do on their names.
    const merged = mergeCommandProviders(
      localCommandCompletionProvider(),
      namesProvider("tugplug:arc-devise"),
    );
    const ranked = labels(merged, "arc");
    expect(ranked).toContain("arc-bind");
    expect(ranked).toContain("arc-join");
    expect(ranked).toContain("arc-review");
  });
});

describe("slashCommandName", () => {
  test("extracts the name from a command line, args and whitespace tolerated", () => {
    expect(slashCommandName("/vim")).toBe("vim");
    expect(slashCommandName("  /add-dir /tmp/foo  ")).toBe("add-dir");
    expect(slashCommandName("/btw some text")).toBe("btw");
  });

  test("returns null for non-command text", () => {
    for (const input of ["hello", "", "/", "look /vim here"]) {
      expect(slashCommandName(input)).toBeNull();
    }
  });
});

describe("filterCommandProvider", () => {
  test("drops items whose name fails the predicate", () => {
    const base: CompletionProvider = () => [
      mkItem("init"),
      mkItem("vim"),
      mkItem("compact"),
      mkItem("theme"),
    ];
    const filtered = filterCommandProvider(
      base,
      (name) => name !== "vim" && name !== "theme",
    );
    expect(filtered("").map((i) => i.label)).toEqual(["init", "compact"]);
  });

  test("passes the query through to the wrapped provider", () => {
    const base: CompletionProvider = (q) => (q === "in" ? [mkItem("init")] : []);
    const filtered = filterCommandProvider(base, () => true);
    expect(filtered("in").map((i) => i.label)).toEqual(["init"]);
    expect(filtered("xx")).toEqual([]);
  });
});

function mkItem(name: string): CompletionItem {
  return {
    label: name,
    atom: { kind: "atom", type: "command", label: name, value: name },
  };
}

// Build the draft text + positioned atoms for a list of pieces, where a
// string piece is literal text and an atom piece becomes a TUG_ATOM_CHAR
// placeholder at its document position (mirroring the editor's substrate).
function mkDraft(
  pieces: ReadonlyArray<string | { type: string; value: string }>,
): { text: string; atoms: CommandLineAtom[] } {
  let text = "";
  const atoms: CommandLineAtom[] = [];
  for (const piece of pieces) {
    if (typeof piece === "string") {
      text += piece;
    } else {
      atoms.push({ position: text.length, segment: piece });
      text += TUG_ATOM_CHAR;
    }
  }
  return { text, atoms };
}

describe("buildSlashCommandLine", () => {
  test("plain text with no atoms passes through verbatim", () => {
    expect(buildSlashCommandLine("/compact prepare the plan", [])).toBe(
      "/compact prepare the plan",
    );
  });

  test("a lone leading command atom expands to /name", () => {
    const { text, atoms } = mkDraft([{ type: "command", value: "compact" }]);
    expect(buildSlashCommandLine(text, atoms)).toBe("/compact");
  });

  test("command atom + file mention expands to the path, and matches with focus", () => {
    const { text, atoms } = mkDraft([
      { type: "command", value: "compact" },
      " prepare ",
      { type: "file", value: "dash/message-architecture.md" },
      " plan",
    ]);
    const line = buildSlashCommandLine(text, atoms);
    expect(line).toBe(
      "/compact prepare dash/message-architecture.md plan",
    );
    expect(matchLocalSlashCommand(line)).toEqual({
      name: "compact",
      args: "prepare dash/message-architecture.md plan",
    });
  });

  test("typed /compact with a trailing file mention expands the path", () => {
    const { text, atoms } = mkDraft([
      "/compact prepare ",
      { type: "doc", value: "dash/x.md" },
    ]);
    expect(buildSlashCommandLine(text, atoms)).toBe(
      "/compact prepare dash/x.md",
    );
  });

  test("image atoms are dropped from the reconstructed line", () => {
    const { text, atoms } = mkDraft([
      "/compact ",
      { type: "image", value: "blob:ignored" },
      "focus",
    ]);
    const line = buildSlashCommandLine(text, atoms);
    expect(line).toBe("/compact focus");
    expect(matchLocalSlashCommand(line)).toEqual({
      name: "compact",
      args: "focus",
    });
  });
});

describe("one command namespace", () => {
  test("a leading `!` is ordinary prose, never a command", () => {
    // There is one sigil. `!ls` is text on its way to Claude; the shell
    // auto-router is what carries a bare `ls` to the shell instead.
    for (const line of ["!ls", "!shell echo hi", "!", "! wow that worked"]) {
      expect(matchLocalSlashCommand(line)).toBeNull();
    }
  });

  test("every command atom reconstructs with the slash sigil", () => {
    // No atom value gets a different sigil — a `command` atom is always
    // `/name`, whatever the name.
    const shell = mkDraft([{ type: "command", value: "shell" }, " git status"]);
    expect(buildSlashCommandLine(shell.text, shell.atoms)).toBe(
      "/shell git status",
    );
    const compact = mkDraft([{ type: "command", value: "compact" }, " focus"]);
    expect(buildSlashCommandLine(compact.text, compact.atoms)).toBe(
      "/compact focus",
    );
  });

  test("a reconstructed command atom line matches the local registry", () => {
    const { text, atoms } = mkDraft([
      { type: "command", value: "shell" },
      " echo hi",
    ]);
    expect(matchLocalSlashCommand(buildSlashCommandLine(text, atoms))).toEqual({
      name: "shell",
      args: "echo hi",
    });
  });
});

// The same substrate builder as `mkDraft`, but with full `AtomSegment`s —
// what the editor actually holds, and what `buildCommandSubmission` carries
// through to the transcript.
function mkSubstrate(
  pieces: ReadonlyArray<string | { type: string; value: string }>,
): SlashCommandDraft {
  let text = "";
  const atoms: DraftAtom[] = [];
  for (const piece of pieces) {
    if (typeof piece === "string") {
      text += piece;
      continue;
    }
    atoms.push({
      position: text.length,
      segment: {
        kind: "atom",
        type: piece.type,
        label: piece.value,
        value: piece.value,
      },
    });
    text += TUG_ATOM_CHAR;
  }
  return { text, atoms };
}

describe("buildCommandSubmission", () => {
  test("no draft (a menu dispatch): the command is a chip, args plain text", () => {
    expect(buildCommandSubmission("compact", "prepare the plan")).toEqual({
      text: `${TUG_ATOM_CHAR} prepare the plan`,
      atoms: [{ kind: "atom", type: "command", label: "compact", value: "compact" }],
    });
    expect(buildCommandSubmission("compact", "")).toEqual({
      text: TUG_ATOM_CHAR,
      atoms: [{ kind: "atom", type: "command", label: "compact", value: "compact" }],
    });
  });

  test("a typed /name with no atom still yields a leading command atom", () => {
    const draft = mkSubstrate(["/compact prepare the plan"]);
    expect(buildCommandSubmission("compact", "prepare the plan", draft)).toEqual({
      text: `${TUG_ATOM_CHAR} prepare the plan`,
      atoms: [{ kind: "atom", type: "command", label: "compact", value: "compact" }],
    });
  });

  test("argument atoms survive, in document order, after the command chip", () => {
    const draft = mkSubstrate([
      { type: "command", value: "compact" },
      " prepare ",
      { type: "file", value: "dash/plan.md" },
      " and ",
      { type: "file", value: "dash/next.md" },
    ]);
    const built = buildCommandSubmission("compact", "prepare …", draft);
    expect(built.text).toBe(
      `${TUG_ATOM_CHAR} prepare ${TUG_ATOM_CHAR} and ${TUG_ATOM_CHAR}`,
    );
    expect(built.atoms.map((a) => a.value)).toEqual([
      "compact",
      "dash/plan.md",
      "dash/next.md",
    ]);
  });

  test("the built substrate reads as a compaction submission", () => {
    const draft = mkSubstrate([{ type: "command", value: "compact" }, " focus"]);
    const built = buildCommandSubmission("compact", "focus", draft);
    expect(isCompactionSubmission(built.text, built.atoms)).toBe(true);
    expect(hasLeadingCommandAtom(built.text, built.atoms, TUG_ATOM_CHAR)).toBe(true);
  });

  test("a draft that doesn't lead with the command falls back to args", () => {
    const draft = mkSubstrate(["please ", { type: "file", value: "x.md" }]);
    expect(buildCommandSubmission("compact", "please x.md", draft)).toEqual({
      text: `${TUG_ATOM_CHAR} please x.md`,
      atoms: [{ kind: "atom", type: "command", label: "compact", value: "compact" }],
    });
  });

  test("surrounding whitespace in the draft is trimmed away", () => {
    const draft = mkSubstrate(["  /compact   prepare the plan   "]);
    expect(buildCommandSubmission("compact", "prepare the plan", draft).text).toBe(
      `${TUG_ATOM_CHAR} prepare the plan`,
    );
  });
});
