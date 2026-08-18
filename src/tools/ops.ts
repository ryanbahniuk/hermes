import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** The filesystem boundary an agent operates within. */
export interface Scoping {
  worktree: string;
  readAllowlist: string[];
}

const MAX_OUTPUT = 20_000;

function truncate(s: string): string {
  return s.length > MAX_OUTPUT
    ? `${s.slice(0, MAX_OUTPUT)}\n…[truncated ${s.length - MAX_OUTPUT} chars]`
    : s;
}

/** True if `target` is inside (or equal to) `dir`. */
function within(dir: string, target: string): boolean {
  const rel = relative(resolve(dir), target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolvePath(scoping: Scoping, p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(scoping.worktree, p);
}

export function assertReadable(scoping: Scoping, p: string): string {
  const abs = resolvePath(scoping, p);
  const ok =
    within(scoping.worktree, abs) ||
    scoping.readAllowlist.some((d) => within(d, abs));
  if (!ok) throw new Error(`read denied: "${p}" is outside the worktree and read allowlist`);
  return abs;
}

export function assertWritable(scoping: Scoping, p: string): string {
  const abs = resolvePath(scoping, p);
  if (!within(scoping.worktree, abs)) {
    throw new Error(`write denied: "${p}" is outside the worktree`);
  }
  return abs;
}

export function opRead(scoping: Scoping, path: string): string {
  const abs = assertReadable(scoping, path);
  if (!existsSync(abs)) throw new Error(`no such file: ${path}`);
  return truncate(readFileSync(abs, "utf8"));
}

export function opWrite(scoping: Scoping, path: string, content: string): string {
  const abs = assertWritable(scoping, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return `wrote ${content.length} bytes to ${path}`;
}

export function opEdit(scoping: Scoping, path: string, find: string, replace: string): string {
  const abs = assertWritable(scoping, path);
  if (!existsSync(abs)) throw new Error(`no such file: ${path}`);
  const before = readFileSync(abs, "utf8");
  const count = before.split(find).length - 1;
  if (count === 0) throw new Error(`"find" text not found in ${path}`);
  if (count > 1) throw new Error(`"find" text appears ${count} times in ${path}; make it unique`);
  writeFileSync(abs, before.replace(find, replace));
  return `edited ${path}`;
}

function runCommand(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw r.error;
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return truncate(`$ ${cmd} ${args.join(" ")}\n[exit ${r.status ?? 0}]\n${out}`);
}

export function opSearch(scoping: Scoping, pattern: string, path?: string): string {
  const target = path ? assertReadable(scoping, path) : scoping.worktree;
  const rg = Bun.which("rg");
  if (rg) {
    return runCommand(rg, ["-n", "--no-heading", "--color=never", pattern, target], scoping.worktree);
  }
  // Fallback when ripgrep isn't installed / on PATH.
  return runCommand("grep", ["-rIn", "-E", "--", pattern, target], scoping.worktree);
}

/** NOTE: shell is trusted — it can read outside the allowlist (documented caveat). */
export function opShell(scoping: Scoping, command: string): string {
  return runCommand("bash", ["-lc", command], scoping.worktree);
}

export function opGit(scoping: Scoping, args: string[]): string {
  return runCommand("git", args, scoping.worktree);
}
