/**
 * Coordinates replacing a `HostBridge`-like resource across overlapping `resolveWebviewView`
 * calls. VS Code can invoke `resolveWebviewView` again before a prior resolution has finished
 * (for example when the Activity Bar view is hidden and shown in quick succession), and a
 * bridge's teardown (`canvas close`) is asynchronous. Without coordination:
 *
 * - A late `canvas close` from the retired bridge can finish after the replacement bridge has
 *   already issued its own `canvas open` for the same session/instance, tearing down the
 *   replacement.
 * - A stale, still-in-flight resolution can finish after a newer one and clobber state (the
 *   active bridge/view) that the newer resolution already owns.
 *
 * This coordinator is intentionally free of any `vscode` dependency so it can be unit tested
 * without the VS Code test harness.
 */
export interface RetiringBridge {
  dispose(): void;
  /** Resolves once this bridge's asynchronous teardown (e.g. `canvas close`) has settled. */
  closed(): Promise<void>;
}

export class BridgeLifecycleCoordinator<TBridge extends RetiringBridge> {
  private generation = 0;
  private closing: Promise<void> = Promise.resolve();
  private active: TBridge | undefined;

  get current(): TBridge | undefined {
    return this.active;
  }

  /**
   * Call at the start of a new resolution. Returns a generation token; check it with
   * `isCurrent` after each await to detect that a newer resolution has since started.
   */
  beginResolution(): number {
    return ++this.generation;
  }

  /** Invalidates any in-flight resolution without starting a new one (e.g. on dispose). */
  invalidate(): void {
    this.generation += 1;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  setActive(bridge: TBridge): void {
    this.active = bridge;
  }

  /** Clears the active bridge only if it is still the one passed in (guards stale callbacks). */
  clearIfActive(bridge: TBridge): void {
    if (this.active === bridge) {
      this.active = undefined;
    }
  }

  /**
   * Retires the currently active bridge (if any) and waits for its teardown to finish. Chains
   * onto any previous retirement so overlapping calls still serialize: a bridge is only disposed
   * and awaited after everything retired before it has fully closed.
   */
  async retire(): Promise<void> {
    const bridge = this.active;
    this.active = undefined;
    const previousClosing = this.closing;
    const closeThis = async () => {
      await previousClosing;
      if (bridge) {
        bridge.dispose();
        await bridge.closed();
      }
    };
    const closing = closeThis();
    this.closing = closing;
    await closing;
  }
}
