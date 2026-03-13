import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Worker, WorkerDiffFile, WorkerDiffSummary } from "../domain/types.js";
import { nowIso } from "../utils/ids.js";

const execFileAsync = promisify(execFile);
const GIT_COMMAND = process.env.GIT_COMMAND ?? "git";

function parseStatusEntries(stdout: string): Map<string, string> {
  const entries = new Map<string, string>();

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const status = line.slice(0, 2).trim() || "??";
    const filePath = line.slice(3).trim();
    if (!filePath) {
      continue;
    }

    entries.set(filePath, status);
  }

  return entries;
}

function parseNumStat(stdout: string): Map<string, { additions: number; deletions: number }> {
  const entries = new Map<string, { additions: number; deletions: number }>();

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const [additionsText, deletionsText, ...pathParts] = line.split("\t");
    const filePath = pathParts.join("\t").trim();
    if (!filePath) {
      continue;
    }

    const additions = additionsText === "-" ? 0 : Number(additionsText);
    const deletions = deletionsText === "-" ? 0 : Number(deletionsText);

    entries.set(filePath, {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    });
  }

  return entries;
}

function buildSummary(files: WorkerDiffFile[]): string {
  if (files.length === 0) {
    return "No local changes detected.";
  }

  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const untracked = files.filter((file) => file.status === "??").length;

  const segments = [`${files.length} changed file${files.length === 1 ? "" : "s"}`];
  if (additions > 0) {
    segments.push(`${additions} addition${additions === 1 ? "" : "s"}`);
  }
  if (deletions > 0) {
    segments.push(`${deletions} deletion${deletions === 1 ? "" : "s"}`);
  }
  if (untracked > 0) {
    segments.push(`${untracked} untracked`);
  }

  return segments.join(", ");
}

export class DiffService {
  async getWorkerDiff(worker: Worker): Promise<WorkerDiffSummary> {
    const [{ stdout: statusStdout }, { stdout: numStatStdout }] = await Promise.all([
      execFileAsync(GIT_COMMAND, ["-C", worker.worktreePath, "status", "--short"]),
      execFileAsync(GIT_COMMAND, ["-C", worker.worktreePath, "diff", "HEAD", "--numstat"]),
    ]);

    const statusEntries = parseStatusEntries(statusStdout);
    const numStatEntries = parseNumStat(numStatStdout);
    const allPaths = new Set([...statusEntries.keys(), ...numStatEntries.keys()]);

    const files = [...allPaths]
      .sort((left, right) => left.localeCompare(right))
      .map<WorkerDiffFile>((filePath) => {
        const stats = numStatEntries.get(filePath);
        return {
          path: filePath,
          status: statusEntries.get(filePath) ?? "M",
          additions: stats?.additions ?? 0,
          deletions: stats?.deletions ?? 0,
        };
      });

    const totals = files.reduce(
      (accumulator, file) => ({
        filesChanged: accumulator.filesChanged + 1,
        additions: accumulator.additions + file.additions,
        deletions: accumulator.deletions + file.deletions,
      }),
      { filesChanged: 0, additions: 0, deletions: 0 },
    );

    return {
      workerId: worker.id,
      workerName: worker.name,
      branch: worker.assignedBranch,
      worktreePath: worker.worktreePath,
      generatedAt: nowIso(),
      hasChanges: files.length > 0,
      totals,
      files,
      summary: buildSummary(files),
    };
  }
}