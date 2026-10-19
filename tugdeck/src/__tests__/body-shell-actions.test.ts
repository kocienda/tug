/**
 * Deck verbs a card in a body asks of the shell.
 *
 * A body page registers none of the shell's deck handlers — they hold the
 * DeckManager and the connection, which only the shell's `initActionDispatch`
 * has — so a card that called its own page's registry handler for one did
 * nothing from a body: Resume Session and Run in New Session from a menu.
 * Both are command rows the shell owns, so a body's dispatch of either goes
 * to the shell as `command.shell`, which runs it once, locally.
 *
 * @covers tugdeck/src/command-dispatch.ts
 * @covers tugdeck/src/bus/command-route.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { COMMANDS_BY_ID } from "@/components/tugways/command-registry";
import { _resetForTest, registerAction } from "../action-dispatch";
import { answerBodyCommands, dispatchCommand } from "../command-dispatch";
import { ownerOf } from "../bus/command-route";
import { _resetPageForTest, installPage } from "../bus/page";
import { createTestBus, type TestBus } from "../bus/test-bus";
import { bodyCardsStore } from "../lib/body-cards-store";

const SHELL_VERBS = [TUG_ACTIONS.RESUME_SESSION, TUG_ACTIONS.RUN_COMMAND_IN_NEW_SESSION];

let bus: TestBus | null = null;
const releases: Array<() => void> = [];

afterEach(() => {
  for (const release of releases.splice(0)) release();
  bus?.dispose();
  bus = null;
  _resetPageForTest();
  bodyCardsStore._reset();
  _resetForTest();
});

/** A shell answering body commands, and card `A`'s body, which is this page. */
async function shellAndBody(): Promise<TestBus> {
  bus = createTestBus();
  const shell = bus.shell();
  const body = bus.body("A", "session");
  bodyCardsStore.mark("A");
  installPage({ role: "body", cardId: "A", componentId: "session" });
  bus.install(body);
  releases.push(answerBodyCommands(shell.bus));
  await bus.flush();
  return bus;
}

/** The `command.shell` frames that crossed. */
function commandsToShell(b: TestBus): unknown[] {
  return b
    .frames()
    .filter((f) => f.envelope.kind === "action" && (f.envelope as { key?: string }).key === "command.shell")
    .map((f) => (f.envelope as { payload?: unknown }).payload);
}

describe("the shell's deck verbs, from a card's body", () => {
  test("both are command rows the shell owns", () => {
    for (const id of SHELL_VERBS) {
      const entry = COMMANDS_BY_ID.get(id);
      expect(entry).toBeDefined();
      expect(ownerOf(entry!)).toBe("shell");
    }
  });

  test("a body's Resume Session runs once in the shell, and is not sent back", async () => {
    const b = await shellAndBody();
    expect(dispatchCommand(TUG_ACTIONS.RESUME_SESSION, { sessionId: "s", projectDir: "/p" })).toBe(true);
    // The handler is the shell's: registered only once the body's dispatch
    // has gone, so the body could not have run it in its own registry.
    const ran: unknown[] = [];
    registerAction(TUG_ACTIONS.RESUME_SESSION, (payload) => ran.push(payload));
    await b.flush();
    expect(ran).toEqual([{ sessionId: "s", projectDir: "/p" }]);
    expect(commandsToShell(b)).toEqual([{ id: TUG_ACTIONS.RESUME_SESSION, payload: { sessionId: "s", projectDir: "/p" } }]);
  });

  test("a body's Run in New Session carries its command line and origin to the shell", async () => {
    const b = await shellAndBody();
    dispatchCommand(TUG_ACTIONS.RUN_COMMAND_IN_NEW_SESSION, { name: "brief", args: "x", originCardId: "A" });
    const ran: unknown[] = [];
    registerAction(TUG_ACTIONS.RUN_COMMAND_IN_NEW_SESSION, (payload) => ran.push(payload));
    await b.flush();
    expect(ran).toEqual([{ name: "brief", args: "x", originCardId: "A" }]);
  });

  test("a command the shell does not answer either is not bounced back to the body", async () => {
    const b = await shellAndBody();
    dispatchCommand(TUG_ACTIONS.RESUME_SESSION, { sessionId: "s", projectDir: "/p" });
    await b.flush();
    expect(commandsToShell(b)).toHaveLength(1);
    expect(b.frames().filter((f) => (f.envelope as { key?: string }).key === "command")).toEqual([]);
  });
});

/** Every `.ts`/`.tsx` source under `dir`, tests aside. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "__tests__") out.push(...sources(path));
    } else if (/\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

describe("card code reaches a shell deck verb through the shell", () => {
  test("no component reads a shell-only action's handler from its own page", () => {
    // A card's page may be a body, where the handler is never registered:
    // `getRegistryHandler(…)?.()` there is a silent no-op.
    const names = Object.entries(TUG_ACTIONS)
      .filter(([, wire]) => (SHELL_VERBS as readonly string[]).includes(wire))
      .map(([name]) => name);
    expect(names).toContain("RESUME_SESSION");
    expect(names).toContain("RUN_COMMAND_IN_NEW_SESSION");
    const pattern = new RegExp(`getRegistryHandler\\(\\s*TUG_ACTIONS\\.(${names.join("|")})\\b`);
    const offenders = sources(join(import.meta.dir, "..", "components")).filter((path) =>
      pattern.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
