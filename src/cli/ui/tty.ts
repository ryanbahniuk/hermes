import pc from "picocolors";

/**
 * The Ink TUIs need a real terminal — Ink enables raw mode on stdin to read
 * keystrokes, which throws when stdin/stdout isn't a TTY (piped, redirected, or
 * CI). Returns true when interactive; otherwise prints guidance and returns
 * false so the caller can bail cleanly instead of crashing mid-render.
 */
export function ensureInteractive(command: string): boolean {
  if (process.stdin.isTTY === true && process.stdout.isTTY === true) return true;
  process.stderr.write(
    pc.yellow(`\`tack ${command}\` is interactive and needs a terminal (a TTY).\n`) +
      pc.dim("Run it directly in your shell — not through a pipe, redirect, or non-interactive runner.\n"),
  );
  return false;
}
