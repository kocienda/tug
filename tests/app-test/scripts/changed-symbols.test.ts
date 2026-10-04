/**
 * changed-symbols.test.ts — hunks resolve to the named functions they fall inside.
 *
 * Each case writes fixture sources into a throwaway git repo, commits them, edits the working
 * tree, and asks `changedSymbols` what changed. The diff under test is a real `git diff -U0
 * HEAD`, because the resolver's whole job is reading one.
 *
 * This is a pure-logic test (no app launch); it lives beside the script it covers and is
 * invisible to `testFiles()`, which only scans the corpus root and `harness-smoke/`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { changedSymbols, describeChanged, mentionSet, reachOf, symbolIndex, type ChangedFile, type MentionSet } from "./changed-symbols";

const TS_FIXTURE = `import { x } from "./x";
export const LIMIT = 3;
export function alpha(n: number): number {
    return n + LIMIT + x;
}
export class Widget {
    private count = 0;
    bump(): void {
        this.count += 1;
    }
    get size(): number {
        return this.count;
    }
    handler = () => {
        [1, 2].forEach((v) => {
            this.count += v;
        });
    };
}
export const beta = (s: string) => {
    return s.length;
};
`;

const RS_FIXTURE = `use std::fmt;

pub struct Thing { n: u32 }

impl Thing {
    pub fn new() -> Self {
        Thing { n: 0 }
    }
    fn bump(&mut self) {
        let s = "}";
        self.n += 1;
    }
}

impl fmt::Display for Thing {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.n)
    }
}

trait T { fn sig(&self); }

fn free<'a>(x: &'a str) -> char { let _ = x; '{' }
`;

const SWIFT_FIXTURE = `import Foundation

final class Engine {
    var speed = 0
    init(speed: Int) {
        self.speed = speed
    }
    func rev() {
        let s = "{"
        speed += 1
    }
}

extension Engine {
    func stop() {
        speed = 0
    }
}

protocol Runner {
    func run()
}

func helper() -> Int { return 1 }
`;

let repo: string;

function git(...args: string[]): void {
    const proc = Bun.spawnSync(
        ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
        { cwd: repo, stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
}

function write(rel: string, text: string): void {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
}

/** Replace exactly one occurrence of `from` in a working-tree file. */
function edit(rel: string, from: string, to: string): void {
    const text = readFileSync(join(repo, rel), "utf8");
    expect(text.split(from).length).toBe(2);
    writeFileSync(join(repo, rel), text.replace(from, to));
}

beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "changed-symbols-"));
    git("init", "-q");
    write("src/fixture.ts", TS_FIXTURE);
    write("src/thing.rs", RS_FIXTURE);
    write("src/Engine.swift", SWIFT_FIXTURE);
    write("src/style.css", "a { color: red; }\n");
    write("tugdeck/src/m.ts", [
        "export function target(): number { return 1; }",
        "export function caller(): number { return target() + 1; }",
        "export function other(): number { return 2; }",
        "",
    ].join("\n"));
    write("tugdeck/src/test-surface.ts", [
        "export function createTugTestSurface() {",
        "    return {",
        "        pokeCaller() { return caller(); },",
        "        idle() { return 0; },",
        "    };",
        "}",
        "",
    ].join("\n"));
    git("add", "-A");
    git("commit", "-q", "-m", "fixtures");
});

afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
});

describe("symbolIndex", () => {
    test("names every TS function-like per the one rule", () => {
        const names = symbolIndex("f.ts", TS_FIXTURE).spans.map((s) => s.name);
        expect(names).toEqual(["alpha", "Widget.bump", "Widget.size", "Widget.handler", "beta"]);
    });

    test("bodiless nodes are not symbols; a getter and setter share a name", () => {
        const text = [
            "export function over(a: string): void;",
            "export function over(a: number): void;",
            "export function over(a: unknown): void { void a; }",
            "declare function ambient(): void;",
            "abstract class Base {",
            "    abstract step(): void;",
            "    get v(): number { return 1; }",
            "    set v(n: number) { void n; }",
            "}",
            "const api = { go() { return 1; }, run: () => 2, n: 3 };",
            "function make() { return { made() { return 1; } }; }",
            "",
        ].join("\n");
        const names = symbolIndex("f.ts", text).spans.map((s) => s.name);
        expect(names).toEqual(["over", "Base.v", "Base.v", "api.go", "api.run", "make", "make.made"]);
    });

    test("the Rust scanner prefixes impl types and skips signatures, strings and char literals", () => {
        const ix = symbolIndex("thing.rs", RS_FIXTURE);
        expect(ix.failed).toBeUndefined();
        expect(ix.spans.map((s) => s.name)).toEqual(["Thing.new", "Thing.bump", "Thing.fmt", "free"]);
    });

    test("the Swift scanner prefixes types and extensions and skips requirements", () => {
        const ix = symbolIndex("Engine.swift", SWIFT_FIXTURE);
        expect(ix.failed).toBeUndefined();
        expect(ix.spans.map((s) => s.name)).toEqual(["Engine.init", "Engine.rev", "Engine.stop", "helper"]);
    });

    test("an unbalanced scan fails to module scope rather than guessing", () => {
        const ix = symbolIndex("bad.rs", "fn a() { {\n");
        expect(ix.failed).toBe(true);
        expect(ix.spans).toEqual([]);
    });
});

describe("changedSymbols", () => {
    test("TS: hunks inside functions name them; an inline callback names its owner", () => {
        edit("src/fixture.ts", "return n + LIMIT + x;", "return n + LIMIT + x + 1;");
        edit("src/fixture.ts", "this.count += 1;", "this.count += 2;");
        edit("src/fixture.ts", "this.count += v;", "this.count += v * 2;");
        edit("src/fixture.ts", "return s.length;", "return s.length + 1;");
        const [f] = changedSymbols(["src/fixture.ts"], repo);
        expect(f.symbols).toEqual(["alpha", "Widget.bump", "Widget.handler", "beta"]);
        expect(f.moduleScope).toBe(false);

        edit("src/fixture.ts", "export const LIMIT = 3;", "export const LIMIT = 4;");
        const [g] = changedSymbols(["src/fixture.ts"], repo);
        expect(g.symbols).toEqual(["alpha", "Widget.bump", "Widget.handler", "beta"]);
        expect(g.moduleScope).toBe(true);
    });

    test("an untracked file changes every symbol it has", () => {
        write("src/fresh.ts", "export function one() { return 1; }\nexport const two = () => 2;\n");
        const [f] = changedSymbols(["src/fresh.ts"], repo);
        expect(f.symbols).toEqual(["one", "two"]);
        expect(f.moduleScope).toBe(false);
    });

    test("Rust: hunks resolve through impl blocks", () => {
        edit("src/thing.rs", "self.n += 1;", "self.n += 2;");
        edit("src/thing.rs", 'write!(f, "{}", self.n)', 'write!(f, "<{}>", self.n)');
        const [f] = changedSymbols(["src/thing.rs"], repo);
        expect(f.symbols).toEqual(["Thing.bump", "Thing.fmt"]);
        expect(f.moduleScope).toBe(false);
    });

    test("Swift: hunks resolve through types and extensions", () => {
        edit("src/Engine.swift", "speed += 1", "speed += 2");
        edit("src/Engine.swift", "speed = 0\n    }\n}", "speed = -1\n    }\n}");
        const [f] = changedSymbols(["src/Engine.swift"], repo);
        expect(f.symbols).toEqual(["Engine.rev", "Engine.stop"]);
        expect(f.moduleScope).toBe(false);
    });

    test("a file with no symbol data says why", () => {
        edit("src/style.css", "red", "blue");
        const [f] = changedSymbols(["src/style.css"], repo);
        expect(f.symbols).toEqual([]);
        expect(f.moduleScope).toBe(false);
        expect(f.reason).toBe("no symbol data for .css");
    });
});

describe("mentionSet", () => {
    test("the symbol, its in-module caller, and the surface verb that reaches the caller", () => {
        edit("tugdeck/src/m.ts", "{ return 1; }", "{ return 10; }");
        const changed = changedSymbols(["tugdeck/src/m.ts"], repo);
        expect(changed[0].symbols).toEqual(["target"]);
        const sets = mentionSet(changed, repo);
        expect(sets).toHaveLength(1);
        expect(sets[0].members).toEqual([
            { name: "target", word: "target", role: "symbol" },
            { name: "caller", word: "caller", role: "caller" },
            { name: "createTugTestSurface.pokeCaller", word: "pokeCaller", role: "surface verb" },
        ]);
        expect(describeChanged(changed[0], sets)).toBe(
            "tugdeck/src/m.ts → target (+ callers caller) (+ surface verbs createTugTestSurface.pokeCaller)",
        );
    });
});

describe("reachOf", () => {
    const file: ChangedFile = { path: "tugdeck/src/m.ts", symbols: ["target"], moduleScope: true };
    const sets: MentionSet[] = [
        { path: "tugdeck/src/m.ts", symbol: "target", members: [{ name: "target", word: "target", role: "symbol" }] },
    ];
    const ruledOut = { map: { "tugdeck/src/m.ts": { n: 2, hit: ["other"] } }, textAtHead: () => "function target() {}" };

    test("a module-scope credit does not cancel a map that ruled the symbol out", () => {
        const r = reachOf("no mention here", [file], sets, ruledOut);
        expect(r).toEqual({ reach: 1, negative: true, note: "negative; module scope" });
    });

    test("a symbol reached clears negative", () => {
        const r = reachOf("calls target()", [{ ...file, moduleScope: false }], sets, {
            map: { "tugdeck/src/m.ts": { n: 2, hit: ["target"] } },
            textAtHead: () => "function target() {}",
        });
        expect(r).toEqual({ reach: 1, negative: false, note: "measured: target" });
    });
});
