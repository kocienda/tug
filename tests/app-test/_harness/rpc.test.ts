/**
 * rpc.test.ts — Pure-logic unit tests for the RPC client and error
 * translator. No subprocess, no real socket — a mock RpcTransport.
 *
 * These exercise the framing / correlation logic and the
 * `error.name → class` mapping.
 */

import { describe, expect, test } from "bun:test";
import { RpcClient, WAIT_CEILING_MS, enforcedTimeout, translateError, type RpcTransport } from "./rpc";
import {
  AppCrashedError,
  TimeoutError,
  VersionSkewError,
} from "./errors";

function makeMockTransport(): {
  transport: RpcTransport;
  sent: string[];
  push: (chunk: string) => void;
  close: (reason?: { exitCode?: number | null; signal?: string | null }) => void;
} {
  const sent: string[] = [];
  let dataHandler: ((chunk: string) => void) | null = null;
  let closeHandler:
    | ((reason: { exitCode?: number | null; signal?: string | null }) => void)
    | null = null;
  const transport: RpcTransport = {
    write(data) {
      sent.push(data);
    },
    onData(handler) {
      dataHandler = handler;
    },
    onClose(handler) {
      closeHandler = handler;
    },
  };
  return {
    transport,
    sent,
    push: (chunk) => dataHandler?.(chunk),
    close: (reason) => closeHandler?.(reason ?? {}),
  };
}

describe("RpcClient", () => {
  test("correlates responses to requests by id", async () => {
    const { transport, sent, push } = makeMockTransport();
    const client = new RpcClient(transport);

    const p1 = client.call<number>({ method: "evalJS", script: "1+1" });
    const p2 = client.call<string>({ method: "version" });

    // Both writes should have been framed as NDJSON.
    expect(sent.length).toBe(2);
    expect(sent[0].endsWith("\n")).toBe(true);
    expect(sent[1].endsWith("\n")).toBe(true);

    const parsedOut = sent.map((l) => JSON.parse(l.trim()));
    expect(parsedOut[0].id).toBe(1);
    expect(parsedOut[0].method).toBe("evalJS");
    expect(parsedOut[1].id).toBe(2);
    expect(parsedOut[1].method).toBe("version");

    // Respond out of order — p2 first.
    push(
      `${JSON.stringify({ id: 2, ok: true, value: "1.0.0" })}\n`,
    );
    push(
      `${JSON.stringify({ id: 1, ok: true, value: 2 })}\n`,
    );

    const v2 = await p2;
    const v1 = await p1;
    expect(v1).toBe(2);
    expect(v2).toBe("1.0.0");
  });

  test("buffers partial-line input and dispatches on newline", async () => {
    const { transport, push } = makeMockTransport();
    const client = new RpcClient(transport);

    const p = client.call<number>({ method: "evalJS", script: "1+1" });

    const full = `${JSON.stringify({ id: 1, ok: true, value: 42 })}\n`;
    push(full.slice(0, 5));
    push(full.slice(5, 12));
    push(full.slice(12));

    const v = await p;
    expect(v).toBe(42);
  });

  test("translates TimeoutError name into TimeoutError class", async () => {
    const { transport, push } = makeMockTransport();
    const client = new RpcClient(transport);

    const p = client.call<number>({
      method: "evalJS",
      script: "whatever",
      timeoutMs: 100,
    });

    push(
      `${JSON.stringify({
        id: 1,
        ok: false,
        error: { name: "TimeoutError", message: "evalJS exceeded 100ms" },
      })}\n`,
    );

    await expect(p).rejects.toBeInstanceOf(TimeoutError);
    await expect(p).rejects.toMatchObject({
      name: "TimeoutError",
      script: "whatever",
      timeoutMs: 100,
    });
  });

  test("translates unknown error names to plain Error with .name preserved", async () => {
    const { transport, push } = makeMockTransport();
    const client = new RpcClient(transport);

    const p = client.call<number>({ method: "evalJS", script: "throw 'x'" });

    push(
      `${JSON.stringify({
        id: 1,
        ok: false,
        error: { name: "EvalError", message: "x" },
      })}\n`,
    );

    try {
      await p;
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).name).toBe("EvalError");
      expect((e as Error).message).toBe("x");
      expect(e).not.toBeInstanceOf(TimeoutError);
      expect(e).not.toBeInstanceOf(AppCrashedError);
    }
  });

  test("close rejects all pending calls with AppCrashedError", async () => {
    const { transport, close } = makeMockTransport();
    const client = new RpcClient(transport);

    const p1 = client.call({ method: "evalJS", script: "..." });
    const p2 = client.call({ method: "version" });

    close({ exitCode: 2, signal: null });

    await expect(p1).rejects.toBeInstanceOf(AppCrashedError);
    await expect(p2).rejects.toBeInstanceOf(AppCrashedError);
  });

  test("calls sent after close are rejected with AppCrashedError", async () => {
    const { transport, close } = makeMockTransport();
    const client = new RpcClient(transport);

    close({ exitCode: 1, signal: null });

    await expect(
      client.call({ method: "evalJS", script: "1+1" }),
    ).rejects.toBeInstanceOf(AppCrashedError);
  });
});

describe("translateError", () => {
  test("maps TimeoutError name", () => {
    const err = translateError(
      { name: "TimeoutError", message: "out" },
      "script",
      200,
    );
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).script).toBe("script");
    expect((err as TimeoutError).timeoutMs).toBe(200);
  });

  test("maps VersionSkewError name and parses expected/actual", () => {
    const err = translateError({
      name: "VersionSkewError",
      message: "surface version mismatch: expected=1.0.0 actual=2.1.0",
    });
    expect(err).toBeInstanceOf(VersionSkewError);
    expect((err as VersionSkewError).expected).toBe("1.0.0");
    expect((err as VersionSkewError).actual).toBe("2.1.0");
  });

  test("maps AppCrashedError name", () => {
    const err = translateError({ name: "AppCrashedError", message: "bye" });
    expect(err).toBeInstanceOf(AppCrashedError);
  });

  test("unknown name yields plain Error with .name preserved", () => {
    const err = translateError({
      name: "ReferenceError",
      message: "foo is not defined",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ReferenceError");
    expect(err.message).toBe("foo is not defined");
    expect(err).not.toBeInstanceOf(TimeoutError);
  });
});

describe("the wait ceiling", () => {
  test("no wait is enforced past 20 s, however long it asks for", () => {
    expect(WAIT_CEILING_MS).toBe(20_000);
    expect(enforcedTimeout(40_000)).toBe(20_000);
    expect(enforcedTimeout(5_000)).toBe(5_000);
  });

  test("an explicit ask past the ceiling goes on the wire at the ceiling", () => {
    const { transport, sent } = makeMockTransport();
    const client = new RpcClient(transport);
    void client.call<boolean>({ method: "waitForCondition", script: "false", timeoutMs: 100_000 }).catch(() => {});
    expect(JSON.parse(sent[0]).timeoutMs).toBe(20_000);
  });
});
