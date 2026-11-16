/**
 * Which plain fences can be run where they stand, and how a run finds its
 * fence again.
 */

import { describe, expect, test } from "bun:test";
import { isRunOfferLang, isShellFenceLang } from "../enhance-run-offer";
import { RunOfferStore, runOfferKey } from "@/lib/run-offer-store";

describe("isShellFenceLang", () => {
  test("bash, sh and zsh fences are runnable", () => {
    expect(isShellFenceLang("bash")).toBe(true);
    expect(isShellFenceLang("sh")).toBe(true);
    expect(isShellFenceLang("zsh")).toBe(true);
    expect(isShellFenceLang("Bash")).toBe(true);
  });

  test("no other fence is", () => {
    for (const lang of ["shell", "console", "fish", "powershell", "python", "ts", "text", "", "bashrc"]) {
      expect(isShellFenceLang(lang)).toBe(false);
    }
    expect(isShellFenceLang(null)).toBe(false);
  });

  test("an offer's language is its own, and not a plain shell fence", () => {
    expect(isShellFenceLang("tugrun")).toBe(false);
    expect(isRunOfferLang("bash")).toBe(false);
  });
});

describe("a plain fence's run", () => {
  test("is kept and restored under the same key an offer in its place would have", () => {
    const scope = "msg-1-b0";
    const command = "echo from-a-fence";
    // The fence is the second runnable block of its message.
    const key = runOfferKey(scope, 1, command);

    const live = new RunOfferStore();
    live.start({ key, exchangeId: "x1", command, cwd: "/tmp", startedAtMs: 100 });
    live.settle("x1", { exitCode: 0, output: "from-a-fence\n", settledAtMs: 112 });
    expect(live.match(key, new Set([key]))?.output).toBe("from-a-fence\n");

    const reloaded = new RunOfferStore();
    reloaded.restore([
      {
        key,
        command,
        exchangeId: "restored-7",
        cwd: "/tmp",
        exitCode: 0,
        output: "from-a-fence\n",
        startedAtMs: 100,
        settledAtMs: 112,
      },
    ]);
    const run = reloaded.match(key, new Set([key]));
    expect(run?.status).toBe("settled");
    expect(run?.output).toBe("from-a-fence\n");
  });
});
