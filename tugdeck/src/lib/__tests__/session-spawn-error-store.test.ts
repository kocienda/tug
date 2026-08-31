import { describe, it, expect } from "bun:test";

import {
  sessionSpawnErrorStore,
  spawnErrorMessage,
  isSpawnBudgetReason,
} from "../session-spawn-error-store";

describe("sessionSpawnErrorStore", () => {
  it("set then get returns the recorded error", () => {
    sessionSpawnErrorStore.set("card-set", { reason: "does_not_exist" });
    expect(sessionSpawnErrorStore.get("card-set")).toEqual({
      reason: "does_not_exist",
    });
    sessionSpawnErrorStore.clear("card-set");
  });

  it("get returns null for an unknown card", () => {
    expect(sessionSpawnErrorStore.get("card-unknown")).toBeNull();
  });

  it("clear removes the recorded error", () => {
    sessionSpawnErrorStore.set("card-clear", { reason: "permission_denied" });
    sessionSpawnErrorStore.clear("card-clear");
    expect(sessionSpawnErrorStore.get("card-clear")).toBeNull();
  });

  it("notifies subscribers on set and clear, scoped per card", () => {
    let aTicks = 0;
    let bTicks = 0;
    const unsubA = sessionSpawnErrorStore.subscribe("card-a", () => {
      aTicks += 1;
    });
    const unsubB = sessionSpawnErrorStore.subscribe("card-b", () => {
      bTicks += 1;
    });
    sessionSpawnErrorStore.set("card-a", { reason: "does_not_exist" });
    expect(aTicks).toBe(1);
    expect(bTicks).toBe(0); // scoped — card-b's subscriber is untouched
    sessionSpawnErrorStore.clear("card-a");
    expect(aTicks).toBe(2);
    unsubA();
    unsubB();
    sessionSpawnErrorStore.set("card-a", { reason: "x" });
    expect(aTicks).toBe(2); // unsubscribed — no further ticks
    sessionSpawnErrorStore.clear("card-a");
  });

  it("clear on a card with no recorded error does not notify", () => {
    let ticks = 0;
    const unsub = sessionSpawnErrorStore.subscribe("card-noop", () => {
      ticks += 1;
    });
    sessionSpawnErrorStore.clear("card-noop");
    expect(ticks).toBe(0);
    unsub();
  });

  it("get returns a stable reference between mutations", () => {
    sessionSpawnErrorStore.set("card-stable", { reason: "does_not_exist" });
    expect(sessionSpawnErrorStore.get("card-stable")).toBe(
      sessionSpawnErrorStore.get("card-stable"),
    );
    sessionSpawnErrorStore.clear("card-stable");
  });
});

describe("spawnErrorMessage", () => {
  it("maps known reason codes to human copy", () => {
    expect(spawnErrorMessage("does_not_exist")).toBe(
      "The project directory no longer exists.",
    );
    expect(spawnErrorMessage("permission_denied")).toBe(
      "Permission denied for the project directory.",
    );
    expect(spawnErrorMessage("spawn_rate_limited")).toBe(
      "Too many sessions are starting at once. Try again in a moment.",
    );
  });

  it("gives the two budget reasons distinct copy", () => {
    // The cap holds until a session ends; the bucket drains on its own.
    // Sharing one string told a capped user to wait for something that
    // waiting never delivers.
    expect(spawnErrorMessage("concurrent_session_cap_exceeded")).toBe(
      "Every session slot is in use. Close a session, then try again.",
    );
    expect(spawnErrorMessage("concurrent_session_cap_exceeded")).not.toBe(
      spawnErrorMessage("spawn_rate_limited"),
    );
  });

  it("falls back to a generic message for unknown codes", () => {
    expect(spawnErrorMessage("some_future_reason")).toBe(
      "The session could not be started.",
    );
  });
});

describe("isSpawnBudgetReason", () => {
  it("is true for the two reasons the host refuses on its own budget", () => {
    expect(isSpawnBudgetReason("concurrent_session_cap_exceeded")).toBe(true);
    expect(isSpawnBudgetReason("spawn_rate_limited")).toBe(true);
  });

  it("is false for every reason that faults the project directory", () => {
    // These steer the user at the picker, where re-choosing IS the recovery.
    // A budget reason must never join them: the directory was never wrong.
    for (const reason of [
      "does_not_exist",
      "not_a_directory",
      "permission_denied",
      "missing_project_dir",
      "metadata_error",
    ]) {
      expect(isSpawnBudgetReason(reason)).toBe(false);
    }
  });

  it("is false for unknown codes", () => {
    // A reason nobody has classified must fall to the directory-faulting
    // path's generic copy rather than silently claiming the host is full.
    expect(isSpawnBudgetReason("some_future_reason")).toBe(false);
  });
});

describe("SpawnError carries no retry context", () => {
  it("records the reason and nothing else", () => {
    // Deliberate. The picker's Retry button routes through `fireRestore`,
    // which spawns with `sessionMode: "resume"` — and a refused *fresh*
    // spawn has a client-minted session id that no session was ever created
    // for. Handing a budget rejection retry context would arm that button to
    // resume something that never existed.
    sessionSpawnErrorStore.set("card-bare", {
      reason: "concurrent_session_cap_exceeded",
    });
    expect(sessionSpawnErrorStore.get("card-bare")).toEqual({
      reason: "concurrent_session_cap_exceeded",
    });
    sessionSpawnErrorStore.clear("card-bare");
  });
});
