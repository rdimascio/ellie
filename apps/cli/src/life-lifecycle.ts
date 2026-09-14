export class EmbeddedLifeLifecycle<T extends { close(): Promise<void> | void }> {
  private startup: Promise<void> | undefined;
  private value: T | undefined;
  private close: Promise<void> | undefined;
  private stopping = false;

  start(factory: () => Promise<T>, activate: (value: T) => Promise<void> | void): Promise<void> {
    if (this.startup || this.stopping) throw new Error("Embedded Life startup is unavailable.");
    this.startup = (async () => {
      const value = await factory();
      this.value = value;
      if (this.stopping) await this.closeValue();
      else await activate(value);
    })();
    return this.startup;
  }

  async shutdown(releaseCoordinator: () => void): Promise<void> {
    this.stopping = true;
    try {
      await this.startup;
    } catch {
      // Startup failure is reported by start(). If a value was created, it is
      // still owned here and must drain before the coordinator lock is released.
    }
    await this.closeValue();
    releaseCoordinator();
  }

  private closeValue(): Promise<void> {
    if (!this.value) return Promise.resolve();
    if (!this.close) {
      const value = this.value;
      this.close = Promise.resolve()
        .then(() => value.close())
        .then(() => {
          if (this.value === value) this.value = undefined;
        });
    }
    return this.close;
  }
}
