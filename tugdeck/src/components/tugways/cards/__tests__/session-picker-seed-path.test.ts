/**
 * Unit tests for `seedPathFrom` — the precedence the Session picker's project
 * path field opens on before the user has touched it.
 *
 * The function is pure, which is the point of it existing: the picker's FIRST
 * render has to carry the path the picker will be drawn with, because the
 * height a Session card bids at arrival is read off that render. An effect
 * writing state a tick later would measure a picker listing no sessions.
 *
 * The precedence is a chain, so each test states one rung by supplying the one
 * above it as empty — a recent over a default, a default over the Swift hint,
 * the hint over the backend home, and nothing at all yielding `""`.
 */

import { describe, it, expect } from "bun:test";

import { seedPathFrom } from "../session-picker-seed";

describe("seedPathFrom — the picker's opening project path", () => {
  it("prefers the most-recent project over every other source", () => {
    expect(
      seedPathFrom(["/recent/one", "/recent/two"], "/default", "/hint", "/home"),
    ).toBe("/recent/one");
  });

  it("falls to the user's explicit default when there are no recents", () => {
    expect(seedPathFrom([], "/default", "/hint", "/home")).toBe("/default");
  });

  it("falls to the Swift hint when the default setting is unset", () => {
    expect(seedPathFrom([], "", "/hint", "/home")).toBe("/hint");
  });

  it("falls to the backend home when there is no hint either", () => {
    expect(seedPathFrom([], "", "", "/home")).toBe("/home");
  });

  it("yields the empty string when every source is empty", () => {
    expect(seedPathFrom([], "", "", undefined)).toBe("");
    expect(seedPathFrom([], "", "", "")).toBe("");
  });

  it("reads the default as the EXPLICIT setting, never a computed <home>/tug", () => {
    // An unset default must fall THROUGH to the hint. Shadowing it with a
    // path derived from home would seed a directory the user never chose —
    // and on a debug build would hide the repo source tree the hint carries.
    expect(seedPathFrom([], "", "/repo/source", "/home")).toBe("/repo/source");
  });
});
