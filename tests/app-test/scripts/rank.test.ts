/**
 * rank.test.ts — the rank tuple, one axis at a time.
 *
 * Each case holds every earlier axis equal and varies the next, so a broken axis fails
 * the case that names it rather than some later one.
 *
 * This is a pure-logic test (no app launch); it lives beside the script it covers and is
 * invisible to `testFiles()`, which only scans the corpus root and `harness-smoke/`.
 */

import { describe, expect, test } from "bun:test";
import { lostOn, rank, reasonFor, reportLine, type RankInput } from "./rank";

function input(file: string, over: Partial<RankInput> = {}): RankInput {
    return {
        file,
        because: ["a.ts"],
        reach: 0,
        negative: false,
        reachNote: "textual: no mention",
        recentRed: 0,
        history: "last green",
        lastSecs: 10,
        ...over,
    };
}

const order = (inputs: RankInput[]) => rank(inputs).map((r) => r.file);

describe("rank", () => {
    test("reach decides first", () => {
        expect(order([
            input("a", { reach: 0, because: ["x", "y"], recentRed: 5, lastSecs: 1 }),
            input("b", { reach: 2 }),
        ])).toEqual(["b", "a"]);
    });

    test("at equal reach, a negative map sorts after no map", () => {
        expect(order([
            input("a", { negative: true, because: ["x", "y"] }),
            input("b", { negative: false }),
        ])).toEqual(["b", "a"]);
    });

    test("then more changed files declared", () => {
        expect(order([
            input("a", { recentRed: 3 }),
            input("b", { because: ["x", "y"] }),
        ])).toEqual(["b", "a"]);
    });

    test("then the longer red streak", () => {
        expect(order([
            input("a", { recentRed: 1, lastSecs: 1 }),
            input("b", { recentRed: 2, lastSecs: 99 }),
        ])).toEqual(["b", "a"]);
    });

    test("then the cheaper file, with unknown seconds last", () => {
        expect(order([
            input("a", { lastSecs: null }),
            input("b", { lastSecs: 30 }),
            input("c", { lastSecs: 5 }),
        ])).toEqual(["c", "b", "a"]);
    });

    test("filename is the final key", () => {
        expect(order([input("c"), input("a"), input("b")])).toEqual(["a", "b", "c"]);
    });

    test("ranks are 1-based and the input is untouched", () => {
        const inputs = [input("b"), input("a")];
        const ranked = rank(inputs);
        expect(ranked.map((r) => r.rank)).toEqual([1, 2]);
        expect(inputs.map((i) => i.file)).toEqual(["b", "a"]);
    });
});

describe("lostOn", () => {
    const last = input("m", { reach: 1, because: ["x", "y"], recentRed: 1, lastSecs: 10 });
    test("names the first axis that put the excluded test behind the last one in", () => {
        expect(lostOn(input("z", { reach: 0 }), last)).toBe("reach");
        expect(lostOn(input("z", { reach: 1, negative: true }), last)).toBe("negative map");
        expect(lostOn(input("z", { reach: 1 }), last)).toBe("changed files");
        expect(lostOn(input("z", { reach: 1, because: ["x", "y"] }), last)).toBe("red streak");
        expect(lostOn(input("z", { reach: 1, because: ["x", "y"], recentRed: 1, lastSecs: null }), last)).toBe("seconds");
        expect(lostOn(input("z", { reach: 1, because: ["x", "y"], recentRed: 1 }), last)).toBe("name");
    });
});

describe("reasonFor", () => {
    test("a line below the cut names the axis it lost on", () => {
        const [first] = rank([input("a")]);
        expect(reportLine(first, 3)).toBe("   1. a    reaches 0 [textual: no mention] · 1 changed file · last green · 10s");
        expect(reportLine(first, 3, "seconds")).toBe(
            "   1. a    reaches 0 [textual: no mention] · 1 changed file · last green · 10s · lost on seconds",
        );
    });

    test("names reach, files, history and seconds", () => {
        expect(reasonFor(input("a", {
            reach: 1,
            reachNote: "textual: popFocusMode, caller of mayRestoreFirstResponder",
        }))).toBe(
            "reaches 1 [textual: popFocusMode, caller of mayRestoreFirstResponder] · 1 changed file · last green · 10s",
        );
        expect(reasonFor(input("a", { because: ["x", "y"], history: "red-streak (2)", lastSecs: null })))
            .toBe("reaches 0 [textual: no mention] · 2 changed files · red-streak (2) · ?s");
    });
});
