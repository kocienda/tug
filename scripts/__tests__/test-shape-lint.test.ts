/**
 * test-shape-lint over fixture strings: every shape each rule must refuse is a
 * finding under that rule, and every neighbouring shape it must pass is not.
 */
import { describe, expect, test } from "bun:test";
import { lintJustfile, lintText, rustTestRegions } from "../test-shape-lint";

const TS = "tugdeck/src/lib/__tests__/demo.test.ts";
const RS_SRC = "tugrust/crates/demo/src/lib.rs";
const RS_TESTS = "tugrust/crates/demo/tests/it.rs";

/** The rule ids found in a TS fixture. */
function ts(text: string): string[] {
  return lintText(TS, text).map((f) => f.rule);
}

/** The rule ids found in a Rust fixture, wrapped in a test module. */
function rsTest(body: string): string[] {
  return lintText(RS_SRC, `pub fn product() {}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n${body}\n}\n`).map(
    (f) => f.rule,
  );
}

/** The rule ids found in a Rust fixture outside any test module. */
function rsProduct(body: string): string[] {
  return lintText(RS_SRC, body).map((f) => f.rule);
}

describe("T1 duration comparison", () => {
  test("refuses a clock difference compared to a bound, directly or through an identifier", () => {
    expect(ts("const start = performance.now();\nconst elapsed = performance.now() - start;\nexpect(elapsed).toBeLessThan(1);")).toEqual(["T1"]);
    expect(ts("const started = Date.now();\nexpect(Date.now() - started).toBeLessThan(5_000);")).toEqual(["T1"]);
    expect(
      ts(
        "let fullLexMs = 0;\nlet tailLexMs = 0;\nfullLexMs += performance.now() - fullStart;\ntailLexMs += performance.now() - tailStart;\nexpect(tailLexMs * 5).toBeLessThan(fullLexMs);",
      ),
    ).toEqual(["T1"]);
    expect(
      ts(
        "const lags: number[] = [];\nconst now = performance.timeOrigin + performance.now();\nlags.push(now - x);\nexpect(Math.max(...lags)).toBeLessThan(PAGE_MS * 4);",
      ),
    ).toEqual(["T1"]);
    expect(
      ts("let allocMs = 0;\nlet restMs = 0;\nrestMs += performance.now() - started - kindAllocMs;\nexpect(allocMs / restMs).toBeLessThan(4);"),
    ).toEqual(["T1"]);
  });

  test("passes an ordering against a bare timestamp, constants, and series with no clock", () => {
    expect(ts("expect(note.createdAt).toBeLessThanOrEqual(Date.now());")).toEqual([]);
    expect(ts("const queuedAt = Date.now();\nexpect(Date.now()).toBeGreaterThan(queuedAt);")).toEqual([]);
    expect(ts("expect(ARRIVAL_REVEAL_BOUND_MS).toBeLessThan(1000);")).toEqual([]);
    expect(ts("expect(reading.longestGapMs / reading.framePeriodMs).toBeGreaterThan(9);")).toEqual([]);
  });

  test("a property of the same name is not the clock-derived identifier", () => {
    expect(ts("const elapsed = performance.now() - start;\nexpect(report.elapsed).toBeLessThan(3);")).toEqual([]);
  });
});

describe("T2 per-test timeout", () => {
  test("refuses setDefaultTimeout and a timeout argument closing a test or hook", () => {
    expect(ts('import { setDefaultTimeout } from "bun:test";\nsetDefaultTimeout(30_000);')).toEqual(["T2"]);
    expect(ts('  test("x", async () => {\n    await go();\n  }, 120_000);')).toEqual(["T2"]);
    expect(ts('test("x", async () => {\n  await go();\n}, { timeout: 5000 });')).toEqual(["T2"]);
    expect(ts("beforeAll(async () => {\n  server = await start();\n}, BUILD_TIMEOUT_MS);")).toEqual(["T2"]);
    expect(ts('  test("x", async () => {\n    await go();\n  }, CATALOG_WAIT_MS + 2000);')).toEqual(["T2"]);
  });

  test("passes a timer's delay and a call's numeric argument", () => {
    expect(ts('test("x", async () => {\n  setTimeout(() => {\n    done();\n  }, 0);\n});')).toEqual([]);
    expect(ts("applyReport({ kind: 1 }, 1000);")).toEqual([]);
  });

  test("reads a .tsx test file as TypeScript", () => {
    expect(lintText("tugdeck/src/__tests__/demo.test.tsx", "setDefaultTimeout(30_000);").map((f) => f.rule)).toEqual(["T2"]);
  });
});

describe("S1 login or interactive shell", () => {
  test("refuses a TS spawn of a login shell and a Rust login flag in a test module", () => {
    expect(ts('Bun.spawnSync(["/bin/zsh", "-il"], { env: { PATH: "/usr/bin:/bin", HOME: tmp } });')).toEqual(["S1"]);
    expect(rsTest('    fn t() { let mut cmd = Command::new(shell_path); cmd.arg("-il"); }')).toEqual(["S1"]);
  });

  test("passes the flag in product code and a non-login `-c`", () => {
    expect(rsProduct('fn spawn() { let mut cmd = Command::new(&shell); cmd.arg("-il"); }')).toEqual([]);
    expect(ts('Bun.spawnSync(["bash", "-c", "true"], { env: { PATH: "/usr/bin:/bin", HOME: tmp } });')).toEqual([]);
  });
});

describe("S2 shell spawn without a scrubbed env", () => {
  test("refuses a shell spawned with the inherited environment", () => {
    expect(ts('Bun.spawnSync(["bash", RUN_CAPPED, "1"], { env: { ...process.env, X: "1" } });')).toEqual(["S2"]);
    expect(ts('Bun.spawnSync(\n  ["bash", RUN_CAPPED, "1"],\n  { stdout: "pipe" },\n);')).toEqual(["S2"]);
    expect(rsTest('    fn t() { let out = Command::new("/bin/sh").arg("-c").arg("true").output(); }')).toEqual(["S2"]);
    expect(
      rsTest('    fn t() { let shell = std::env::var("SHELL").unwrap(); let out = Command::new(&shell).arg("-c").output(); }'),
    ).toEqual(["S2"]);
  });

  test("passes an explicit env, a cleared one, and a program that is not a shell", () => {
    expect(ts('Bun.spawnSync(["bash", RUN_CAPPED], { env: { PATH, HOME: tmp } });')).toEqual([]);
    expect(rsTest('    fn t() { let out = Command::new("sh").env_clear().env("HOME", home).arg("-c").output(); }')).toEqual([]);
    expect(rsTest("    fn t() { let out = Command::new(bin).arg(\"--help\").output(); }")).toEqual([]);
  });
});

describe("S3 login-shell door", () => {
  test("refuses a door call in a test module", () => {
    expect(rsTest("    fn t() { let words = dump_shell_words(None); }")).toEqual(["S3"]);
  });

  test("passes the call in product code, its definition, and an exempted call", () => {
    expect(rsProduct("fn refresh() { let words = dump_shell_words(None); }")).toEqual([]);
    expect(rsTest("    pub fn dump_shell_words(cwd: Option<&Path>) {}")).toEqual([]);
    expect(
      rsTest(
        '    fn t() {\n        // shape-lint: no-spawn — an unsafe name is refused before $SHELL is read\n        assert_eq!(fetch_function_body("x; echo pwned"), None);\n    }',
      ),
    ).toEqual([]);
  });
});

describe("S4 SHELL set to a real shell", () => {
  test("refuses SHELL pointed at a real shell in a test module", () => {
    expect(rsTest('    fn t() { unsafe { std::env::set_var("SHELL", "/bin/zsh"); } }')).toEqual(["S4"]);
  });

  test("passes a non-shell, and the same call in product code", () => {
    expect(rsTest('    fn t() { unsafe { std::env::set_var("SHELL", "/usr/bin/false"); } }')).toEqual([]);
    expect(rsProduct('fn f() { unsafe { std::env::set_var("SHELL", "/bin/zsh"); } }')).toEqual([]);
  });
});

describe("R1 elapsed assert", () => {
  test("refuses an assert over `.elapsed()`, on one line or many", () => {
    expect(rsTest("    fn t() { assert!(opened_at.elapsed() >= REPLAY_BRACKET_DEADLINE); }")).toEqual(["R1"]);
    expect(rsTest('    fn t() {\n        assert!(\n            before.elapsed() < POST_EVERY,\n            "slow"\n        );\n    }')).toEqual(["R1"]);
    expect(rsTest("    fn t() { assert!(started.elapsed() < Duration::from_secs(2)); }").sort()).toEqual(["R1", "R2"]);
  });

  test("passes an elapsed read in product code and one with no assert", () => {
    expect(rsProduct("fn f() { if cache.last_check.elapsed() < THROTTLE { return; } }")).toEqual([]);
    expect(rsTest("    fn t() { let warm_ms = started.elapsed().as_millis(); }")).toEqual([]);
  });
});

describe("R2 duration-bound assert", () => {
  test("refuses a comparison against a Duration bound", () => {
    expect(rsTest('    fn t() { assert!(took < Duration::from_secs(2), "{took:?}"); }')).toEqual(["R2"]);
    expect(rsTest("    fn t() { assert!(lease.age < Duration::from_secs(60)); }")).toEqual(["R2"]);
    expect(rsTest("    fn t() { assert!(pair[1].0 - pair[0].0 >= Duration::from_millis(50)); }")).toEqual(["R2"]);
    expect(rsTest("    fn t() { assert!(took < std::time::Duration::from_millis(250)); }")).toEqual(["R2"]);
    expect(lintText(RS_TESTS, "fn t() { assert!(took >= Duration::from_millis(500)); }").map((f) => f.rule)).toEqual(["R2"]);
  });

  test("passes a Duration that is added, or passed as an argument", () => {
    expect(rsTest("    fn t() { assert!(!liveness.is_stale(t0 + Duration::from_secs(179))); }")).toEqual([]);
    expect(rsTest('    fn t() { assert!(reg.card_live_or_recent("c1", Duration::from_secs(60))); }')).toEqual([]);
  });
});

describe("J1 bun run without the guard", () => {
  const rules = (line: string) => lintJustfile(`recipe:\n    ${line}\n`).map((f) => f.rule);

  test("refuses a `bun test` with a literal, a shell variable, or no timeout", () => {
    expect(rules("cd tugplug && bun test --timeout 60000 __tests__/")).toEqual(["J1"]);
    expect(rules('suite tugdeck tugdeck bun test --timeout "$BUN_TIMEOUT"')).toEqual(["J1"]);
    expect(rules("cd tugdeck && bun test src/lib/__tests__/card-plan.test.ts")).toEqual(["J1"]);
  });

  test("passes the guard variable, a comment, and `bun test` inside a label", () => {
    expect(rules("cd tugdeck && bun test --timeout {{BUN_HANG_GUARD_MS}} ./full-lane")).toEqual([]);
    expect(rules("# `bun test` alone uses the 5 s default")).toEqual([]);
    expect(rules('"$TUGTOOL_BIN" test run --label "bun test · $name" --needle "bun test" -- "$@"')).toEqual([]);
  });
});

describe("the exemption comment", () => {
  test("exempts the line below it from the rules its reason names, and nothing else", () => {
    const paused =
      "    fn t() {\n        // shape-lint: paused-clock — tokio's virtual clock, not the machine's\n        assert!(a[1].0 - a[0].0 >= Duration::from_millis(50));\n    }";
    expect(rsTest(paused)).toEqual([]);
    // no-spawn names S3 only, so a duration bound under it still refuses.
    const wrongReason =
      "    fn t() {\n        // shape-lint: no-spawn — not a door\n        assert!(took < Duration::from_secs(2));\n    }";
    expect(rsTest(wrongReason)).toEqual(["R2"]);
    // One comment covers one line.
    const twoCalls =
      "    fn t() {\n        // shape-lint: no-spawn — refused before a spawn\n        assert_eq!(dump_shell_words(None), None);\n        assert_eq!(fetch_function_body(\"a\"), None);\n    }";
    expect(rsTest(twoCalls)).toEqual(["S3"]);
  });

  test("exempts a TypeScript line the same way, and counts what it exempted", () => {
    const exempted = { count: 0 };
    const text = "// shape-lint: no-spawn — a reason S3 knows\nconst x = 1;\n";
    expect(lintText(TS, text, { exempted })).toEqual([]);
    const counted = { count: 0 };
    lintText(
      RS_SRC,
      "#[cfg(test)]\nmod tests {\n    fn t() {\n        // shape-lint: paused-clock — virtual clock\n        assert!(d >= Duration::from_millis(5));\n    }\n}\n",
      { exempted: counted },
    );
    expect(counted.count).toBe(1);
    expect(exempted.count).toBe(0);
  });
});

describe("the Rust test region", () => {
  const SOURCE = [
    "pub fn product() {", // 1
    '    let s = "{";', // 2
    "}", // 3
    "", // 4
    "#[cfg(test)]", // 5
    "fn helper() {", // 6
    "    assert!(took < Duration::from_secs(1));", // 7: a lone item, not a region
    "}", // 8
    "", // 9
    "#[cfg(all(test, debug_assertions))]", // 10
    "#[allow(clippy::unwrap_used)]", // 11
    "mod tests {", // 12
    "    fn t() {", // 13
    "        let brace = '{';", // 14
    '        let s = "}}";', // 15
    "        assert!(took < Duration::from_secs(1));", // 16: in the region
    "    }", // 17
    "}", // 18
    "", // 19
    "fn after() { assert!(took < Duration::from_secs(1)); }", // 20: past the region's close
  ].join("\n");

  test("a lone #[cfg(test)] item is not a region; a module under cfg(all(test, …)) is, to its closing brace", () => {
    expect(lintText(RS_SRC, SOURCE).map((f) => f.line)).toEqual([16]);
    const regions = rustTestRegions(SOURCE);
    expect(regions).toHaveLength(1);
    expect(SOURCE.slice(regions[0].start, regions[0].end + 1).trimEnd().endsWith("}")).toBe(true);
    expect(SOURCE.slice(regions[0].end + 1)).toContain("fn after()");
  });

  test("a crate's tests/ file is test code whole, and a source file with no test module has none", () => {
    expect(lintText(RS_TESTS, "fn t() { assert!(took < Duration::from_secs(1)); }")).toHaveLength(1);
    expect(lintText(RS_SRC, "fn t() { assert!(took < Duration::from_secs(1)); }")).toEqual([]);
  });

  test("an out-of-line test module is reported by name", () => {
    const names: string[] = [];
    expect(rustTestRegions("#[cfg(test)]\nmod tests;\n", names)).toEqual([]);
    expect(names).toEqual(["tests"]);
  });
});
