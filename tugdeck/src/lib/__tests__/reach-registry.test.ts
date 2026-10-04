import { describe, expect, test } from "bun:test";
import { __tugReachRegister, dump, reset } from "../reach-registry";

describe("reach-registry", () => {
    test("dump reports each module's distinct names and the ones that ran", () => {
        const a = __tugReachRegister("tugdeck/src/a.ts", ["alpha", "Widget.v", "Widget.v", "beta"]);
        const b = __tugReachRegister("tugdeck/src/b.ts", ["gamma", "delta"]);
        a[2] = 1; // the setter of Widget.v
        b[0] = 1;
        expect(dump()).toEqual({
            "tugdeck/src/a.ts": { n: 3, hit: ["Widget.v"] },
            "tugdeck/src/b.ts": { n: 2, hit: ["gamma"] },
        });
    });

    test("reset clears every hit and keeps the registrations", () => {
        reset();
        expect(dump()).toEqual({
            "tugdeck/src/a.ts": { n: 3, hit: [] },
            "tugdeck/src/b.ts": { n: 2, hit: [] },
        });
    });
});
