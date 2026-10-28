/**
 * The Edit-menu enablement guard.
 *
 * Cut / Copy / Paste / Delete are `routing: "native"`. The chord pipeline
 * passes them through untouched
 * (`responder-chain-provider`: natively-routed commands `return` before the
 * chain), and AppKit performs them as the `NSText` selectors against the
 * document selection (`AppDelegate.performCopy` → `NSApp.sendAction`). They
 * never enter the responder chain.
 *
 * What the chain still decides is whether the menu item is ENABLED:
 * `computeEditCapabilities` asks `chain.validateAction(COPY)`, which walks
 * from the first responder to the first node holding a handler for it
 * (`findValidationResponder`) and answers that node's `validateAction` —
 * defaulting to **true** when it declares none.
 *
 * Those two facts compose into a trap. A responder that registers one of
 * these verbs gains nothing (its handler cannot be reached by the chord or
 * the menu item) and costs something: it terminates the validation walk, so
 * the menu reports the verb as available and, if it declares no
 * `validateAction`, reports it as available unconditionally. The Edit menu
 * then offers Copy over a session chip, a terminal block, or an image
 * preview — none of which the native selector can serve — and standing
 * aside would have let the walk reach the text surface behind it, which
 * validates against a real selection.
 *
 * So: **only a surface whose content can BE the document selection may
 * register a natively-routed verb.** Everything else uses a context-menu
 * verb of its own (`COPY_COPYABLE`, `COPY_SESSION_ATOM`,
 * `COPY_ANNOTATION_VALUE`, … — the `ACTIONS_OUTSIDE_THE_TABLE` group),
 * which is menu-only by construction and never touches the Edit menu.
 *
 * The allowlist is the whole test. The natively-routed set is read from the
 * registry rather than restated here, so routing a new verb natively puts
 * it under this guard automatically.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { COMMANDS } from "../command-registry";
import { TUG_ACTIONS } from "../action-vocabulary";

/** `tugdeck/src`, walked for every authored module. */
const SRC = join(import.meta.dir, "..", "..", "..");

/**
 * The surfaces whose content IS the document selection, and may therefore
 * answer for a verb AppKit performs against that selection.
 *
 * Adding a file here is a claim that WebKit's native Cut/Copy/Paste over a
 * real selection does the right thing inside it. If that is not true of the
 * surface, it wants a context-menu verb of its own instead.
 */
const SELECTION_SURFACES: ReadonlySet<string> = new Set([
  // The transcript: prose the reader selects with the pointer.
  "components/tugways/cards/transcript-host-helpers.ts",
  // The editors and read-only text views, each over a real selection.
  "components/tugways/tug-code-view.tsx",
  "components/tugways/tug-markdown-view.tsx",
  "components/tugways/tug-text-card-editor.tsx",
  "components/tugways/tug-text-editor.tsx",
  "components/tugways/use-text-input-responder.tsx",
  // Every read-only document outside the transcript: the markdown block, the
  // About card, a diff document's files.
  "components/tugways/use-read-only-text-surface.tsx",
]);

/** Every `.ts`/`.tsx` module under `src`, excluding tests. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      sourceFiles(full, acc);
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

/** The `TUG_ACTIONS` keys whose command the registry routes natively. */
function nativelyRoutedActionKeys(): string[] {
  const nativeIds = new Set(
    COMMANDS.filter((c) => c.routing === "native").map((c) => c.id as string),
  );
  return Object.entries(TUG_ACTIONS)
    .filter(([, id]) => nativeIds.has(id as string))
    .map(([key]) => key);
}

describe("natively-routed edit verbs", () => {
  test("only selection surfaces register them as responder actions", () => {
    const keys = nativelyRoutedActionKeys();
    expect(keys.length).toBeGreaterThan(0);
    // `[TUG_ACTIONS.COPY]:` — the responder-registration shape. A menu
    // ENTRY naming the same action (`{ action: TUG_ACTIONS.COPY }`) is a
    // different shape and is not matched: dispatching a verb is fine, it is
    // answering for one that terminates the validation walk.
    const claim = new RegExp(`\\[TUG_ACTIONS\\.(?:${keys.join("|")})\\]\\s*:`);

    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (!claim.test(readFileSync(file, "utf8"))) continue;
      const rel = file.slice(SRC.length + 1);
      if (!SELECTION_SURFACES.has(rel)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  test("every allowlisted surface still claims one", () => {
    // The other direction: an entry that has stopped claiming is stale, and
    // a stale allowlist quietly re-opens the hole it was written to close.
    const keys = nativelyRoutedActionKeys();
    const claim = new RegExp(`\\[TUG_ACTIONS\\.(?:${keys.join("|")})\\]\\s*:`);
    const stale = [...SELECTION_SURFACES].filter(
      (rel) => !claim.test(readFileSync(join(SRC, rel), "utf8")),
    );
    expect(stale).toEqual([]);
  });
});
