/**
 * recipe-lint over a fixture Justfile: the check refuses a long recipe that
 * reports nothing, and passes one that reports itself, through a dependency,
 * through a `just` it runs, or through a script it calls.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lintRecipes, parseRecipes } from "../recipe-lint";

const FIXTURE = `
# a comment: not a recipe
version := "1.2.3"

silent:
    #!/usr/bin/env bash
    set -euo pipefail
    cargo build --release

phased:
    @bash tugrust/scripts/report-phase.sh phased 0 "compile" --of "compile" "link"
    cargo build
    @bash tugrust/scripts/report-phase.sh phased 2

unit-reporting:
    printf '[]' | tugtool progress --label x --unit file --units-json - -- running

wrapped:
    "$TUGTOOL_BIN" test run --suite rust --kind nextest -- cargo nextest run

via-dep: phased
    echo done

via-just:
    just phased

via-script:
    tugrust/scripts/reporting.sh --flag

via-silent-script:
    scripts/quiet.sh

old-band:
    @tugtool progress --label swift --needle "just test" -- running
    xcodebuild test

defaulted seed="" batches="20": phased
    echo "{{seed}} {{batches}}"
`;

const SCRIPTS: Record<string, string> = {
  "tugrust/scripts/reporting.sh": '#!/usr/bin/env bash\nbash "$HERE/report-phase.sh" dmg 0 "inputs"\n',
  "scripts/quiet.sh": "#!/usr/bin/env bash\necho nothing\n",
};
const readScript = (path: string) => SCRIPTS[path] ?? null;

describe("recipe-lint", () => {
  test("parses headers, dependencies and bodies", () => {
    const recipes = parseRecipes(FIXTURE);
    expect(recipes.has("version")).toBe(false);
    expect(recipes.get("via-dep")?.deps).toEqual(["phased"]);
    expect(recipes.get("defaulted")?.deps).toEqual(["phased"]);
    expect(recipes.get("silent")?.body).toContain("cargo build --release");
    expect(recipes.get("phased")?.body).not.toContain("unit-reporting");
  });

  test("refuses a long recipe that reports nothing", () => {
    const failures = lintRecipes(FIXTURE, { listed: ["silent"], exempt: {}, readScript });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("`silent` runs long and reports no unit");
  });

  test("the old one-line report, with no unit, is not a report", () => {
    const failures = lintRecipes(FIXTURE, { listed: ["old-band"], exempt: {}, readScript });
    expect(failures).toHaveLength(1);
  });

  test("passes a recipe that reports itself or through what it runs", () => {
    const listed = ["phased", "unit-reporting", "wrapped", "via-dep", "via-just", "via-script"];
    expect(lintRecipes(FIXTURE, { listed, exempt: {}, readScript })).toEqual([]);
  });

  test("a script that reports nothing is no delegation", () => {
    const failures = lintRecipes(FIXTURE, { listed: ["via-silent-script"], exempt: {}, readScript });
    expect(failures).toHaveLength(1);
  });

  test("an exemption with a reason passes, and one with no recipe is refused", () => {
    expect(
      lintRecipes(FIXTURE, { listed: ["silent"], exempt: { silent: "a fixture" }, readScript }),
    ).toEqual([]);
    const failures = lintRecipes(FIXTURE, { listed: [], exempt: { silent: "a fixture" }, readScript });
    expect(failures[0]).toContain("exempt but not listed");
  });

  test("a listed recipe the Justfile lacks is refused", () => {
    const failures = lintRecipes(FIXTURE, { listed: ["gone"], exempt: {}, readScript });
    expect(failures[0]).toContain("no such recipe");
  });

  test("the repository's own Justfile passes", () => {
    const justfile = readFileSync(join(import.meta.dir, "..", "..", "Justfile"), "utf8");
    expect(lintRecipes(justfile)).toEqual([]);
  });
});
