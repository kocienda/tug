/**
 * at0606-dom-fault-forensics.test.ts — a DOM fault names the node and lands
 * on disk.
 *
 * ## The failure this pins
 *
 * On 2026-09-21 the app died repeatedly with WebKit's `NotFoundError: The
 * object can not be found here.` thrown from `removeChild` inside React's
 * deletion walk. Every occurrence produced the same evidence: a red banner
 * and thirty frames of minified React recursion — `Zs@vendor.js:8:99094`,
 * `Fl@vendor.js:8:98536` — naming no component, no element, and no
 * feature. The defect was eventually found by reading source. Nothing in
 * the app had recorded what it was doing when it died, and the user's
 * response to the banner (Reload) destroyed what little was in memory.
 *
 * The hardening is `lib/dom-forensics.ts`: the three throwing DOM mutators
 * are wrapped so a fault carries the parent, the child, and — the fact
 * that actually diagnoses it — **where the child actually went**, then
 * POSTs the report to `/api/client-fault`, which appends it to
 * `<instance>/Logs/client-faults.jsonl`.
 *
 * This test is the guard on that hardening. It exists so that the next
 * time this class of fault happens, the evidence is already there.
 *
 * ## Shape
 *
 *   1. Launch the app and wait for the forensics surface to be installed.
 *      (`window.__domForensics` is published by `installDomForensics()` at
 *      the top of `main.tsx`, before any card mounts.)
 *   2. Leave a breadcrumb, then provoke a REAL `NotFoundError`: build a
 *      parent and a child, reparent the child elsewhere, and ask the
 *      original parent to remove it. This is the exact tree shape that
 *      produced the 2026-09-21 crash — a node React still believes it owns
 *      living somewhere else.
 *   3. Assert the throw still happened. The wrapper must be transparent:
 *      capturing a fault must never swallow it, because swallowing turns
 *      a loud bug into a silent one.
 *   4. Assert the in-memory report names the parent (by `data-slot`), the
 *      child, the method, and the child's ACTUAL parent — "detached" vs.
 *      "reparented" being two different bugs that throw the same message.
 *   5. Assert the breadcrumb rode along, which is what lets a fault point
 *      back at the mutation that caused it one commit earlier.
 *   6. Assert the record reached `Logs/client-faults.jsonl` on disk, and
 *      that the line parses as JSON on its own. This is the assertion that
 *      matters most: in-memory evidence dies with the Reload.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/dom-forensics.ts
 * @covers tugdeck/src/main.tsx
 * @covers tugdeck/src/components/chrome/error-boundary.tsx
 * @covers tugrust/crates/tugcast/src/client_fault.rs
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** A marker unique to this run, so the on-disk assertion cannot match an
 *  older record left by a previous test or a previous launch. */
const MARKER = `at0606-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** What the provoking script hands back. */
interface Provoked {
  /** Whether `removeChild` still threw. It must. */
  threw: boolean;
  /** The message it threw with. */
  message: string;
  /** The last forensic report the module recorded. */
  report: {
    kind: string;
    method: string;
    message: string;
    parent: { name: string; dataset?: Record<string, string> } | null;
    child: { name: string; dataset?: Record<string, string> } | null;
    childActualParent:
      | { name: string; dataset?: Record<string, string> }
      | "detached"
      | null;
    parentContainsChild: boolean | null;
    breadcrumbs: { channel: string; detail: Record<string, unknown> }[];
  } | null;
}

/**
 * Build the fault, in the browser, and hand back both what happened and
 * what the forensics recorded.
 *
 * The script is one expression because `waitForCondition` polls an
 * expression and returns its truthy value — an IIFE is how a multi-step
 * setup fits that contract.
 */
const PROVOKE_SCRIPT = `(() => {
  const f = window.__domForensics;
  if (!f) return null;
  f.breadcrumb("at0606.probe", { marker: ${JSON.stringify(MARKER)} });
  const parent = document.createElement("div");
  parent.setAttribute("data-slot", "at0606-parent");
  const elsewhere = document.createElement("div");
  elsewhere.setAttribute("data-slot", "at0606-elsewhere");
  const child = document.createElement("span");
  child.setAttribute("data-slot", "at0606-child");
  child.setAttribute("data-marker", ${JSON.stringify(MARKER)});
  parent.appendChild(child);
  document.body.appendChild(parent);
  document.body.appendChild(elsewhere);
  // The 2026-09-21 tree shape: the child is no longer where its former
  // parent believes it is.
  elsewhere.appendChild(child);
  let threw = false;
  let message = "";
  try {
    parent.removeChild(child);
  } catch (err) {
    threw = true;
    message = err && err.message ? err.message : String(err);
  }
  parent.remove();
  elsewhere.remove();
  const report = f.faults.length > 0 ? f.faults[f.faults.length - 1] : null;
  return { threw, message, report };
})()`;

describe.skipIf(!SHOULD_RUN)("AT0606: a DOM fault names the node and is durable", () => {
  test(
    "removeChild on a reparented node reports the node and reaches the fault log",
    async () => {
      const app = await launchTugApp({
        testName: "at0606-dom-fault-forensics",
        // Only `waitForCondition` is used here — no native gesture, so the
        // Accessibility preflight has nothing to protect and would only
        // couple this test to a TCC grant that goes stale on every re-sign.
        skipAccessibilityPreflight: true,
      });

      try {
        // The forensics surface is installed at the top of `main.tsx`, so
        // waiting for it also proves the install runs before anything else
        // has a chance to fault.
        await app.waitForCondition<boolean>(
          `typeof window.__domForensics !== "undefined"`,
          { timeoutMs: 30_000 },
        );

        const provoked = await app.waitForCondition<Provoked>(PROVOKE_SCRIPT, {
          timeoutMs: 30_000,
        });

        // 3. The wrapper is transparent. A forensic layer that swallowed
        //    the error would be worse than no layer at all.
        expect(provoked.threw).toBe(true);
        expect(provoked.message).toContain("not be found");

        // 4. The report names the actual nodes.
        const report = provoked.report;
        expect(report).not.toBeNull();
        expect(report?.kind).toBe("dom-forensics");
        expect(report?.method).toBe("removeChild");
        expect(report?.parent?.dataset?.["data-slot"]).toBe("at0606-parent");
        expect(report?.child?.dataset?.["data-slot"]).toBe("at0606-child");

        // The diagnosis: reparented, not detached. These are two different
        // bugs behind one error message, and telling them apart is the
        // whole reason this capture exists.
        expect(report?.childActualParent).not.toBe("detached");
        expect(
          (report?.childActualParent as { dataset?: Record<string, string> })
            ?.dataset?.["data-slot"],
        ).toBe("at0606-elsewhere");
        expect(report?.parentContainsChild).toBe(false);

        // 5. The breadcrumb rode along.
        const crumb = report?.breadcrumbs?.find(
          (c) => c.channel === "at0606.probe",
        );
        expect(crumb).toBeDefined();
        expect(crumb?.detail?.["marker"]).toBe(MARKER);

        // 6. The record is on disk. This is the assertion that would have
        //    made 2026-09-21 a log read instead of a source read.
        //    Wait on the frontend's own delivery signal rather than
        //    spinning on the file: `waitForCondition` paces the poll, and
        //    a `setTimeout` wait is banned in test code ([D12]).
        await app.waitForCondition<boolean>(
          `window.__domForensics.delivered() > 0`,
          { timeoutMs: 15_000 },
        );
        const faultLog = join(
          homedir(),
          "Library/Application Support/Tug/instances",
          app.instanceId,
          "Logs",
          "client-faults.jsonl",
        );
        const line = readFaultLine(faultLog, MARKER);
        expect(line).not.toBeNull();

        // Each line stands alone as JSON — the property that lets the log
        // be read with `tail` and `jq` and survive a truncated write.
        const parsed = JSON.parse(line as string) as {
          receivedAt?: string;
          fault?: { method?: string; kind?: string };
        };
        expect(parsed.receivedAt).toBeTruthy();
        expect(parsed.fault?.kind).toBe("dom-forensics");
        expect(parsed.fault?.method).toBe("removeChild");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * The fault log's newest line carrying `marker`, or `null`.
 *
 * A single read, not a poll: the caller has already waited on the
 * frontend's delivery signal, which resolves only after tugcast has
 * answered the POST — and tugcast answers it after the append. So by the
 * time this runs the line is there or the sink is broken, and "broken" is
 * the finding this test exists to surface.
 */
function readFaultLine(path: string, marker: string): string | null {
  if (!existsSync(path)) return null;
  const hit = readFileSync(path, "utf8")
    .split("\n")
    .reverse()
    .find((l) => l.includes(marker) && l.trim() !== "");
  return hit ?? null;
}
