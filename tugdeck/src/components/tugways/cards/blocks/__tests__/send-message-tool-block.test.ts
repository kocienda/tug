/**
 * Pure-logic tests for `SendMessageToolBlock`'s wire-narrowing and
 * header composition, plus the dispatch registration pin
 * (`sendmessage` → `SendMessageToolBlock`).
 *
 * No DOM: `bun:test` pure-logic assertions only.
 *
 * @module components/tugways/cards/blocks/__tests__/send-message-tool-block
 */

import { describe, expect, test } from "bun:test";

import {
  SendMessageToolBlock,
  composeSendMessageHeaderTarget,
  composeSendMessageLabel,
  narrowSendMessageInput,
} from "../send-message-tool-block";
import { BESPOKE_FACTORY_BY_NAME } from "../../session-assistant-renderer-registrations";

describe("narrowSendMessageInput", () => {
  test("keeps the four wire fields", () => {
    expect(
      narrowSendMessageInput({
        to: "researcher",
        message: "start on task #1",
        summary: "assign task 1",
        notify_when_idle: true,
      }),
    ).toEqual({
      to: "researcher",
      message: "start on task #1",
      summary: "assign task 1",
      notify_when_idle: true,
    });
  });

  test("treats empty strings as absent and drops mistyped fields", () => {
    expect(
      narrowSendMessageInput({ to: "", message: 7, summary: null, notify_when_idle: "yes" }),
    ).toEqual({
      to: undefined,
      message: undefined,
      summary: undefined,
      notify_when_idle: undefined,
    });
  });

  test("returns {} for non-object input", () => {
    expect(narrowSendMessageInput(null)).toEqual({});
    expect(narrowSendMessageInput("x")).toEqual({});
  });
});

describe("composeSendMessageLabel", () => {
  test("prefers the summary the model wrote for the row", () => {
    expect(
      composeSendMessageLabel({ summary: "assign task 1", message: "Hello\nmore" }),
    ).toBe("assign task 1");
  });

  test("falls back to the message's first non-empty line", () => {
    expect(
      composeSendMessageLabel({ message: "\n  \nCheck the tests over there.\nThanks." }),
    ).toBe("Check the tests over there.");
  });

  test("is undefined for a pure idle subscription", () => {
    expect(composeSendMessageLabel({ to: "worker", notify_when_idle: true })).toBeUndefined();
  });
});

describe("composeSendMessageHeaderTarget", () => {
  test("joins recipient and label as one unit, the projection's shape", () => {
    expect(
      composeSendMessageHeaderTarget({ to: "worker", summary: "re-run suite" }),
    ).toBe("workerre-run suite");
  });

  test("is undefined when the input carries neither", () => {
    expect(composeSendMessageHeaderTarget({})).toBeUndefined();
  });
});

describe("dispatch registration", () => {
  test("sendmessage → SendMessageToolBlock", () => {
    expect(BESPOKE_FACTORY_BY_NAME.get("sendmessage")).toBe(SendMessageToolBlock);
  });
});
