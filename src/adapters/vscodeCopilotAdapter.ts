import { AgentRuntimeKind, LaunchResult, RuntimeAdapter, RuntimeCapabilities, Worker } from "../domain/types.js";
import { WindowManager } from "../services/windowManager.js";

/**
 * Adapter for the VSCode Copilot runtime, wrapping WindowManager.
 */
export class VSCodeCopilotAdapter implements RuntimeAdapter {
  kind: AgentRuntimeKind = "vscode-copilot";

  constructor(private readonly windowManager: WindowManager) {}

  async launch(worker: Worker): Promise<LaunchResult> {
    try {
      const result = this.windowManager.launch(worker.worktreePath);
      return {
        ok: true,
        ...(result.processId !== undefined ? { processId: result.processId } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  getCapabilities(): RuntimeCapabilities {
    return {
      canOpenEditor: true,
      supportsSnapshots: false,
    };
  }
}
