import { spawn } from "node:child_process";

const VSCODE_COMMAND = process.env.VSCODE_COMMAND ?? "code";

export class WindowManager {
  launch(worktreePath: string): { processId?: number } {
    const child = spawn(VSCODE_COMMAND, ["-n", worktreePath], {
      detached: true,
      stdio: "ignore",
    });

    child.unref();

    if (child.pid === undefined) {
      return {};
    }

    return {
      processId: child.pid,
    };
  }
}
