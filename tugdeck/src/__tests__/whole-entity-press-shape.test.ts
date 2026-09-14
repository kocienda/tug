/**
 * Shape guard — every menu about an entity composes the whole-entity press.
 *
 * The rule (`lib/whole-entity-press`): a secondary press that opens a menu
 * about an entity selects that entity whole and paints it. It was once an
 * option on one hook, and three other hooks opened the same menus without
 * it — the same pill selected itself whole in prose and eight characters in
 * a receipt. The primitive ends that, but only for the hooks that compose it;
 * a fifth hook written tomorrow could learn the registry's items and skip the
 * press exactly as the last three did. This grep is the one mechanical thing
 * standing between the rule and that hook.
 *
 * The contract is crude on purpose. A module that RENDERS
 * `<TugEditorContextMenu` and mentions `contextmenu` (a React `onContextMenu`
 * or the native event name) opens a menu on a press, and must import the
 * press primitive — or compose a hook that does, which is how the surfaces
 * that mount `useTextSurfaceContextMenu` inherit it. Menus opened from a
 * BUTTON are not presses on an entity, and each is listed here with the
 * reason it stands outside the rule.
 */

import { describe, expect, it } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_ROOT = join(import.meta.dir, "..");

/** The primitive itself. Importing it is the whole of the obligation. */
const PRESS_MODULE = "whole-entity-press";

/** The component whose rendering marks a module as one that opens a menu. */
const MENU_COMPONENT = "tug-editor-context-menu";

/**
 * Hooks that compose the press and hand their handlers to a surface. A
 * module that imports one of these opens its menu through it, so the press
 * rides along; it needs no import of its own.
 */
const COMPOSERS = [
  "use-text-surface-context-menu",
  "use-copyable-text",
  "commit-identity-menu",
  "session-identity-menu",
  "use-text-input-responder",
  "use-annotation-menu",
];

/**
 * Modules that render the menu on something other than a press on an
 * entity, with the reason each stands outside the rule.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    "components/tugways/cards/session-changes/arc-row-menu.tsx",
    "opens from the row's ⋯ button, and from a right-click on a row that is a claim rather than an entity",
  ],
  [
    "components/tugways/tug-editor-context-menu.tsx",
    "is the menu component itself, and opens nothing",
  ],
  [
    "components/tripwires/tripwires-card.tsx",
    "opens from the row's ⋯ button, and from a right-click on a list row rather than on an entity",
  ],
]);

interface Module {
  relPath: string;
  source: string;
}

function* productionModules(): Iterable<Module> {
  const glob = new Glob("**/*.{ts,tsx}");
  for (const path of glob.scanSync(SRC_ROOT)) {
    if (path.includes("__tests__/")) continue;
    const abs = join(SRC_ROOT, path);
    yield { relPath: relative(SRC_ROOT, abs), source: readFileSync(abs, "utf8") };
  }
}

function importsModule(source: string, moduleName: string): boolean {
  const re = new RegExp(`from\\s+["'][^"']*\\/${moduleName}["']`);
  return re.test(source);
}

/** Renders the menu, and says so on a press. */
function opensMenuOnPress(source: string): boolean {
  return /<TugEditorContextMenu\b/.test(source) && /contextmenu/i.test(source);
}

describe("whole-entity-press shape guard", () => {
  it("every module that opens TugEditorContextMenu on a press composes the whole-entity press", () => {
    const offenders: string[] = [];
    const seen: string[] = [];
    for (const { relPath, source } of productionModules()) {
      if (!importsModule(source, MENU_COMPONENT) && !relPath.endsWith(`${MENU_COMPONENT}.tsx`)) {
        continue;
      }
      if (!opensMenuOnPress(source)) continue;
      seen.push(relPath);
      if (EXEMPT.has(relPath)) continue;
      const composes =
        importsModule(source, PRESS_MODULE) ||
        COMPOSERS.some((c) => importsModule(source, c));
      if (!composes) offenders.push(relPath);
    }
    // The guard has to be looking at something: the four hooks that opened
    // menus when the rule was written must all be in view, or the pattern
    // has drifted and the test is passing on an empty set.
    for (const hook of [
      "components/tugways/use-text-surface-context-menu.tsx",
      "components/tugways/commit-identity-menu.tsx",
      "components/tugways/session-identity-menu.tsx",
      "components/tugways/use-copyable-text.tsx",
    ]) {
      expect(seen, `the guard sees ${hook}`).toContain(hook);
    }
    expect(
      offenders,
      `modules opening a menu on a press without the whole-entity press:\n  ${offenders.join("\n  ")}\n` +
        `Compose \`useWholeEntityPress\` (or \`createWholeEntityPress\`) from lib/whole-entity-press, ` +
        `or list the module in EXEMPT with the reason its menu is not opened by a press on an entity.`,
    ).toEqual([]);
  });

  it("every exemption still names a module that exists and renders the menu", () => {
    const present = new Map<string, string>();
    for (const m of productionModules()) present.set(m.relPath, m.source);
    for (const [relPath, why] of EXEMPT) {
      expect(present.has(relPath), `${relPath} (${why}) exists`).toBe(true);
      expect(
        /<TugEditorContextMenu\b/.test(present.get(relPath) ?? ""),
        `${relPath} still renders the menu; drop the exemption otherwise`,
      ).toBe(true);
    }
  });

  it("the four hooks import the primitive directly", () => {
    for (const hook of [
      "components/tugways/use-text-surface-context-menu.tsx",
      "components/tugways/commit-identity-menu.tsx",
      "components/tugways/session-identity-menu.tsx",
      "components/tugways/use-copyable-text.tsx",
    ]) {
      const source = readFileSync(join(SRC_ROOT, hook), "utf8");
      expect(importsModule(source, PRESS_MODULE), `${hook} imports the press`).toBe(true);
    }
  });
});
