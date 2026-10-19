import { afterEach, describe, expect, test } from "bun:test";
import { _resetPageForTest, bindPageCard, installPage, page } from "../page";

afterEach(() => _resetPageForTest());

describe("page", () => {
  test("reads as the shell before install", () => {
    expect(page.role).toBe("shell");
    expect(page.isShell).toBe(true);
    expect(page.isBody).toBe(false);
    expect(page.cardId).toBeNull();
  });

  test("a second install throws", () => {
    installPage({ role: "shell", cardId: null, componentId: null });
    expect(() => installPage({ role: "shell", cardId: null, componentId: null })).toThrow();
  });

  test("a body reads its card", () => {
    installPage({ role: "body", cardId: "c1", componentId: "session" });
    expect(page.isBody).toBe(true);
    expect(page.cardId).toBe("c1");
    expect(page.componentId).toBe("session");
  });

  test("bindPageCard throws in the shell, before install, and on a body bound to another card", () => {
    expect(() => bindPageCard("c1", "text")).toThrow();
    installPage({ role: "shell", cardId: null, componentId: null });
    expect(() => bindPageCard("c1", "text")).toThrow();
    _resetPageForTest();
    installPage({ role: "body", cardId: "c1", componentId: "text" });
    expect(() => bindPageCard("c2", "text")).toThrow();
  });

  test("a spare learns its card once", () => {
    installPage({ role: "body", cardId: null, componentId: null });
    expect(page.cardId).toBeNull();
    bindPageCard("c7", "jots");
    expect(page.cardId).toBe("c7");
    expect(page.componentId).toBe("jots");
  });
});
