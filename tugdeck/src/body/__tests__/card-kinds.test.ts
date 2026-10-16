/**
 * A body page registers exactly the card kinds the shell registers.
 *
 * A body is bound to whichever card the shell hands it — the warm spare
 * before anyone knows which — so a kind the shell registers and a body does
 * not is a card that mounts in the one page and in no body. Both boots call
 * the one list, `registerCardKinds` (`card-kinds.ts`), and this holds them to
 * it: each calls it, and neither registers a kind of its own beside it, which
 * is the one way the two lists could drift apart again.
 *
 * @covers tugdeck/src/card-kinds.ts
 * @covers tugdeck/src/main.tsx
 * @covers tugdeck/src/body/body-main.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..");

const BOOTS = {
  shell: join(SRC, "main.tsx"),
  body: join(SRC, "body", "body-main.ts"),
};

/** Direct `register…Card(` / `register…Cards(` calls, by name. */
function directRegistrations(source: string): string[] {
  return [...source.matchAll(/\b(register\w+Cards?)\(/g)].map((m) => m[1]);
}

describe("the card kinds every page registers", () => {
  for (const [page, path] of Object.entries(BOOTS)) {
    const source = readFileSync(path, "utf8");

    test(`the ${page}'s boot calls registerCardKinds`, () => {
      expect(source).toMatch(/\bregisterCardKinds\(/);
    });

    test(`the ${page}'s boot registers no kind of its own`, () => {
      expect(directRegistrations(source)).toEqual([]);
    });
  }

  test("the one list registers every kind the shell used to, in its order", () => {
    const list = directRegistrations(readFileSync(join(SRC, "card-kinds.ts"), "utf8"));
    expect(list).toEqual([
      "registerHelloWorldCard",
      "registerSessionCard",
      "registerAboutCard",
      "registerSettingsCard",
      "registerKeyboardCard",
      "registerDevtoolsCard",
      "registerJotsCard",
      "registerOverviewCard",
      "registerArcsCard",
      "registerCardsCard",
      "registerLayoutCard",
      "registerTextCard",
      "registerFileViewCard",
      "registerDiffCard",
      "registerCommitCard",
      "registerGalleryCards",
      "registerSpikeCards",
      "registerFixtureCards",
    ]);
  });
});
