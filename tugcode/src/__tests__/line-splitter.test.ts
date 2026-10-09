import { describe, test, expect, afterEach } from "bun:test";
import { LineSplitter, MAX_LINE_BYTES } from "../line-splitter.ts";

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);

/** Capture the lines `logSessionLifecycle` writes through `console.log`. */
let restoreLog: (() => void) | null = null;
function captureLifecycle(): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  restoreLog = () => {
    console.log = original;
  };
  return lines;
}

afterEach(() => {
  restoreLog?.();
  restoreLog = null;
});

describe("LineSplitter", () => {
  test("defaults the cap to 16 MiB", () => {
    expect(MAX_LINE_BYTES).toBe(16 * 1024 * 1024);
    expect(new LineSplitter({ stream: "t" }).maxLineBytes).toBe(MAX_LINE_BYTES);
  });

  test("splits several lines out of one chunk, verbatim", () => {
    const s = new LineSplitter({ stream: "t" });
    expect(s.push(bytes("a\n  b \r\n\nc"))).toEqual(["a", "  b \r", ""]);
    expect(s.end()).toBe("c");
  });

  test("a line split across chunks is delivered once, whole", () => {
    const s = new LineSplitter({ stream: "t" });
    expect(s.push(bytes('{"type":'))).toEqual([]);
    expect(s.push(bytes('"user"'))).toEqual([]);
    expect(s.push(bytes("}\nnext"))).toEqual(['{"type":"user"}']);
    expect(s.end()).toBe("next");
  });

  test("a multibyte character split across chunks decodes intact", () => {
    const s = new LineSplitter({ stream: "t" });
    const all = bytes("héllo 🙂\n");
    // Split inside "é" (2 bytes) and inside the emoji (4 bytes).
    const cuts = [2, 9, 10];
    const out: string[] = [];
    let prev = 0;
    for (const cut of [...cuts, all.length]) {
      out.push(...s.push(all.subarray(prev, cut)));
      prev = cut;
    }
    expect(out).toEqual(["héllo 🙂"]);
    expect(s.end()).toBeNull();
  });

  test("an over-cap line is dropped, counted, logged once, and the next line survives", () => {
    const log = captureLifecycle();
    const s = new LineSplitter({ stream: "claude_stdout", maxLineBytes: 8 });
    expect(s.push(bytes("ok\n0123"))).toEqual(["ok"]);
    expect(s.push(bytes("45678"))).toEqual([]);
    expect(s.push(bytes("9abc"))).toEqual([]);
    expect(s.push(bytes("def\nafter\n"))).toEqual(["after"]);
    expect(s.droppedLines).toBe(1);
    const drops = log.filter((l) => l.includes("event=tugcode.line_dropped"));
    expect(drops).toEqual([
      "[dev::session-lifecycle] event=tugcode.line_dropped stream=claude_stdout bytes=16 max_line_bytes=8",
    ]);
  });

  test("a line exactly at the cap is delivered", () => {
    captureLifecycle();
    const s = new LineSplitter({ stream: "t", maxLineBytes: 4 });
    expect(s.push(bytes("abcd\nabcde\n"))).toEqual(["abcd"]);
    expect(s.droppedLines).toBe(1);
  });

  test("end() returns a partial line, then nothing", () => {
    const s = new LineSplitter({ stream: "t" });
    expect(s.push(bytes("one\ntw"))).toEqual(["one"]);
    expect(s.end()).toBe("tw");
    expect(s.end()).toBeNull();
  });

  test("end() with nothing carried returns null", () => {
    const s = new LineSplitter({ stream: "t" });
    expect(s.push(bytes("one\n"))).toEqual(["one"]);
    expect(s.end()).toBeNull();
  });

  test("end() mid-drop logs the drop and returns null", () => {
    const log = captureLifecycle();
    const s = new LineSplitter({ stream: "stdin", maxLineBytes: 3 });
    expect(s.push(bytes("toolong"))).toEqual([]);
    expect(s.end()).toBeNull();
    expect(s.droppedLines).toBe(1);
    expect(log.some((l) => l.includes("stream=stdin bytes=7"))).toBe(true);
  });

  test("a chunk buffer reused by the caller does not corrupt the carry", () => {
    const s = new LineSplitter({ stream: "t" });
    const buf = bytes("abc");
    s.push(buf);
    buf.set(bytes("xyz"));
    expect(s.push(bytes("\n"))).toEqual(["abc"]);
  });
});
