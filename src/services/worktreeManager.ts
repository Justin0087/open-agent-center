import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Project, Worker, WorkerSyncSummary, WorktreeDefinition } from "../domain/types.js";
import { nowIso } from "../utils/ids.js";

const execFileAsync = promisify(execFile);
const GIT_COMMAND = process.env.GIT_COMMAND ?? "git";

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "worker";
}

function createSuffix(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseConflictPaths(stdout: string): string[] {
  const conflicts: string[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const status = line.slice(0, 2);
    const filePath = line.slice(3).trim();
    if (!filePath) {
      continue;
    }

    const normalized = status.trim();
    if (["UU", "AA", "DD", "AU", "UA", "DU", "UD"].includes(normalized)) {
      conflicts.push(filePath);
    }
  }

  return conflicts;
}

function hasDirtyChanges(stdout: string): boolean {
  return stdout.split(/\r?\n/).some((line) => line.trim().length > 0);
}

function resolveDefaultBranch(stdout: string): string {
  const normalized = stdout.trim();
  if (!normalized) {
    return "main";
  }

  const prefix = "refs/remotes/origin/";
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}

export class WorktreeManager {
  async create(project: Project, workerName: string, branchBase?: string): Promise<WorktreeDefinition> {
    const worktreeRoot = `${project.repoPath}.worktrees`;
    const workerSlug = slugify(workerName);
    const branchSlug = slugify(branchBase ?? workerName);
    const suffix = createSuffix();
    const worktreePath = path.join(worktreeRoot, `${workerSlug}-${suffix}`);
    const branchName = `task/${branchSlug}-${suffix}`;

    await mkdir(worktreeRoot, { recursive: true });
    await execFileAsync(GIT_COMMAND, [
      "-C",
      project.repoPath,
      "worktree",
      "add",
      "-b",
      branchName,
      worktreePath,
      project.defaultBranch,
    ]);

    return {
      worktreePath,
      branchName,
      rootPath: worktreeRoot,
    };
  }

  async sync(worker: Worker, targetBranch?: string): Promise<WorkerSyncSummary> {
    const resolvedTargetBranch = targetBranch ?? (await this.getDefaultBranch(worker.worktreePath));
    const { stdout: dirtyStdout } = await execFileAsync(GIT_COMMAND, ["-C", worker.worktreePath, "status", "--short"]);
    const dirty = hasDirtyChanges(dirtyStdout);

    if (dirty) {
      const { stdout: headStdout } = await execFileAsync(GIT_COMMAND, ["-C", worker.worktreePath, "rev-parse", "HEAD"]);
      return {
        workerId: worker.id,
        workerName: worker.name,
        branch: worker.assignedBranch,
        targetBranch: resolvedTargetBranch,
        generatedAt: nowIso(),
        status: "conflicted",
        headSha: headStdout.trim(),
        hasLocalChanges: true,
        conflicts: [],
        summary: "Sync blocked because the worker worktree has local changes.",
      };
    }

    await execFileAsync(GIT_COMMAND, ["-C", worker.worktreePath, "fetch", "origin", resolvedTargetBranch]);

    try {
      await execFileAsync(GIT_COMMAND, [
        "-C",
        worker.worktreePath,
        "merge",
        "--no-edit",
        `origin/${resolvedTargetBranch}`,
      ]);
    } catch {
      const [{ stdout: statusStdout }, { stdout: headStdout }] = await Promise.all([
        execFileAsync(GIT_COMMAND, ["-C", worker.worktreePath, "status", "--short"]),
        execFileAsync(GIT_COMMAND, ["-C", worker.worktreePath, "rev-parse", "HEAD"]),
      ]);
      const conflicts = parseConflictPaths(statusStdout);

      return {
        workerId: worker.id,
        workerName: worker.name,
        branch: worker.assignedBranch,
        targetBranch: resolvedTargetBranch,
        generatedAt: nowIso(),
        status: "conflicted",
        headSha: headStdout.trim(),
        hasLocalChanges: false,
        conflicts,
        summary:
          conflicts.length > 0
            ? `Sync produced ${conflicts.length} merge conflict${conflicts.length === 1 ? "" : "s"}.`
            : "Sync failed while merging the target branch.",
      };
    }

    const { stdout: headStdout } = await execFileAsync(GIT_COMMAND, ["-C", worker.worktreePath, "rev-parse", "HEAD"]);
    return {
      workerId: worker.id,
      workerName: worker.name,
      branch: worker.assignedBranch,
      targetBranch: resolvedTargetBranch,
      generatedAt: nowIso(),
      status: "synced",
      headSha: headStdout.trim(),
      hasLocalChanges: false,
      conflicts: [],
      summary: `Worker branch synced with origin/${resolvedTargetBranch}.`,
    };
  }

  private async getDefaultBranch(worktreePath: string): Promise<string> {
    const { stdout } = await execFileAsync(GIT_COMMAND, [
      "-C",
      worktreePath,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
    ]);

    return resolveDefaultBranch(stdout);
  }
}