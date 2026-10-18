/**
 * Deck verbs a card in a body asks of the shell.
 *
 * A body page registers none of the shell's deck handlers — they hold the
 * DeckManager and the connection, which only the shell's `initActionDispatch`
 * has — so a card that called its own page's registry handler for one did
 * nothing from a body: Resume Session and Run in New Session from a menu, and
 * `run-card-command` with arguments, which the shell sent to its own chain's
 * key card, where a body card has no content responder.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { ResponderChainManager } from "@/components/tugways/responder-chain";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { setKeyCardForwarder } from "../command-dispatch";
import {
  SHELL_ACTIONS_FOR_CARDS,
  dispatchShellAction,
  runShellActionForCard,
  setShellActionForwarder,
} from "../action-registry";
import {
  _resetForTest,
  dispatchAction,
  registerAction,
  registerResponderChainManager,
  registerRunCardCommand,
} from "../action-dispatch";

const releases: Array<() => void> = [];

afterEach(() => {
  for (const release of releases.splice(0)) release();
  _resetForTest();
});

describe("dispatchShellAction", () => {
  test("in the shell, runs the page's own handler and forwards nothing", () => {
    const ran: unknown[] = [];
    const forwarded: unknown[] = [];
    registerAction(TUG_ACTIONS.RESUME_SESSION, (payload) => ran.push(payload));
    releases.push(setShellActionForwarder((action, payload) => (forwarded.push({ action, payload }), true)));

    expect(dispatchShellAction(TUG_ACTIONS.RESUME_SESSION, { sessionId: "s", projectDir: "/p" })).toBe(true);
    expect(ran).toEqual([{ sessionId: "s", projectDir: "/p" }]);
    expect(forwarded).toEqual([]);
  });

  test("in a body, which registers no deck handler, hands the action to the shell", () => {
    const forwarded: unknown[] = [];
    releases.push(setShellActionForwarder((action, payload) => (forwarded.push({ action, payload }), true)));

    expect(
      dispatchShellAction(TUG_ACTIONS.RUN_COMMAND_IN_NEW_SESSION, { name: "brief", args: "x", originCardId: "A" }),
    ).toBe(true);
    expect(forwarded).toEqual([
      { action: TUG_ACTIONS.RUN_COMMAND_IN_NEW_SESSION, payload: { name: "brief", args: "x", originCardId: "A" } },
    ]);
  });

  test("an action outside the list is never forwarded", () => {
    const forwarded: unknown[] = [];
    releases.push(setShellActionForwarder((action) => (forwarded.push(action), true)));
    expect(dispatchShellAction("eval", {})).toBe(false);
    expect(forwarded).toEqual([]);
  });

  test("the shell runs a listed action a body handed over, and only a listed one", () => {
    const ran: unknown[] = [];
    registerAction(TUG_ACTIONS.RESUME_SESSION, (payload) => ran.push(payload));
    registerAction("eval", () => ran.push("eval"));

    expect(runShellActionForCard(TUG_ACTIONS.RESUME_SESSION, { sessionId: "s" })).toBe(true);
    expect(runShellActionForCard("eval", {})).toBe(false);
    expect(runShellActionForCard(TUG_ACTIONS.CLOSE, undefined)).toBe(false);
    expect(ran).toEqual([{ sessionId: "s" }]);
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
      .filter(([, wire]) => SHELL_ACTIONS_FOR_CARDS.has(wire))
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

describe("run-card-command", () => {
  test("with arguments, goes to the key card's body when the key card is one", () => {
    const forwarded: unknown[] = [];
    registerResponderChainManager(new ResponderChainManager());
    releases.push(
      setKeyCardForwarder((entry, payload) => (forwarded.push({ id: entry.id, routing: entry.routing, payload }), true)),
    );
    registerRunCardCommand();

    // `resume` is bridged, but only bare: the arguments form has no entry.
    dispatchAction({ action: "run-card-command", name: "resume", args: "quiet-harbor" });

    expect(forwarded).toEqual([
      { id: "run-card-command", routing: "key-card", payload: { name: "resume", args: "quiet-harbor" } },
    ]);
  });

  test("a name no entry bridges goes to the key card's body too", () => {
    const forwarded: unknown[] = [];
    releases.push(setKeyCardForwarder((entry, payload) => (forwarded.push({ id: entry.id, payload }), true)));
    registerRunCardCommand();

    dispatchAction({ action: "run-card-command", name: "model" });

    expect(forwarded).toEqual([{ id: "run-card-command", payload: { name: "model", args: "" } }]);
  });
});
