/**
 * The session and commit mention providers, over recorded answers.
 *
 * Both search in tugcast, so what is the deck's to get right is the exchange:
 * one ask per question, the answer to a query the user has typed past dropped,
 * the last answer narrowed rather than blanked while the next is in flight —
 * and then the rows themselves, which must mint the same atoms every other
 * surface does. The transport here is a recording one; nothing reaches a
 * connection.
 */

import { describe, expect, test } from "bun:test";

import { COMMIT_ATOM_TYPE } from "@/lib/command-atom";
import type { GitLogCommit } from "@/lib/git-log-store";
import { SESSION_ATOM_TYPE } from "@/lib/session-atom";
import type { SearchedSession } from "@/protocol";
import { createCommitMentionProvider } from "../completion-providers/commit-mentions";
import type {
  RemoteSearchAnswer,
  RemoteSearchRequest,
  RemoteSearchTransport,
} from "../completion-providers/remote-search";
import { createSessionMentionProvider } from "../completion-providers/session-mentions";

/** A transport that records every ask and answers only when told to. */
function recordingTransport<Row>() {
  const sent: RemoteSearchRequest[] = [];
  const listeners = new Set<(answer: RemoteSearchAnswer<Row>) => void>();
  let connected = true;
  const transport: RemoteSearchTransport<Row> = {
    send(request) {
      if (!connected) return false;
      sent.push(request);
      return true;
    },
    onAnswer(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    transport,
    sent,
    listenerCount: () => listeners.size,
    disconnect: () => {
      connected = false;
    },
    reconnect: () => {
      connected = true;
    },
    /** Answer the `index`-th ask (the latest when omitted) with `rows`. */
    answer(rows: readonly Row[], index = sent.length - 1) {
      const request = sent[index];
      if (request === undefined) throw new Error(`no ask at ${index}`);
      for (const listener of [...listeners]) listener({ requestId: request.requestId, rows });
    },
  };
}

function session(over: Partial<SearchedSession> = {}): SearchedSession {
  return {
    sessionId: "0f3c1e5a-1111-2222-3333-444455556666",
    callsign: "curly-apple",
    title: "Parser rewrite",
    projectDir: "/u/src/eucit",
    projectLeaf: "eucit",
    lastUsedAtMs: 5000,
    instance: "debug-b",
    ...over,
  };
}

const OWN = "aaaaaaaa-0000-0000-0000-000000000000";
const OWN_ROW = session({
  sessionId: OWN,
  callsign: "faint-surf",
  title: "Video script",
  projectDir: "/u/src/tug",
  projectLeaf: "tug",
  instance: null,
});

function commit(sha: string, subject: string): GitLogCommit {
  return { sha, subject } as GitLogCommit;
}

const OLD = commit("b0ab1b0d3c4e5f60718293a4b5c6d7e8f9012345", "Search commits in the log query");
const NEW = commit("85d5b3888aa1bb2cc3dd4ee5ff60718293a4b5c6", "Add the search_sessions verb");

function sessions(opts: { projectDir?: () => string; now?: () => number } = {}) {
  const wire = recordingTransport<SearchedSession>();
  const made = createSessionMentionProvider({
    projectDir: opts.projectDir ?? (() => "/u/src/tug"),
    ownSessionId: () => OWN,
    transport: wire.transport,
    now: opts.now ?? (() => 0),
  });
  return { wire, ...made };
}

function commits(opts: { now?: () => number } = {}) {
  const wire = recordingTransport<GitLogCommit>();
  const made = createCommitMentionProvider({
    projectDir: () => "/u/src/tug",
    transport: wire.transport,
    now: opts.now ?? (() => 0),
  });
  return { wire, ...made };
}

describe("the session provider", () => {
  test("a row is the session atom, labelled as the chip reads", () => {
    const { wire, provider } = sessions();
    expect(provider("curly")).toEqual([]);
    expect(wire.sent).toHaveLength(1);
    expect(wire.sent[0]).toMatchObject({ scope: "/u/src/tug", query: "curly" });

    wire.answer([session()]);
    expect(provider("curly")).toEqual([
      {
        label: "eucit/curly-apple",
        description: "Parser rewrite",
        matches: [[6, 11]],
        atom: {
          kind: "atom",
          type: SESSION_ATOM_TYPE,
          label: "eucit/curly-apple",
          value: "eucit/curly-apple",
          // The pair that lets a reader find a session this instance never
          // minted: without it the chip is a name, not a reference.
          session: { id: "0f3c1e5a-1111-2222-3333-444455556666", projectDir: "/u/src/eucit" },
        },
      },
    ]);
  });

  test("a title-only match marks nothing, and an untitled row has no description", () => {
    const { wire, provider } = sessions();
    provider("parser");
    wire.answer([session(), session({ sessionId: "b", callsign: "parser-owl", title: null })]);
    const [byTitle, byCallsign] = provider("parser");
    expect(byTitle?.matches).toBeUndefined();
    expect(byCallsign?.label).toBe("eucit/parser-owl");
    expect(byCallsign?.description).toBeUndefined();
  });

  test("the session being typed in is left out", () => {
    const { wire, provider } = sessions();
    provider("");
    wire.answer([OWN_ROW, session()]);
    expect(provider("").map((item) => item.label)).toEqual(["eucit/curly-apple"]);
  });

  test("the project half is derived when the server sent no leaf", () => {
    const { wire, provider } = sessions();
    provider("");
    wire.answer([session({ projectLeaf: "", projectDir: "/u/src/eucit/" })]);
    expect(provider("")[0]?.label).toBe("eucit/curly-apple");
  });
});

describe("the commit provider", () => {
  test("a row is the commit atom, read as its short sha and subject", () => {
    const { wire, provider } = commits();
    provider("search");
    wire.answer([NEW, OLD]);
    expect(provider("search")).toEqual([
      {
        label: "85d5b388",
        description: "Add the search_sessions verb",
        atom: {
          kind: "atom",
          type: COMMIT_ATOM_TYPE,
          label: "commit:85d5b388",
          value: NEW.sha,
        },
      },
      {
        label: "b0ab1b0d",
        description: "Search commits in the log query",
        atom: {
          kind: "atom",
          type: COMMIT_ATOM_TYPE,
          label: "commit:b0ab1b0d",
          value: OLD.sha,
        },
      },
    ]);
  });

  test("a sha prefix is marked on the label, whatever case it was typed in", () => {
    const { wire, provider } = commits();
    provider("B0AB1");
    wire.answer([OLD]);
    expect(provider("B0AB1")[0]?.matches).toEqual([[0, 5]]);
  });
});

describe("the exchange both share", () => {
  test("one ask per question, however often the provider is called", () => {
    const { wire, provider } = commits();
    provider("verb");
    provider("verb");
    provider(" verb ");
    expect(wire.sent.map((request) => request.query)).toEqual(["verb"]);
    wire.answer([NEW]);
    provider("verb");
    expect(wire.sent).toHaveLength(1);
  });

  test("an answer for a query the user has typed past is dropped", () => {
    const { wire, provider } = commits();
    let notified = 0;
    provider.subscribe?.(() => {
      notified += 1;
    });
    provider("se");
    provider("sea");
    // The answer to "se" lands after "sea" was asked.
    wire.answer([NEW, OLD], 0);
    expect(notified).toBe(0);
    expect(provider("sea")).toEqual([]);

    wire.answer([OLD], 1);
    expect(notified).toBe(1);
    expect(provider("sea").map((item) => item.label)).toEqual(["b0ab1b0d"]);
  });

  test("the last answer is narrowed, not blanked, while the next is in flight", () => {
    const { wire, provider } = sessions();
    provider("");
    wire.answer([session(), session({ sessionId: "b", callsign: "odd-kiln", title: null })]);
    // One more character: asked again, and meanwhile only the row that still
    // matches is offered.
    expect(provider("cur").map((item) => item.label)).toEqual(["eucit/curly-apple"]);
    expect(wire.sent.map((request) => request.query)).toEqual(["", "cur"]);
    // The held commit rows narrow by the server's own rule: a short hex
    // fragment is a subject fragment, not a prefix.
    const log = commits();
    log.provider("");
    log.wire.answer([NEW, OLD]);
    expect(log.provider("b0a")).toEqual([]);
    expect(log.provider("b0ab").map((item) => item.label)).toEqual(["b0ab1b0d"]);
  });

  test("rows held for another project are not offered there", () => {
    let dir = "/u/src/tug";
    const { wire, provider } = sessions({ projectDir: () => dir });
    provider("");
    wire.answer([session()]);
    dir = "/u/src/eucit";
    expect(provider("")).toEqual([]);
    expect(wire.sent.map((request) => request.scope)).toEqual(["/u/src/tug", "/u/src/eucit"]);
  });

  test("an old answer is asked again, and stays on screen until the new one lands", () => {
    let clock = 0;
    const { wire, provider } = commits({ now: () => clock });
    provider("");
    wire.answer([OLD]);
    clock = 4000;
    provider("");
    expect(wire.sent).toHaveLength(1);
    clock = 6000;
    expect(provider("").map((item) => item.label)).toEqual(["b0ab1b0d"]);
    expect(wire.sent).toHaveLength(2);
    wire.answer([NEW, OLD]);
    expect(provider("").map((item) => item.label)).toEqual(["85d5b388", "b0ab1b0d"]);
  });

  test("with no connection nothing is offered, and the next call asks again", () => {
    const { wire, provider } = commits();
    wire.disconnect();
    expect(provider("verb")).toEqual([]);
    wire.reconnect();
    provider("verb");
    expect(wire.sent.map((request) => request.query)).toEqual(["verb"]);
  });

  test("two providers on one wire keep their own answers", () => {
    const wire = recordingTransport<GitLogCommit>();
    const make = () =>
      createCommitMentionProvider({ projectDir: () => "/u/src/tug", transport: wire.transport });
    const first = make();
    const second = make();
    first.provider("a");
    second.provider("a");
    wire.answer([OLD], 0);
    expect(first.provider("a")).toHaveLength(1);
    expect(second.provider("a")).toEqual([]);
  });

  test("dispose releases the wire and the listeners", () => {
    const { wire, provider, dispose } = commits();
    let notified = 0;
    provider.subscribe?.(() => {
      notified += 1;
    });
    provider("verb");
    expect(wire.listenerCount()).toBe(1);
    dispose();
    expect(wire.listenerCount()).toBe(0);
    wire.answer([NEW]);
    expect(notified).toBe(0);
  });
});
