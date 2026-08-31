import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Repo-provided guidance files a worker should follow, in the order shown. */
export const GUIDANCE_FILES = ["CLAUDE.md", "AGENTS.md"] as const;

/**
 * Reads the repo's own guidance files (`CLAUDE.md`, `AGENTS.md`) from the worktree
 * root and formats them into a single block for the worker prompt. This is how a
 * repo delegates its conventions to Tack's agents: whatever the repo already
 * documents for its human contributors, the worker sees too — identically across
 * both runtimes, since we read the files ourselves rather than relying on any one
 * SDK's settings loader (the `claude` runtime runs with `settingSources: []`).
 *
 * Files are read from the worktree (a checkout off the project's HEAD), so the
 * guidance reflects the committed branch state. Returns an empty string when the
 * repo carries neither file, which drops the `{{#if repoGuidance}}` prompt block.
 */
export function repoGuidance(worktree: string): string {
  const sections: string[] = [];
  for (const name of GUIDANCE_FILES) {
    let content: string;
    try {
      content = readFileSync(join(worktree, name), "utf8").trim();
    } catch {
      continue; // absent or unreadable — skip it
    }
    if (content) sections.push(`=== ${name} ===\n${content}`);
  }
  return sections.join("\n\n");
}
