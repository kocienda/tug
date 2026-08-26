/**
 * command-atom — unit tests for the slash-command atom helpers.
 * Pure-logic coverage; no DOM, no async.
 */

import { describe, expect, test } from "bun:test";

import {
  commandWireText,
  chipStyle,
  chipDisplayLabel,
  chipHasIcon,
  chipMark,
  detectCommandEcho,
  hasLeadingCommandAtom,
  mintLeadingCommandAtom,
  SESSION_CHIP_GEOMETRY,
  SESSION_CHIP_INK_TOKEN,
} from "../command-atom";
import type { ContentBlock } from "@/protocol";

function textBlocks(text: string): ContentBlock[] {
  return [{ type: "text", text }];
}

describe("commandWireText", () => {
  test("prepends the leading slash to a bare name", () => {
    expect(commandWireText("tugplug:commit")).toBe("/tugplug:commit");
  });

  test("appends trimmed argument text after a space", () => {
    expect(commandWireText("cmd", "one two")).toBe("/cmd one two");
  });

  test("ignores empty / whitespace-only args", () => {
    expect(commandWireText("cmd", "   ")).toBe("/cmd");
    expect(commandWireText("cmd", "")).toBe("/cmd");
  });

  test("is idempotent on a value that already carries a slash", () => {
    expect(commandWireText("/help")).toBe("/help");
  });
});

describe("chipStyle", () => {
  test("is the one shared appearance for every atom type (default tokens)", () => {
    expect(chipStyle()).toEqual({
      tokens: {
        surface: "--tug7-surface-atom-primary-normal-default-rest",
        key: "--tug7-surface-control-primary-filled-action-rest",
        border: "--tug7-element-atom-border-normal-default-rest",
        icon: "--tug7-element-atom-icon-normal-default-rest",
        text: "--tug7-element-atom-text-normal-default-rest",
      },
      geometry: { radius: 3, paddingX: 6, gap: 4 },
    });
  });
});

describe("chipDisplayLabel", () => {
  test("a command shows its leading slash", () => {
    expect(chipDisplayLabel("command", "tugplug:commit", "tugplug:commit")).toBe(
      "/tugplug:commit",
    );
  });

  test("every command name shows the same slash sigil", () => {
    // One namespace, one sigil — no name gets a different marker.
    for (const name of ["shell", "btw", "commit", "model"]) {
      expect(chipDisplayLabel("command", name, name)).toBe(`/${name}`);
    }
  });

  test("other types show their stored label verbatim", () => {
    expect(chipDisplayLabel("file", "README.md", "README.md")).toBe("README.md");
    expect(chipDisplayLabel("link", "example.com", "https://example.com")).toBe(
      "example.com",
    );
  });
});

describe("chipHasIcon", () => {
  test("a command has no icon (the slash is its marker); others do", () => {
    expect(chipHasIcon("command")).toBe(false);
    expect(chipHasIcon("file")).toBe(true);
    expect(chipHasIcon("link")).toBe(true);
  });

  test("a session reserves the same leading span — for its dot", () => {
    expect(chipHasIcon("session")).toBe(true);
  });
});

describe("chipMark", () => {
  test("the session's mark is the dot, never a glyph", () => {
    expect(chipMark("session")).toBe("dot");
    expect(chipMark("file")).toBe("icon");
    expect(chipMark("command")).toBe("none");
  });
});

describe("the session chip face", () => {
  test("a session shows the full project/callsign run — the title grammar's own spelling", () => {
    expect(
      chipDisplayLabel("session", "tugtool/quirky-hull", "tugtool/quirky-hull"),
    ).toBe("tugtool/quirky-hull");
    // A fork's lineage rides the callsign; the segments are not a path.
    expect(
      chipDisplayLabel("session", "tugtool/quirky-hull-A1", "tugtool/quirky-hull-A1"),
    ).toBe("tugtool/quirky-hull-A1");
  });

  test("is a pill in text ink — outside the shared atom family", () => {
    expect(SESSION_CHIP_GEOMETRY.radius).toBeGreaterThan(
      chipStyle().geometry.radius,
    );
    expect(SESSION_CHIP_INK_TOKEN).toBe(
      "--tug7-element-global-text-normal-default-rest",
    );
    // The theme's atom tokens are the family's; the session paints in ordinary
    // text ink, and the dot is its only color.
    expect(SESSION_CHIP_INK_TOKEN).not.toBe(chipStyle().tokens.text);
  });
});

describe("detectCommandEcho", () => {
  // Golden fixture: the exact echo claude emits for an expanded skill
  // (captured from the real CLI against a disable-model-invocation skill).
  test("recovers the bare name from a real no-args echo", () => {
    const echo =
      "<command-message>tugplug:probe-noop</command-message>\n" +
      "<command-name>/tugplug:probe-noop</command-name>";
    expect(detectCommandEcho(textBlocks(echo))).toEqual({
      value: "tugplug:probe-noop",
    });
  });

  test("recovers args from a <command-args> envelope", () => {
    const echo =
      "<command-message>tugplug:devise</command-message>\n" +
      "<command-name>/tugplug:devise</command-name>\n" +
      "<command-args>a plan for slash commands</command-args>";
    expect(detectCommandEcho(textBlocks(echo))).toEqual({
      value: "tugplug:devise",
      args: "a plan for slash commands",
    });
  });

  test("is tolerant of a name-only envelope (no command-message)", () => {
    const echo = "<command-name>/context</command-name>";
    expect(detectCommandEcho(textBlocks(echo))).toEqual({ value: "context" });
  });

  test("returns null for ordinary prose", () => {
    expect(detectCommandEcho(textBlocks("just some text"))).toBeNull();
  });

  test("returns null when the envelope is embedded in prose (false positive guard)", () => {
    const text =
      "I ran <command-name>/help</command-name> earlier and it worked.";
    expect(detectCommandEcho(textBlocks(text))).toBeNull();
  });

  test("returns null for a multi-block (e.g. image-bearing) message", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "<command-name>/help</command-name>" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "x" },
      },
    ];
    expect(detectCommandEcho(blocks)).toBeNull();
  });
});

describe("hasLeadingCommandAtom", () => {
  const C = "\uFFFC";
  const cmd = { type: "command" };
  const file = { type: "file" };

  test("true for a single command atom at the message start", () => {
    expect(hasLeadingCommandAtom(C, [cmd], C)).toBe(true);
  });

  test("true with trailing argument text after the command", () => {
    expect(hasLeadingCommandAtom(`${C} one two`, [cmd], C)).toBe(true);
  });

  test("true with a trailing argument atom (file mention) after the command", () => {
    expect(hasLeadingCommandAtom(`${C} ${C}`, [cmd, file], C)).toBe(true);
  });

  test("false when text leads the command (claude won't expand it)", () => {
    expect(hasLeadingCommandAtom(`run ${C}`, [cmd], C)).toBe(false);
  });

  test("false when a non-command atom leads", () => {
    expect(hasLeadingCommandAtom(`${C}${C}`, [file, cmd], C)).toBe(false);
  });

  test("false for a non-command atom", () => {
    expect(hasLeadingCommandAtom(C, [file], C)).toBe(false);
  });
});

describe("mintLeadingCommandAtom", () => {
  const K = "￼";
  const cmd = (name: string) => ({
    kind: "atom" as const,
    type: "command" as const,
    label: name,
    value: name,
  });
  const file = { kind: "atom" as const, type: "file", label: "x.ts", value: "src/x.ts" };

  test("lifts a bare command out of the text, leaving the args as written", () => {
    expect(
      mintLeadingCommandAtom("/tugplug:plan-review dash/x.md", [], K),
    ).toEqual({
      text: `${K} dash/x.md`,
      atoms: [cmd("tugplug:plan-review")],
    });
  });

  test("keeps every character after the name, newlines and all", () => {
    const minted = mintLeadingCommandAtom("/dash a.md\n\nstart there: b.md", [], K);
    expect(minted?.text).toBe(`${K} a.md\n\nstart there: b.md`);
  });

  test("mints for a bare command with no arguments", () => {
    expect(mintLeadingCommandAtom("/commit", [], K)).toEqual({
      text: K,
      atoms: [cmd("commit")],
    });
  });

  test("prepends the atom so existing atoms keep their ordinals", () => {
    const minted = mintLeadingCommandAtom(`/implement ${K}`, [file], K);
    expect(minted?.text).toBe(`${K} ${K}`);
    expect(minted?.atoms).toEqual([cmd("implement"), file]);
  });

  test("declines when the text already leads with a command atom", () => {
    expect(mintLeadingCommandAtom(`${K} args`, [cmd("commit")], K)).toBeNull();
  });

  test("declines on prose, on a path, and on a mid-sentence command", () => {
    expect(mintLeadingCommandAtom("just some prose", [], K)).toBeNull();
    expect(mintLeadingCommandAtom("/Users/ken/src", [], K)).toBeNull();
    expect(mintLeadingCommandAtom("/usr/bin/env", [], K)).toBeNull();
    expect(mintLeadingCommandAtom("run /commit when done", [], K)).toBeNull();
  });

  test("declines when the slash leads a word the grammar rejects", () => {
    expect(mintLeadingCommandAtom("/Commit now", [], K)).toBeNull();
    expect(mintLeadingCommandAtom("/-bad thing", [], K)).toBeNull();
  });
});
