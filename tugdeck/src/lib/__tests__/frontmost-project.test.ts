import { afterEach, describe, expect, test } from "bun:test";

import type { CardSessionBinding } from "../card-session-binding-store";
import {
  _resetRelayedFrontmostProjectForTest,
  frontmostProjectBinding,
  relayFrontmostProjectBinding,
} from "../frontmost-project";

const binding = (projectDir: string): CardSessionBinding =>
  ({ tugSessionId: "s1", lineId: "l1", workspaceKey: "w1", projectDir }) as unknown as CardSessionBinding;

afterEach(() => _resetRelayedFrontmostProjectForTest());

describe("frontmostProjectBinding on a body page", () => {
  test("answers with the shell's relayed binding, and with its null", () => {
    const p = binding("/p");
    relayFrontmostProjectBinding(p);
    expect(frontmostProjectBinding()).toBe(p);
    relayFrontmostProjectBinding(null);
    expect(frontmostProjectBinding()).toBeNull();
  });

  test("an equal relay keeps the held reference, so a snapshot does not churn", () => {
    const first = binding("/p");
    relayFrontmostProjectBinding(first);
    relayFrontmostProjectBinding(binding("/p"));
    expect(frontmostProjectBinding()).toBe(first);
    const moved = binding("/q");
    relayFrontmostProjectBinding(moved);
    expect(frontmostProjectBinding()).toBe(moved);
  });
});
