import { AgentRuntimeKind, LaunchResult, RuntimeAdapter, RuntimeCapabilities, Worker } from "../domain/types.js";

function unsupportedLaunch(kind: AgentRuntimeKind): Promise<LaunchResult> {
  return Promise.resolve({
    ok: false,
    error: `Launch not supported for runtime kind: ${kind}`,
  });
}

function noCapabilities(): RuntimeCapabilities {
  return {
    canOpenEditor: false,
    supportsSnapshots: false,
  };
}

export class ClaudeCodeAdapter implements RuntimeAdapter {
  kind: AgentRuntimeKind = "claude-code";
  launch(_worker: Worker): Promise<LaunchResult> { return unsupportedLaunch(this.kind); }
  getCapabilities(): RuntimeCapabilities { return noCapabilities(); }
}

export class OpenClawAdapter implements RuntimeAdapter {
  kind: AgentRuntimeKind = "openclaw";
  launch(_worker: Worker): Promise<LaunchResult> { return unsupportedLaunch(this.kind); }
  getCapabilities(): RuntimeCapabilities { return noCapabilities(); }
}

export class CustomAdapter implements RuntimeAdapter {
  kind: AgentRuntimeKind = "custom";
  launch(_worker: Worker): Promise<LaunchResult> { return unsupportedLaunch(this.kind); }
  getCapabilities(): RuntimeCapabilities { return noCapabilities(); }
}
