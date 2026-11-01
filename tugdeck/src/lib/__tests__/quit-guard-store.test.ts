/**
 * quit-guard-store — when a quit asks first, and what follows the answer.
 *
 * The claims: no turn in flight means no question; a question names what a quit
 * would stop; confirming quits and Cancel does not; a second request while the
 * question is up stacks nothing; and the work ending under the question takes it
 * back and quits, which a person's Cancel never does.
 *
 * The guard is exercised through its context, with the alert as a function the
 * test answers, so none of this needs a deck, an overlay or a host.
 */

import { describe, it, expect } from "bun:test";

import { QuitGuard, quitConfirmMessage, type QuitAlert } from "../quit-guard-store";

/** The live-turn answer, with titles the test can move. */
class FakeLiveTurns {
  listeners = new Set<() => void>();

  constructor(public titles: readonly string[]) {}

  getSnapshot = (): { titles: readonly string[] } => ({ titles: this.titles });

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(titles: readonly string[]): void {
    this.titles = titles;
    for (const listener of [...this.listeners]) listener();
  }
}

/** An alert the test answers, recording what it was shown, and closing on abort as the real one does. */
function fakeAlert(): {
  show: QuitAlert;
  shown: Parameters<QuitAlert>[0][];
  answer: (confirmed: boolean) => void;
} {
  const shown: Parameters<QuitAlert>[0][] = [];
  let settle: (confirmed: boolean) => void = () => {};
  return {
    shown,
    answer: (confirmed) => settle(confirmed),
    show: (options) => {
      shown.push(options);
      return new Promise<boolean>((resolve) => {
        settle = resolve;
        options.signal.addEventListener("abort", () => resolve(false), { once: true });
      });
    },
  };
}

function setup(
  titles: readonly string[],
  wire = { up: true },
): { guard: QuitGuard; turns: FakeLiveTurns; quits: () => number } {
  const turns = new FakeLiveTurns(titles);
  let quits = 0;
  const guard = new QuitGuard({ liveTurns: turns, canAsk: () => wire.up, quit: () => (quits += 1) });
  return { guard, turns, quits: () => quits };
}

describe("quitConfirmMessage", () => {
  it("names one session", () => {
    expect(quitConfirmMessage(["Refactor"])).toBe("'Refactor' is still working. Quitting will stop it.");
  });

  it("counts and names several", () => {
    expect(quitConfirmMessage(["Refactor", "Docs", "Tests"])).toBe(
      "3 sessions are still working: Refactor, Docs, Tests. Quitting will stop them.",
    );
  });
});

describe("QuitGuard.request", () => {
  it("asks nothing with no turn in flight", () => {
    const { guard } = setup([]);
    expect(guard.request()).toBe(false);
    expect(guard.getSnapshot()).toBe(0);
  });

  it("will ask with one turn or several, and says so once", () => {
    for (const titles of [["a"], ["a", "b"]]) {
      const { guard } = setup(titles);
      let notified = 0;
      guard.subscribe(() => (notified += 1));
      expect(guard.request()).toBe(true);
      expect(guard.getSnapshot()).toBe(1);
      expect(notified).toBe(1);
    }
  });

  it("asks nothing with the wire down, since the alert could never draw", () => {
    const { guard } = setup(["a"], { up: false });
    expect(guard.request()).toBe(false);
    expect(guard.getSnapshot()).toBe(0);
  });

  it("lets go of a question the wire left stranded", async () => {
    const wire = { up: true };
    const { guard } = setup(["a"], wire);
    const alert = fakeAlert();
    expect(guard.request()).toBe(true);
    const asked = guard.ask(alert.show);
    wire.up = false;
    expect(guard.request()).toBe(false);
    alert.answer(false);
    await asked;
  });

  it("stacks nothing while the question is up", async () => {
    const { guard } = setup(["a"]);
    const alert = fakeAlert();
    expect(guard.request()).toBe(true);
    const asked = guard.ask(alert.show);
    expect(guard.request()).toBe(true);
    expect(guard.getSnapshot()).toBe(1);
    expect(alert.shown).toHaveLength(1);
    alert.answer(false);
    await asked;
  });
});

describe("QuitGuard.ask", () => {
  it("shows the copy, as a danger", async () => {
    const { guard } = setup(["a"]);
    const alert = fakeAlert();
    guard.request();
    const asked = guard.ask(alert.show);
    const { title, message, confirmLabel, cancelLabel, confirmRole } = alert.shown[0]!;
    expect({ title, message, confirmLabel, cancelLabel, confirmRole }).toEqual({
      title: "Quit Tug?",
      message: "'a' is still working. Quitting will stop it.",
      confirmLabel: "Quit",
      cancelLabel: "Cancel",
      confirmRole: "danger",
    });
    alert.answer(false);
    await asked;
  });

  it("quits on confirm", async () => {
    const { guard, quits } = setup(["a"]);
    const alert = fakeAlert();
    guard.request();
    const asked = guard.ask(alert.show);
    alert.answer(true);
    await asked;
    expect(quits()).toBe(1);
  });

  it("does not quit on Cancel, and a later request asks again", async () => {
    const { guard, quits } = setup(["a"]);
    const alert = fakeAlert();
    guard.request();
    const asked = guard.ask(alert.show);
    alert.answer(false);
    await asked;
    expect(quits()).toBe(0);
    expect(guard.request()).toBe(true);
    expect(guard.getSnapshot()).toBe(2);
  });

  it("takes the question back and quits when the work ends under it", async () => {
    const { guard, turns, quits } = setup(["a", "b"]);
    const alert = fakeAlert();
    guard.request();
    const asked = guard.ask(alert.show);
    turns.set(["b"]);
    expect(alert.shown[0]!.signal.aborted).toBe(false);
    turns.set([]);
    expect(alert.shown[0]!.signal.aborted).toBe(true);
    await asked;
    expect(quits()).toBe(1);
  });

  it("stops listening once answered, so a turn ending after a Cancel quits nothing", async () => {
    const { guard, turns, quits } = setup(["a"]);
    const alert = fakeAlert();
    guard.request();
    const asked = guard.ask(alert.show);
    alert.answer(false);
    await asked;
    turns.set([]);
    expect(turns.listeners.size).toBe(0);
    expect(quits()).toBe(0);
  });

  it("quits with no alert when the work ended before the question was shown", async () => {
    const { guard, turns, quits } = setup(["a"]);
    const alert = fakeAlert();
    guard.request();
    turns.set([]);
    await guard.ask(alert.show);
    expect(alert.shown).toHaveLength(0);
    expect(quits()).toBe(1);
  });
});
