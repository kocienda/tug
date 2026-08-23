// A spawn stub that behaves like a live claude subprocess for the tests that
// respawn one (conversation rewind, prompt retraction).
//
// Two properties matter, and a bare `{ stdin }` object has neither. A rewind
// respawn dispatches its `initialize` handshake and waits for the ack before
// the manager emits `rewind_result` — the ack is what lets the client's
// progress state mean "the session is back" rather than "a process was
// launched" — and the wait also settles on the subprocess exiting. A stub that
// answers nothing sits out the readiness timeout; one with no `exited` makes
// the wait throw, which in the in-place leg reads as a failed respawn and
// rolls the truncation back.

import type { SessionManager } from "../session.ts";

/**
 * A fake subprocess whose stdin answers every control request with a success
 * `control_response` correlated to the request's id — claude's own shape,
 * minus a payload (readiness correlates on the id alone). It never exits.
 */
export function respondingProcess(manager: SessionManager): unknown {
  const reply = (data: unknown): void => {
    const request = JSON.parse(String(data).replace(/\n$/, ""));
    queueMicrotask(() => {
      (manager as unknown as { handleClaudeLine: (line: string) => void }).handleClaudeLine(
        JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: request.request_id,
            response: {},
          },
        }),
      );
    });
  };
  return {
    stdin: { write: reply, flush: () => {}, end: () => {} },
    exited: new Promise<number>(() => {}),
  };
}
