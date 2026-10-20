/**
 * The host parity fixture is what the registry writes.
 *
 * `fixtures/host-parity.json` is the one document both languages read:
 * `TugTests/HostChannelTests.swift` checks the Swift twin
 * (`HostMessages.swift`) against it — the same names, the same shell-only
 * set, every sample decoding and every typed refusal refused, in both
 * directions, and the same calls the host awaits. This test
 * holds the fixture to the registry byte for byte, so a declaration that
 * moves without its fixture fails here. Regenerate with
 * `HOST_PARITY_UPDATE=1` (or `just golden`) and review the diff.
 *
 * @covers tugdeck/src/host/registry.ts
 * @covers tugapp/Sources/HostMessages.swift
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PAGE_CALLS, TO_HOST, TO_PAGE } from "../registry";

const FIXTURE = join(import.meta.dir, "fixtures", "host-parity.json");

function fixture(): string {
  const toHost = TO_HOST.map((d) => ({
    name: d.name,
    from: d.from,
    typed: d.typed,
    samples: d.samples,
    refused: d.refused,
  }));
  const toPage = TO_PAGE.map((d) => ({
    member: d.member,
    to: d.to,
    typed: d.typed,
    samples: d.samples,
    refused: d.refused,
  }));
  const pageCalls = PAGE_CALLS.map((d) => ({ receiver: d.receiver, member: d.member, samples: d.samples }));
  return `${JSON.stringify({ toHost, toPage, pageCalls }, null, 2)}\n`;
}

describe("the host parity fixture", () => {
  test("is what the registry writes", () => {
    const serialized = fixture();
    if (process.env.HOST_PARITY_UPDATE === "1") writeFileSync(FIXTURE, serialized);
    expect(serialized, "the host vocabulary moved: review the diff, then regenerate with HOST_PARITY_UPDATE=1").toBe(
      readFileSync(FIXTURE, "utf8"),
    );
  });
});
