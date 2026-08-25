import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const { BridgeLifecycleCoordinator } = await import(
  join(src, "bridgeLifecycle.ts")
);

/**
 * A fake bridge whose `closed()` promise only settles once the test resolves `finishClose()`,
 * so tests can control exactly when an asynchronous `canvas close` finishes relative to a
 * replacement bridge being installed.
 */
function createFakeBridge() {
  const events = [];
  let resolveClose;
  const closeTask = new Promise((resolve) => {
    resolveClose = resolve;
  });
  return {
    events,
    finishClose: () => resolveClose(),
    bridge: {
      dispose() {
        events.push("dispose");
      },
      closed() {
        return closeTask.then(() => {
          events.push("closed");
        });
      },
    },
  };
}

test("retire() waits for the retired bridge's asynchronous close before resolving", async () => {
  const coordinator = new BridgeLifecycleCoordinator();
  const first = createFakeBridge();
  coordinator.setActive(first.bridge);

  let retired = false;
  const retiring = coordinator.retire().then(() => {
    retired = true;
  });

  // Give the microtask queue a chance to run; retire() must still be pending because the fake
  // bridge's close has not finished yet.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(retired, false, "retire() must not resolve before the bridge finishes closing");
  assert.deepEqual(first.events, ["dispose"]);

  first.finishClose();
  await retiring;
  assert.equal(retired, true);
  assert.deepEqual(first.events, ["dispose", "closed"]);
});

test(
  "a replacement resolution awaits the previous bridge's close before it can become active",
  async () => {
    // This models MobileCanvasViewProvider.resolveWebviewView: replacing a bridge must not let a
    // late `canvas close` from the retired bridge race past the replacement's own `canvas open`.
    const coordinator = new BridgeLifecycleCoordinator();
    const first = createFakeBridge();
    coordinator.setActive(first.bridge);

    const generation = coordinator.beginResolution();
    const resolution = coordinator.retire().then(() => {
      assert.ok(coordinator.isCurrent(generation));
      const second = { dispose() {}, closed: () => Promise.resolve() };
      coordinator.setActive(second);
      return second;
    });

    await Promise.resolve();
    await Promise.resolve();
    assert.equal(coordinator.current, undefined, "no replacement should be active yet");

    first.finishClose();
    const second = await resolution;
    assert.equal(coordinator.current, second, "the replacement becomes active only after close");
  },
);

test("a stale resolution cannot install a bridge once superseded", async () => {
  const coordinator = new BridgeLifecycleCoordinator();

  const staleGeneration = coordinator.beginResolution();
  // A newer resolution starts before the stale one finishes retiring/opening.
  const currentGeneration = coordinator.beginResolution();
  assert.ok(!coordinator.isCurrent(staleGeneration));
  assert.ok(coordinator.isCurrent(currentGeneration));

  // The stale resolution must observe it has been superseded and bail out instead of mutating
  // shared state.
  if (!coordinator.isCurrent(staleGeneration)) {
    // no-op: simulates the stale caller returning early
  } else {
    coordinator.setActive({ dispose() {}, closed: () => Promise.resolve() });
  }
  assert.equal(coordinator.current, undefined);

  const winner = { dispose() {}, closed: () => Promise.resolve() };
  coordinator.setActive(winner);
  assert.equal(coordinator.current, winner);
});

test("clearIfActive only clears the bridge that is still current", () => {
  const coordinator = new BridgeLifecycleCoordinator();
  const first = { dispose() {}, closed: () => Promise.resolve() };
  const second = { dispose() {}, closed: () => Promise.resolve() };

  coordinator.setActive(first);
  coordinator.setActive(second);
  // A dispose callback captured for `first` (e.g. a stale onDidDispose closure) must not clear
  // the bridge that replaced it.
  coordinator.clearIfActive(first);
  assert.equal(coordinator.current, second);

  coordinator.clearIfActive(second);
  assert.equal(coordinator.current, undefined);
});

test("overlapping retire() calls still serialize even when both clear the active bridge", async () => {
  // Regression guard: retireBridge() clears `this.active` synchronously before awaiting, so a
  // second overlapping retire() must still chain onto the first bridge's close rather than
  // finding `active` already undefined and skipping the wait entirely.
  const coordinator = new BridgeLifecycleCoordinator();
  const first = createFakeBridge();
  coordinator.setActive(first.bridge);

  const firstRetire = coordinator.retire();
  const secondRetire = coordinator.retire();

  let bothSettled = false;
  const both = Promise.all([firstRetire, secondRetire]).then(() => {
    bothSettled = true;
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(bothSettled, false);

  first.finishClose();
  await both;
  assert.equal(bothSettled, true);
});
