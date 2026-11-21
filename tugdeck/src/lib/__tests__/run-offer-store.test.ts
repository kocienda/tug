/**
 * RunOfferStore — the runs of a card's runnable offers: one run per offer,
 * the latest, moved by the shell exchange that carries it. Pure over the
 * store; no DOM.
 */
import { describe, expect, test } from "bun:test";

import {
  RunOfferStore,
  hashCommand,
  parseRunOfferKey,
  runOfferKey,
  runOfferStatus,
  type RunOfferRun,
} from "../run-offer-store";

function started(store: RunOfferStore, key: string, exchangeId: string, command = "make"): void {
  store.start({ key, exchangeId, command, cwd: "/proj", startedAtMs: 1000 });
}

describe("runOfferKey", () => {
  test("names the scope, the position and the command", () => {
    const key = runOfferKey("turn-1/m1", 2, "make check");
    expect(key).toBe(`turn-1/m1#2#${hashCommand("make check")}`);
  });

  test("an edited command at the same position is a different offer", () => {
    expect(runOfferKey("t/m", 0, "make")).not.toBe(runOfferKey("t/m", 0, "make check"));
  });

  test("the same command at two positions is two offers", () => {
    expect(runOfferKey("t/m", 0, "make")).not.toBe(runOfferKey("t/m", 1, "make"));
  });

  test("the hash is stable and eight hex digits", () => {
    expect(hashCommand("make check")).toBe(hashCommand("make check"));
    expect(hashCommand("make check")).toMatch(/^[0-9a-f]{8}$/);
    expect(hashCommand("")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("RunOfferStore — a run's life", () => {
  test("an offer that was never run has no run", () => {
    expect(new RunOfferStore().get("k")).toBeUndefined();
  });

  test("start puts the offer in flight and knows its exchange", () => {
    const store = new RunOfferStore();
    started(store, "k", "sh-1");
    expect(store.get("k")?.status).toBe("running");
    expect(store.get("k")?.output).toBe("");
    expect(store.keyForExchange("sh-1")).toBe("k");
    expect(store.keyForExchange("sh-2")).toBeUndefined();
  });

  test("the shell's echo corrects the directory and the clock", () => {
    const store = new RunOfferStore();
    started(store, "k", "sh-1");
    store.started("sh-1", { cwd: "/proj/sub", startedAtMs: 1010 });
    expect(store.get("k")?.cwd).toBe("/proj/sub");
    expect(store.get("k")?.startedAtMs).toBe(1010);
    expect(store.get("k")?.status).toBe("running");
  });

  test("settle carries the output and the exit, and reports the exchange as an offer's", () => {
    const store = new RunOfferStore();
    started(store, "k", "sh-1");
    expect(store.settle("sh-1", { output: "done\n", exitCode: 0, settledAtMs: 1500 })).toBe(true);
    const run = store.get("k");
    expect(run?.status).toBe("settled");
    expect(run?.output).toBe("done\n");
    expect(run?.exitCode).toBe(0);
    expect(run?.settledAtMs).toBe(1500);
  });

  test("settling an exchange that is no offer's changes nothing and says so", () => {
    const store = new RunOfferStore();
    started(store, "k", "sh-1");
    expect(store.settle("sh-9", { output: "x", exitCode: 0, settledAtMs: 1 })).toBe(false);
    expect(store.get("k")?.status).toBe("running");
  });

  test("running an offer again replaces its result", () => {
    const store = new RunOfferStore();
    started(store, "k", "sh-1");
    store.settle("sh-1", { output: "first\n", exitCode: 1, settledAtMs: 1500 });
    started(store, "k", "sh-2");
    expect(store.get("k")?.status).toBe("running");
    expect(store.get("k")?.output).toBe("");
    expect(store.keyForExchange("sh-1")).toBeUndefined();
    store.settle("sh-2", { output: "second\n", exitCode: 0, settledAtMs: 2500 });
    expect(store.get("k")?.output).toBe("second\n");
  });

  test("two offers keep their own runs", () => {
    const store = new RunOfferStore();
    started(store, "a", "sh-1", "make a");
    store.settle("sh-1", { output: "a\n", exitCode: 0, settledAtMs: 1500 });
    started(store, "b", "sh-2", "make b");
    expect(store.get("a")?.output).toBe("a\n");
    expect(store.get("b")?.status).toBe("running");
  });

  test("a refusal is a settled run that never ran", () => {
    const store = new RunOfferStore();
    store.refuse({
      key: "k",
      exchangeId: "sh-steer-1",
      command: "yes",
      cwd: "/proj",
      notice: "never ends",
      atMs: 1000,
    });
    const run = store.get("k");
    expect(run?.status).toBe("settled");
    expect(run?.refused).toBe(true);
    expect(run?.output).toBe("never ends");
  });

  test("every change is a new run object and a notification", () => {
    const store = new RunOfferStore();
    let heard = 0;
    store.subscribe(() => {
      heard += 1;
    });
    started(store, "k", "sh-1");
    const running = store.get("k");
    store.settle("sh-1", { output: "", exitCode: 0, settledAtMs: 1500 });
    expect(store.get("k")).not.toBe(running);
    expect(heard).toBe(2);
  });
});

describe("RunOfferStore — output as it is produced", () => {
  test("a piece grows the running run's output, in order", () => {
    const store = new RunOfferStore();
    started(store, "k", "sh-1");
    store.append("sh-1", "one\n");
    store.append("sh-1", "two\n");
    expect(store.get("k")?.output).toBe("one\ntwo\n");
    expect(store.get("k")?.status).toBe("running");
  });

  test("each piece is a new run object and a notification", () => {
    const store = new RunOfferStore();
    started(store, "k", "sh-1");
    const before = store.get("k");
    let heard = 0;
    store.subscribe(() => {
      heard += 1;
    });
    store.append("sh-1", "one\n");
    expect(store.get("k")).not.toBe(before);
    expect(heard).toBe(1);
  });

  test("the settle's whole output replaces what had streamed", () => {
    const store = new RunOfferStore();
    started(store, "k", "sh-1");
    store.append("sh-1", "one\n");
    store.settle("sh-1", { output: "one\ntwo\n", exitCode: 0, settledAtMs: 1500 });
    expect(store.get("k")?.output).toBe("one\ntwo\n");
  });

  test("a piece for another exchange, or after the settle, is dropped", () => {
    const store = new RunOfferStore();
    started(store, "k", "sh-1");
    store.append("sh-9", "stray\n");
    expect(store.get("k")?.output).toBe("");
    store.settle("sh-1", { output: "done\n", exitCode: 0, settledAtMs: 1500 });
    store.append("sh-1", "late\n");
    expect(store.get("k")?.output).toBe("done\n");
  });

  test("a stopped run settles with the output the settle carries", () => {
    const store = new RunOfferStore();
    started(store, "k", "sh-1");
    store.append("sh-1", "working\n");
    store.settle("sh-1", {
      output: "working\nstill working\n",
      exitCode: null,
      settledAtMs: 400_000,
      stoppedBy: "kill",
    });
    expect(store.get("k")?.output).toBe("working\nstill working\n");
    expect(store.get("k")?.stoppedBy).toBe("kill");
  });
});

describe("RunOfferStore — a run that has gone quiet", () => {
  test("a run carries the time of its last output", () => {
    const store = new RunOfferStore();
    started(store, "k", "sh-1");
    expect(store.get("k")?.lastOutputAtMs).toBeNull();
    store.append("sh-1", "one\n", 1200);
    store.append("sh-1", "two\n", 1900);
    expect(store.get("k")?.lastOutputAtMs).toBe(1900);
  });

  test("the question stands over the running run it was asked about", () => {
    const store = new RunOfferStore();
    started(store, "k", "sh-1");
    let heard = 0;
    store.subscribe(() => {
      heard += 1;
    });
    store.askQuiet("sh-9", { quietMs: 120_000, askedAtMs: 5 });
    expect(store.get("k")?.quiet).toBeNull();
    expect(heard).toBe(0);
    store.askQuiet("sh-1", { quietMs: 120_000, askedAtMs: 5 });
    expect(store.get("k")?.quiet).toEqual({ quietMs: 120_000, askedAtMs: 5 });
    expect(store.get("k")?.status).toBe("running");
    expect(heard).toBe(1);
  });

  test("the next output answers the question", () => {
    const store = new RunOfferStore();
    started(store, "k", "sh-1");
    store.askQuiet("sh-1", { quietMs: 120_000, askedAtMs: 5 });
    store.append("sh-1", "awake\n", 6);
    expect(store.get("k")?.quiet).toBeNull();
    expect(store.get("k")?.lastOutputAtMs).toBe(6);
  });

  test("keeping waiting answers it, and the run stays running", () => {
    const store = new RunOfferStore();
    started(store, "k", "sh-1");
    store.askQuiet("sh-1", { quietMs: 120_000, askedAtMs: 5 });
    store.answerQuiet("sh-1");
    expect(store.get("k")?.quiet).toBeNull();
    expect(store.get("k")?.status).toBe("running");
  });

  test("the settle takes the question down, and a settled run is never asked about", () => {
    const store = new RunOfferStore();
    started(store, "k", "sh-1");
    store.askQuiet("sh-1", { quietMs: 120_000, askedAtMs: 5 });
    store.settle("sh-1", { output: "", exitCode: null, settledAtMs: 9, stoppedBy: "kill" });
    expect(store.get("k")?.quiet).toBeNull();
    store.askQuiet("sh-1", { quietMs: 240_000, askedAtMs: 10 });
    expect(store.get("k")?.quiet).toBeNull();
  });
});

describe("parseRunOfferKey", () => {
  test("a key comes apart into what it was made of", () => {
    expect(parseRunOfferKey(runOfferKey("msg_01-b0", 2, "make"))).toEqual({
      scope: "msg_01-b0",
      index: 2,
      hash: hashCommand("make"),
    });
  });

  test("a scope may itself hold the separator", () => {
    expect(parseRunOfferKey(runOfferKey("a#b", 0, "make"))?.scope).toBe("a#b");
  });

  test("a string that is no key is refused", () => {
    expect(parseRunOfferKey("make")).toBeNull();
    expect(parseRunOfferKey("scope#x#abcd")).toBeNull();
  });
});

describe("RunOfferStore — which run is an offer's", () => {
  const key = (index: number, command = "make") => runOfferKey("msg_01-b0", index, command);

  test("the run keyed exactly is the offer's", () => {
    const store = new RunOfferStore();
    started(store, key(0), "sh-1");
    expect(store.match(key(0), new Set([key(0)]))?.exchangeId).toBe("sh-1");
  });

  test("a shifted index with a matching hash still finds its run", () => {
    const store = new RunOfferStore();
    started(store, key(0), "sh-1");
    store.settle("sh-1", { output: "done\n", exitCode: 0, settledAtMs: 1500 });
    // An offer was written above it: what was offer 0 is now offer 1, and
    // nothing on screen holds position 0 with this command.
    const present = new Set([key(0, "echo new"), key(1)]);
    expect(store.match(key(1), present)?.output).toBe("done\n");
    expect(store.match(key(0, "echo new"), present)).toBeUndefined();
  });

  test("a run whose own position is still on screen is not lent to another", () => {
    const store = new RunOfferStore();
    started(store, key(0), "sh-1");
    // The same command twice: offer 0 has run, offer 1 has not.
    const present = new Set([key(0), key(1)]);
    expect(store.match(key(0), present)?.exchangeId).toBe("sh-1");
    expect(store.match(key(1), present)).toBeUndefined();
  });

  test("the same command in another message is another offer", () => {
    const store = new RunOfferStore();
    started(store, key(0), "sh-1");
    const elsewhere = runOfferKey("msg_02-b0", 1, "make");
    expect(store.match(elsewhere, new Set([elsewhere]))).toBeUndefined();
  });

  test("an edited command does not inherit the old one's run", () => {
    const store = new RunOfferStore();
    started(store, key(0), "sh-1");
    const edited = key(0, "make check");
    expect(store.match(edited, new Set([edited]))).toBeUndefined();
  });

  test("forgetting a run frees its offer and its exchange", () => {
    const store = new RunOfferStore();
    started(store, key(0), "sh-1");
    store.forget(key(0));
    expect(store.get(key(0))).toBeUndefined();
    expect(store.keyForExchange("sh-1")).toBeUndefined();
  });
});

describe("RunOfferStore — runs read back from the ledger", () => {
  const row = (key: string, id: number, output: string, settledAtMs: number) => ({
    key,
    exchangeId: `restored-${id}`,
    command: "make",
    output,
    exitCode: 0,
    cwd: "/proj",
    startedAtMs: settledAtMs - 10,
    settledAtMs,
  });

  test("a ledgered run comes back settled under its offer", () => {
    const store = new RunOfferStore();
    store.restore([row("k", 1, "done\n", 1500)]);
    const run = store.get("k");
    expect(run?.status).toBe("settled");
    expect(run?.output).toBe("done\n");
    expect(run?.refused).toBe(false);
  });

  test("the later of two rows for one offer wins", () => {
    const store = new RunOfferStore();
    store.restore([row("k", 1, "first\n", 1500), row("k", 2, "second\n", 2500)]);
    expect(store.get("k")?.output).toBe("second\n");
  });

  test("the ledger's copy does not overwrite the run this page saw settle", () => {
    const store = new RunOfferStore();
    started(store, "k", "sh-1");
    store.settle("sh-1", { output: "live\n", exitCode: null, settledAtMs: 1500, stoppedBy: "kill" });
    store.restore([row("k", 1, "live\n", 1500)]);
    expect(store.get("k")?.exchangeId).toBe("sh-1");
    expect(store.get("k")?.stoppedBy).toBe("kill");
  });

  test("a run in flight is not replaced by an older ledgered one", () => {
    const store = new RunOfferStore();
    started(store, "k", "sh-2");
    store.restore([row("k", 1, "old\n", 900)]);
    expect(store.get("k")?.status).toBe("running");
  });

  test("the same answer applied twice notifies once", () => {
    const store = new RunOfferStore();
    let heard = 0;
    store.subscribe(() => {
      heard += 1;
    });
    store.restore([row("k", 1, "done\n", 1500)]);
    store.restore([row("k", 1, "done\n", 1500)]);
    expect(heard).toBe(1);
  });
});

describe("runOfferStatus — what the footer says", () => {
  const base: RunOfferRun = {
    key: "k",
    exchangeId: "sh-1",
    command: "make",
    status: "settled",
    output: "",
    exitCode: 0,
    cwd: "/proj",
    startedAtMs: 1000,
    settledAtMs: 2200,
    stoppedBy: null,
    refused: false,
    lastOutputAtMs: null,
    quiet: null,
  };

  test("a run in flight is running, with no duration yet", () => {
    expect(
      runOfferStatus({ ...base, status: "running", exitCode: null, settledAtMs: null }),
    ).toEqual({ label: "running", tone: "running", duration: null });
  });

  test("a clean exit", () => {
    expect(runOfferStatus(base)).toEqual({ label: "exit 0", tone: "ok", duration: "1.2s" });
  });

  test("a failing exit", () => {
    expect(runOfferStatus({ ...base, exitCode: 2, settledAtMs: 1040 })).toEqual({
      label: "exit 2",
      tone: "fail",
      duration: "40ms",
    });
  });

  test("a run the user stopped", () => {
    expect(runOfferStatus({ ...base, exitCode: null, stoppedBy: "kill" }).label).toBe("stopped");
  });

  test("a run stopped after a long wait is stopped, whatever its length", () => {
    expect(
      runOfferStatus({ ...base, exitCode: null, stoppedBy: "kill", settledAtMs: 601_000 }),
    ).toEqual({ label: "stopped", tone: "fail", duration: "600s" });
  });

  test("a refused command was not run, and took no time", () => {
    expect(runOfferStatus({ ...base, exitCode: 1, refused: true })).toEqual({
      label: "not run",
      tone: "fail",
      duration: null,
    });
  });
});
