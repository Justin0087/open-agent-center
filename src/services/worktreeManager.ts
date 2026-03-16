import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Project, WorktreeDefinition } from "../domain/types.js";

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
}