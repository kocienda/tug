/**
 * The global theme key as a mirror of the theme on screen.
 *
 * What is under test is the one judgement the mirror makes: whether a value
 * pushed for the key is an outside write that must be applied, or something
 * already applied. Getting it wrong in one direction loops the theme setter;
 * in the other it stamps a stale theme onto the workspace the user is in.
 */

import { describe, test, expect } from "bun:test";
import { ThemeMirror } from "../theme-mirror";

function mirrorSeeded(value: string): { mirror: ThemeMirror; written: string[] } {
  const written: string[] = [];
  const mirror = new ThemeMirror((theme) => written.push(theme));
  mirror.seed(value);
  return { mirror, written };
}

describe("ThemeMirror", () => {
  test("a theme the key already holds is not written again", () => {
    const { mirror, written } = mirrorSeeded("ironclad");
    mirror.write("ironclad");
    expect(written).toEqual([]);
    mirror.write("sloop");
    mirror.write("sloop");
    expect(written).toEqual(["sloop"]);
  });

  test("the echo of an own write is already applied", () => {
    const { mirror } = mirrorSeeded("ironclad");
    mirror.write("sloop");
    expect(mirror.observe("sloop")).toBe(false);
  });

  test("a late echo is still an echo, whatever is on screen by then", () => {
    // Two workspace switches in quick succession: the key is written `sloop`
    // then `caravel`, and `sloop`'s echo lands with `caravel` on screen.
    const { mirror } = mirrorSeeded("ironclad");
    mirror.write("sloop");
    mirror.write("caravel");
    expect(mirror.observe("sloop")).toBe(false);
    expect(mirror.observe("caravel")).toBe(false);
  });

  test("a coalesced push settles every write before the one it carries", () => {
    const { mirror } = mirrorSeeded("ironclad");
    mirror.write("sloop");
    mirror.write("caravel");
    expect(mirror.observe("caravel")).toBe(false);
    // `sloop` is no longer owed an echo, so this one came from outside.
    expect(mirror.observe("sloop")).toBe(true);
  });

  test("a value nobody here wrote is an outside write, once", () => {
    const { mirror, written } = mirrorSeeded("ironclad");
    expect(mirror.observe("ketch")).toBe(true);
    // The domain is pushed whole when any key in it moves.
    expect(mirror.observe("ketch")).toBe(false);
    // Applying it puts `ketch` on screen; the key already holds it.
    mirror.write("ketch");
    expect(written).toEqual([]);
  });

  test("a push that changed nothing is not an outside write", () => {
    const { mirror } = mirrorSeeded("ironclad");
    expect(mirror.observe("ironclad")).toBe(false);
  });
});
