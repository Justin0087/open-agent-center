import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Project, TaskIntegrationSummary, Worker, WorkerSyncSummary, WorktreeDefinition } from "../domain/types.js";
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

function parseRemoteHeadBranch(stdout: string): string | undefined {
  const line = stdout
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith("HEAD branch:"));

  if (!line) {
    return undefined;
  }

  const value = line.split(":", 2)[1]?.trim();
  return value || undefined;
}

function resolveRepoPath(commonDir: string): string {
  if (path.basename(commonDir).toLowerCase() === ".git") {
    return path.dirname(commonDir);
  }

  return path.resolve(commonDir, "..");
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

  async integrate(worker: Worker, targetBranch?: string): Promise<TaskIntegrationSummary> {
    const resolvedTargetBranch = targetBranch ?? (await this.getDefaultBranch(worker.worktreePath));
    const repoPath = await this.getRepoPath(worker.worktreePath);

    await execFileAsync(GIT_COMMAND, ["-C", repoPath, "fetch", "origin", resolvedTargetBranch]);

    const [{ stdout: headStdout }, { stdout: branchStdout }, { stdout: dirtyStdout }] = await Promise.all([
      execFileAsync(GIT_COMMAND, ["-C", repoPath, "rev-parse", "HEAD"]),
      execFileAsync(GIT_COMMAND, ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"]),
      execFileAsync(GIT_COMMAND, ["-C", repoPath, "status", "--short"]),
    ]);

    const headSha = headStdout.trim();
    const currentBranch = branchStdout.trim();
    const dirty = hasDirtyChanges(dirtyStdout);

    if (dirty) {
      return {
        workerId: worker.id,
        workerName: worker.name,
        sourceBranch: worker.assignedBranch,
        targetBranch: resolvedTargetBranch,
        repoPath,
        generatedAt: nowIso(),
        status: "blocked",
        headSha,
        hasLocalChanges: true,
        conflicts: [],
        summary: `Integration blocked because ${resolvedTargetBranch} has local changes in ${repoPath}.`,
      };
    }

    if (currentBranch !== resolvedTargetBranch) {
      return {
        workerId: worker.id,
        workerName: worker.name,
        sourceBranch: worker.assignedBranch,
        targetBranch: resolvedTargetBranch,
        repoPath,
        generatedAt: nowIso(),
        status: "blocked",
        headSha,
        hasLocalChanges: false,
        conflicts: [],
        summary: `Integration blocked because ${repoPath} is currently on ${currentBranch}, not ${resolvedTargetBranch}.`,
      };
    }

    try {
      await execFileAsync(GIT_COMMAND, ["-C", repoPath, "merge", "--ff-only", `origin/${resolvedTargetBranch}`]);
    } catch {
      const { stdout: currentHeadStdout } = await execFileAsync(GIT_COMMAND, ["-C", repoPath, "rev-parse", "HEAD"]);
      return {
        workerId: worker.id,
        workerName: worker.name,
        sourceBranch: worker.assignedBranch,
        targetBranch: resolvedTargetBranch,
        repoPath,
        generatedAt: nowIso(),
        status: "blocked",
        headSha: currentHeadStdout.trim(),
        hasLocalChanges: false,
        conflicts: [],
        summary: `Integration blocked because ${resolvedTargetBranch} could not be fast-forwarded to origin/${resolvedTargetBranch}.`,
      };
    }

    try {
      await execFileAsync(GIT_COMMAND, ["-C", repoPath, "merge", "--no-edit", worker.assignedBranch]);
    } catch {
      const [{ stdout: statusStdout }, { stdout: currentHeadStdout }] = await Promise.all([
        execFileAsync(GIT_COMMAND, ["-C", repoPath, "status", "--short"]),
        execFileAsync(GIT_COMMAND, ["-C", repoPath, "rev-parse", "HEAD"]),
      ]);
      const conflicts = parseConflictPaths(statusStdout);

      return {
        workerId: worker.id,
        workerName: worker.name,
        sourceBranch: worker.assignedBranch,
        targetBranch: resolvedTargetBranch,
        repoPath,
        generatedAt: nowIso(),
        status: "conflicted",
        headSha: currentHeadStdout.trim(),
        hasLocalChanges: true,
        conflicts,
        summary:
          conflicts.length > 0
            ? `Integration produced ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} on ${resolvedTargetBranch}.`
            : `Integration failed while merging ${worker.assignedBranch} into ${resolvedTargetBranch}.`,
      };
    }

    const { stdout: mergedHeadStdout } = await execFileAsync(GIT_COMMAND, ["-C", repoPath, "rev-parse", "HEAD"]);
    return {
      workerId: worker.id,
      workerName: worker.name,
      sourceBranch: worker.assignedBranch,
      targetBranch: resolvedTargetBranch,
      repoPath,
      generatedAt: nowIso(),
      status: "integrated",
      headSha: mergedHeadStdout.trim(),
      hasLocalChanges: false,
      conflicts: [],
      summary: `Integrated ${worker.assignedBranch} into ${resolvedTargetBranch} at ${mergedHeadStdout.trim()}.`,
    };
  }

  private async getDefaultBranch(worktreePath: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(GIT_COMMAND, [
        "-C",
        worktreePath,
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
      ]);

      return resolveDefaultBranch(stdout);
    } catch {
      try {
        const { stdout } = await execFileAsync(GIT_COMMAND, ["-C", worktreePath, "remote", "show", "origin"]);
        const remoteHeadBranch = parseRemoteHeadBranch(stdout);
        if (remoteHeadBranch) {
          return remoteHeadBranch;
        }
      } catch {
        // Fall through to local branch heuristics.
      }

      try {
        await execFileAsync(GIT_COMMAND, ["-C", worktreePath, "show-ref", "--verify", "refs/heads/main"]);
        return "main";
      } catch {
        // Ignore and continue.
      }

      try {
        await execFileAsync(GIT_COMMAND, ["-C", worktreePath, "show-ref", "--verify", "refs/heads/master"]);
        return "master";
      } catch {
        // Ignore and continue.
      }

      const { stdout: currentBranchStdout } = await execFileAsync(GIT_COMMAND, [
        "-C",
        worktreePath,
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]);
      return currentBranchStdout.trim() || "main";
    }
  }

  private async getRepoPath(worktreePath: string): Promise<string> {
    const { stdout } = await execFileAsync(GIT_COMMAND, ["-C", worktreePath, "rev-parse", "--git-common-dir"]);
    return resolveRepoPath(path.resolve(worktreePath, stdout.trim()));
  }
}