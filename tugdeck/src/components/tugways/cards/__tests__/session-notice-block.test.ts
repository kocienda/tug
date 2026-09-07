/**
 * The notice row's matcher and its registration — the two facts that decide
 * whether a bulletin from Tug renders as Tug or as something a user ran.
 *
 * Importing the block is what registers it, so this file resolves against the
 * real registration rather than a synthetic copy of it. That is the point: a
 * registration these assertions restated would be free to drift from the one
 * the app actually loads.
 */

import { describe, expect, it } from "bun:test";

import {
  matchesTugNotice,
  tugNoticeFindParts,
} from "@/components/tugways/cards/session-notice-block";
import {
  resolveCommandAttribution,
  resolveCommandPresentation,
} from "@/components/tugways/cards/session-command-block-registry";
import type { ShellExchangeMessage } from "@/lib/code-session-store/types";

describe("the tug-notice row", () => {
  it("claims the synthetic head and nothing a user could type", () => {
    expect(matchesTugNotice("tug notice arc-resolve")).toBe(true);
    expect(matchesTugNotice("tug notice base-motion")).toBe(true);
    // The word boundary is load-bearing: a real command that merely starts
    // with these letters is somebody's shell, not Tug's voice.
    expect(matchesTugNotice("tug notices")).toBe(false);
    expect(matchesTugNotice("tugtool arc undo")).toBe(false);
    expect(matchesTugNotice("git notice")).toBe(false);
  });

  it("renders as Tug's own quiet row", () => {
    // `tug` rather than `shell`: nothing ran on this card, and the row wore
    // the model's name until the attribution existed. `quiet` is what strips
    // the exchange chrome that would announce a process.
    expect(resolveCommandAttribution("tug notice arc-resolve")).toBe("tug");
    expect(
      resolveCommandPresentation({
        command: "tug notice arc-resolve",
        output: "",
      } as ShellExchangeMessage),
    ).toBe("quiet");
  });

  it("projects the notice itself for find, not the synthetic command", () => {
    const message = {
      command: "tug notice arc-resolve",
      output: "Nothing changed on disk.",
    } as ShellExchangeMessage;
    expect(tugNoticeFindParts(message)).toEqual(["Nothing changed on disk."]);
  });
});
