/**
 * commit-block-receipt-layout.test.tsx — Claude's own `git commit` lays its
 * message out the way the `/commit` receipt does.
 *
 * The transcript names both blocks "Git Commit", so they have to read as one
 * act: the message in the shared `CommitMessage` well (not a "message"
 * disclosure over a block of lines), above the file list, under the receipt
 * face, inset by the receipt inset every framed receipt reads.
 *
 * No DOM: `CommitBlock` calls no hooks, so it is called as a function and its
 * element tree read as data. The inset half is pinned in the stylesheet, where
 * it lives — keyed on the block's slot, because `.tugx-commit` is also the
 * scope class the History list wears and the History shade is not to move.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";

import {
  CommitBlock,
  type CommitData,
} from "@/components/tugways/body-kinds/commit-block";
import { CommitMessage } from "@/components/tugways/commit-presentation";
import { BlockDisclosure } from "@/components/tugways/blocks/block-bits/block-disclosure";

const COMMIT: CommitData = {
  hash: "450d6b28",
  branch: "main",
  summary: "Add separating space when accepting a completion",
  body: ["The space goes in after the atom.", "", "- one", "- two"],
  filesChanged: 1,
  insertions: 3,
  deletions: 1,
  files: [{ path: "src/a.ts", status: "M", added: 3, removed: 1 }],
};

type El = React.ReactElement<Record<string, unknown>>;

function children(el: El): El[] {
  return React.Children.toArray(
    el.props.children as React.ReactNode,
  ).filter(React.isValidElement) as El[];
}

describe("CommitBlock wears the /commit receipt's message layout", () => {
  const root = CommitBlock({ commit: COMMIT }) as El;
  const kids = children(root);

  test("the root wears the receipt face beside its own slot", () => {
    expect(String(root.props.className).split(" ")).toEqual([
      "tugx-commit",
      "tugx-commit-receipt",
    ]);
    expect(root.props["data-slot"]).toBe("commit-block");
  });

  test("the message is the shared well, whole, above the file list", () => {
    const messageAt = kids.findIndex((k) => k.type === CommitMessage);
    const filesAt = kids.findIndex((k) => k.type === BlockDisclosure);
    expect(messageAt).toBeGreaterThan(-1);
    expect(filesAt).toBeGreaterThan(messageAt);
    expect(kids[messageAt]!.props.body).toBe(COMMIT.body.join("\n"));
    // The file breakdown is the only disclosure left: the message has none.
    expect(kids.filter((k) => k.type === BlockDisclosure)).toHaveLength(1);
  });

  test("a commit with no body renders no well", () => {
    const bare = CommitBlock({ commit: { ...COMMIT, body: [] } }) as El;
    expect(children(bare).some((k) => k.type === CommitMessage)).toBe(false);
  });
});

describe("the inset is keyed on the block's slot", () => {
  const css = readFileSync(
    join(import.meta.dir, "../components/tugways/body-kinds/commit-block.css"),
    "utf8",
  );

  /** The declarations of the first rule whose selector is exactly `sel`. */
  function rule(sel: string): string {
    const at = css.indexOf(`\n${sel} {`);
    expect(at).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  }

  test("the block pads with the receipt inset on both axes", () => {
    expect(rule('[data-slot="commit-block"]')).toContain(
      "padding: var(--tugx-block-receipt-inset-block) var(--tugx-block-receipt-inset-inline);",
    );
  });

  test("the well inside it does not add the inset a second time", () => {
    expect(rule('[data-slot="commit-block"] .tugx-commit-message')).toContain(
      "padding-inline: 0;",
    );
  });

  test("the shared scope class the History list wears keeps its own padding", () => {
    expect(rule(".tugx-commit")).not.toContain("receipt-inset");
  });
});
