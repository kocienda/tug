/**
 * Pure-logic tests for `SessionInitBanner`'s wire narrowing and
 * the [D03] diff logic.
 *
 *  - `narrowSessionMetadata` — defensive narrowing of the wire
 *    `unknown` payload.
 *  - `hasSessionMetadataChanged` — shallow on
 *    (model, permissionMode, version, cwd) + deep on
 *    (tools, skills, agents).
 *  - The dispatch routes `system_metadata` to the real
 *    `SessionInitBanner` (via `KIND_RENDERERS.system_metadata`).
 *
 * No DOM: per the project's testing policy these are `bun:test`
 * pure-logic assertions, not fake-DOM render tests.
 */

import { describe, expect, test } from "bun:test";

import {
  SessionInitBanner,
  hasSessionMetadataChanged,
  narrowSessionMetadata,
} from "./session-init-banner";
import { KIND_RENDERERS } from "../cards/session-assistant-kind-dispatch";

// ---------------------------------------------------------------------------
// narrowSessionMetadata
// ---------------------------------------------------------------------------

describe("narrowSessionMetadata", () => {
  test("keeps every change-relevant field when well-typed", () => {
    expect(
      narrowSessionMetadata({
        model: "claude-opus-4-7",
        permissionMode: "acceptEdits",
        version: "2.1.148",
        cwd: "/Users/user/repo",
        tools: ["Bash", "Read"],
        skills: ["commit"],
        agents: ["claude"],
        // Wire fields that aren't change-relevant — ignored.
        session_id: "abc",
        ipc_version: 2,
      }),
    ).toEqual({
      model: "claude-opus-4-7",
      permissionMode: "acceptEdits",
      version: "2.1.148",
      cwd: "/Users/user/repo",
      tools: ["Bash", "Read"],
      skills: ["commit"],
      agents: ["claude"],
    });
  });

  test("drops mistyped scalars and filters non-strings from arrays", () => {
    expect(
      narrowSessionMetadata({
        model: 42,
        permissionMode: null,
        tools: ["ok", 7, null, "fine"],
      }),
    ).toEqual({
      model: undefined,
      permissionMode: undefined,
      version: undefined,
      cwd: undefined,
      tools: ["ok", "fine"],
      skills: undefined,
      agents: undefined,
    });
  });

  test("tolerates non-objects", () => {
    expect(narrowSessionMetadata(null)).toEqual({});
    expect(narrowSessionMetadata("nope")).toEqual({});
    expect(narrowSessionMetadata(undefined)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// hasSessionMetadataChanged
// ---------------------------------------------------------------------------

describe("hasSessionMetadataChanged", () => {
  const BASE = {
    model: "m",
    permissionMode: "p",
    version: "v",
    cwd: "/c",
    tools: ["a", "b"],
    skills: ["s"],
    agents: ["g"],
  } as const;

  test("first observation (no previous) → true", () => {
    expect(hasSessionMetadataChanged(BASE, undefined)).toBe(true);
  });

  test("identical snapshots → false", () => {
    expect(hasSessionMetadataChanged({ ...BASE }, { ...BASE })).toBe(false);
  });

  test("changed model → true", () => {
    expect(
      hasSessionMetadataChanged({ ...BASE, model: "m2" }, BASE),
    ).toBe(true);
  });

  test("changed permissionMode → true", () => {
    expect(
      hasSessionMetadataChanged({ ...BASE, permissionMode: "p2" }, BASE),
    ).toBe(true);
  });

  test("changed version → true", () => {
    expect(
      hasSessionMetadataChanged({ ...BASE, version: "v2" }, BASE),
    ).toBe(true);
  });

  test("changed cwd → true", () => {
    expect(
      hasSessionMetadataChanged({ ...BASE, cwd: "/d" }, BASE),
    ).toBe(true);
  });

  test("deep-changed tools → true", () => {
    expect(
      hasSessionMetadataChanged({ ...BASE, tools: ["a", "c"] }, BASE),
    ).toBe(true);
  });

  test("equal-length but different skills → true", () => {
    expect(
      hasSessionMetadataChanged({ ...BASE, skills: ["x"] }, BASE),
    ).toBe(true);
  });

  test("equal-length and equal agents → false", () => {
    expect(
      hasSessionMetadataChanged({ ...BASE, agents: ["g"] }, BASE),
    ).toBe(false);
  });

  test("added agent → true", () => {
    expect(
      hasSessionMetadataChanged({ ...BASE, agents: ["g", "g2"] }, BASE),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dispatch wiring — system_metadata kind routes to the real component
// ---------------------------------------------------------------------------

describe("system_metadata dispatch wiring", () => {
  test("KIND_RENDERERS.system_metadata is SessionInitBanner", () => {
    expect(KIND_RENDERERS.system_metadata).toBe(SessionInitBanner);
  });
});
