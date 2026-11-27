/**
 * The bullseyed figure's store: a show is numbered, and a close that names an
 * older show leaves the newer one standing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  adoptFigureBullseye,
  closeFigureBullseye,
  getFigureBullseye,
  setFigureBullseyeCloseSink,
  showFigureBullseye,
  subscribeFigureBullseye,
} from "../figure-bullseye-store";

const A = { source: '{"tugdiagram": 1, "form": "tree", "title": "a"}', layers: "diagram" as const };
const B = { source: '{"tugdiagram": 1, "form": "tree", "title": "b"}', layers: "diagram" as const };

afterEach(() => {
  setFigureBullseyeCloseSink(null);
  closeFigureBullseye();
});

describe("figure bullseye store", () => {
  test("a show is numbered and replaces the figure shown", () => {
    const before = getFigureBullseye().seq;
    showFigureBullseye(A);
    showFigureBullseye(B);
    expect(getFigureBullseye()).toEqual({ figure: B, seq: before + 2 });
  });

  test("a close for an older show is dropped", () => {
    showFigureBullseye(A);
    const stale = getFigureBullseye().seq;
    showFigureBullseye(B);
    closeFigureBullseye(stale);
    expect(getFigureBullseye().figure).toEqual(B);
    closeFigureBullseye(getFigureBullseye().seq);
    expect(getFigureBullseye().figure).toBeNull();
  });

  test("a close goes to the sink naming its show, once", () => {
    const sent: number[] = [];
    setFigureBullseyeCloseSink((seq) => sent.push(seq));
    showFigureBullseye(A);
    const seq = getFigureBullseye().seq;
    closeFigureBullseye();
    closeFigureBullseye();
    expect(sent).toEqual([seq]);
  });

  test("adopting the shell's state notifies only on a change", () => {
    let heard = 0;
    const release = subscribeFigureBullseye(() => {
      heard += 1;
    });
    const next = { figure: A, seq: getFigureBullseye().seq + 1 };
    adoptFigureBullseye(next);
    adoptFigureBullseye({ ...next, figure: { ...A } });
    release();
    expect(heard).toBe(1);
    expect(getFigureBullseye().figure).toEqual(A);
  });
});
