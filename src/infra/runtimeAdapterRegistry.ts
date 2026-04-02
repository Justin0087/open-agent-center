import { AgentRuntimeKind, RuntimeAdapter, RuntimeCapabilities } from "../domain/types.js";

/**
 * Registry for runtime adapters, keyed by AgentRuntimeKind.
 */
export class RuntimeAdapterRegistry {
  private adapters: Map<AgentRuntimeKind, RuntimeAdapter> = new Map();

  register(adapter: RuntimeAdapter): void {
    this.adapters.set(adapter.kind, adapter);
  }

  resolve(kind: AgentRuntimeKind): RuntimeAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) {
      throw new Error(`No runtime adapter registered for kind: ${kind}`);
    }
    return adapter;
  }

  getCapabilitiesFor(kind: AgentRuntimeKind): RuntimeCapabilities | undefined {
    const adapter = this.adapters.get(kind);
    return adapter?.getCapabilities ? adapter.getCapabilities() : undefined;
  }

  listKinds(): AgentRuntimeKind[] {
    return Array.from(this.adapters.keys());
  }
}
