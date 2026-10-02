/**
 * breaker — the motion switch's off edge.
 *
 * `demote(false)` tells its subscribers when, and only when, a demotion was
 * actually cleared, so the canvas's loop pass runs once per throw-back and
 * never on a no-op. Driven over a stand-in `<html>`: the switch reads and
 * writes one attribute, and that is all the root it needs.
 */

import { describe, expect, test } from "bun:test";

import { createMotionBreaker, DEMOTED_ATTRIBUTE } from "@/lib/motion-guard/breaker";

function standInRoot() {
  const attrs = new Set<string>();
  return {
    attrs,
    hasAttribute: (n: string) => attrs.has(n),
    setAttribute: (n: string) => void attrs.add(n),
    removeAttribute: (n: string) => void attrs.delete(n),
  };
}

describe("motion switch off edge", () => {
  test("clearing a demotion tells every subscriber once", () => {
    const root = standInRoot();
    const breaker = createMotionBreaker(() => root);
    let resumes = 0;
    breaker.onResume(() => resumes++);

    breaker.demote(true);
    expect(root.attrs.has(DEMOTED_ATTRIBUTE)).toBe(true);
    expect(resumes).toBe(0);

    breaker.demote(false);
    expect(root.attrs.has(DEMOTED_ATTRIBUTE)).toBe(false);
    expect(breaker.demoted).toBe(false);
    expect(resumes).toBe(1);
  });

  test("an off with nothing demoted is not an edge", () => {
    const root = standInRoot();
    const breaker = createMotionBreaker(() => root);
    let resumes = 0;
    breaker.onResume(() => resumes++);
    breaker.demote(false);
    breaker.reset();
    expect(resumes).toBe(0);
  });

  test("reset is an off edge like any other", () => {
    const root = standInRoot();
    const breaker = createMotionBreaker(() => root);
    let resumes = 0;
    breaker.onResume(() => resumes++);
    breaker.demote(true);
    breaker.reset();
    expect(resumes).toBe(1);
  });

  test("a released subscription hears nothing", () => {
    const root = standInRoot();
    const breaker = createMotionBreaker(() => root);
    let resumes = 0;
    const release = breaker.onResume(() => resumes++);
    release();
    breaker.demote(true);
    breaker.demote(false);
    expect(resumes).toBe(0);
  });

  test("with no root there is nothing to switch", () => {
    const breaker = createMotionBreaker(() => null);
    let resumes = 0;
    breaker.onResume(() => resumes++);
    breaker.demote(true);
    breaker.demote(false);
    expect(breaker.demoted).toBe(false);
    expect(resumes).toBe(0);
  });
});
