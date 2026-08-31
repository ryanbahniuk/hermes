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

// The standard DEC private-mode escapes for the alternate screen buffer — the
// same ones vim/less/htop use. Enter swaps to a blank secondary buffer (also
// clearing it and homing the cursor); leave swaps back, revealing whatever
// scrollback was there before. `?25h` re-shows the cursor in case we exit while
// Ink still had it hidden.
const ENTER_ALT = "\x1b[?1049h\x1b[2J\x1b[H";
const LEAVE_ALT = "\x1b[?1049l\x1b[?25h";
const RESTORE_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

/**
 * Switches the terminal into the alternate screen buffer and returns a `restore`
 * function that switches back. Restoration is wired to run no matter how the
 * process ends — a normal `restore()` call, `process.exit`, or a SIGINT/SIGTERM —
 * so the terminal is never left stuck in the alt buffer with a mangled cursor.
 *
 * `restore` is idempotent; on a signal we restore, detach our handlers, then
 * re-raise the signal so the process still terminates (or Ink still exits
 * gracefully) with the right disposition.
 */
export function enterAltScreen(stream: NodeJS.WriteStream = process.stdout): () => void {
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    stream.write(LEAVE_ALT);
    process.off("exit", onExit);
    for (const sig of RESTORE_SIGNALS) process.off(sig, onSignal);
  };
  const onExit = (): void => restore();
  const onSignal = (sig: NodeJS.Signals): void => {
    restore();
    // Handlers are detached by restore(); re-raising now lets the default
    // disposition (or Ink's own handler) run so the process still exits.
    process.kill(process.pid, sig);
  };

  stream.write(ENTER_ALT);
  process.once("exit", onExit);
  for (const sig of RESTORE_SIGNALS) process.once(sig, onSignal);
  return restore;
}

/**
 * Runs `body` with the terminal in the alternate screen buffer, restoring the
 * previous screen afterwards — on normal return, on a thrown error, and (via
 * {@link enterAltScreen}) on process exit or SIGINT/SIGTERM.
 */
export async function withAltScreen<T>(body: () => Promise<T>): Promise<T> {
  const restore = enterAltScreen();
  try {
    return await body();
  } finally {
    restore();
  }
}
