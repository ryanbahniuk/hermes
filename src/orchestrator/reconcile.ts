import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getSharedContext, listAmendments, listTasks } from "../db";
import { worktreesRoot } from "../worktree/worktree";

/** Short change summary for a worktree (staged + unstaged + untracked). */
function worktreeChanges(worktreePath: string): string {
  if (!existsSync(worktreePath)) return "(no worktree)";
  const r = spawnSync("git", ["-C", worktreePath, "status", "--short"], { encoding: "utf8" });
  const lines = (r.stdout ?? "").split("\n").filter(Boolean);
  return lines.length === 0 ? "(no changes)" : `${lines.length} file(s): ${lines.slice(0, 8).join(", ")}`;
}

/**
 * Deterministic reconcile (step 6): summarize each task's changes against the
 * shared contract and surface any queued amendment proposals. Model-based
 * adjudication of amendments lands in step 7.
 */
export function reconcile(runId: string): string {
  const sc = getSharedContext(runId);
  const tasks = listTasks(runId);
  const amendments = listAmendments(runId);

  const lines: string[] = [];
  lines.push(`--- reconcile ${runId} ---`);
  lines.push(`shared context: ${sc ? `v${sc.version} (by ${sc.authored_by})` : "(none)"}`);

  for (const t of tasks) {
    const changes = worktreeChanges(join(worktreesRoot(runId), t.project_name));
    lines.push(`  ${t.project_name} [${t.status}]: ${changes}`);
  }

  if (amendments.length > 0) {
    lines.push(`amendments proposed: ${amendments.length}`);
    for (const a of amendments) {
      lines.push(`  • [${a.status}] ${a.proposal.replace(/\s+/g, " ").slice(0, 200)}`);
    }
  } else {
    lines.push("amendments proposed: 0");
  }

  return lines.join("\n");
}
