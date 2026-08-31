import { stdout } from "node:process";
import pc from "picocolors";

/**
 * A self-contained, frame-based ANSI loading animation: a pixelated horse
 * galloping on a single terminal line with rotating western captions.
 *
 * Deliberately NOT ink — the planner REPL (`chat.ts`) is a raw readline +
 * stdout.write loop, so this animator speaks the same low-level dialect:
 * carriage-return + clear-to-EOL redraws that never scroll, plus cursor
 * hide/restore. It yields cleanly to streamed output via `print()`, which
 * clears the live line, emits a transcript line, then lets the horse gallop
 * back on the fresh bottom line.
 */

const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const CLEAR_LINE = "\r\x1b[K"; // carriage return + clear to end of line

const FRAME_MS = 130; // gallop cadence
const CAPTION_MS = 1700; // caption rotates slower than the legs

/**
 * Compact single-line pixelated horse. Body/head hold steady while the legs
 * cycle through gallop poses, and a small horizontal offset makes it read as
 * moving across the line. Block/box glyphs keep it legible in any terminal.
 */
const BODY = "▄▟██▛▜"; // tail → body → neck/head, facing right
const LEG_POSES = ["╱ ╲", "▏ ▕", "╲ ╱", "▏ ▕"]; // splayed → gathered → splayed
const OFFSETS = [0, 1, 2, 3, 2, 1]; // gentle gallop-across bob

const CAPTIONS = [
  "wranglin' workers…",
  "saddlin' up…",
  "roundin' up the herd…",
  "gallopin'…",
  "headin' to town…",
  "hitchin' the wagon…",
  "kickin' up dust…",
];

/** The controller returned by {@link startHorseAnimation}. */
export interface HorseAnimation {
  /**
   * Emit a transcript line above the animation without artifacts: clears the
   * live animation line, writes `text` followed by a newline, then repaints the
   * horse on the new bottom line so it stays continuously visible.
   */
  print(text: string): void;
  /**
   * Stop the animation: clears the interval, wipes the animation line, and
   * restores the cursor. Safe to call multiple times.
   */
  stop(): void;
}

/** Whether the animation should run at all (TTY + not explicitly disabled). */
function animationEnabled(): boolean {
  if (process.stdout.isTTY !== true) return false;
  const flag = process.env.TACK_NO_ANIM;
  if (flag && flag !== "0" && flag.toLowerCase() !== "false") return false;
  return true;
}

/**
 * Start the galloping-horse animation. On a non-TTY stdout or when
 * `TACK_NO_ANIM` is truthy this no-ops: `print()` writes lines exactly as the
 * REPL would without any animation, and no escape sequences are emitted.
 */
export function startHorseAnimation(): HorseAnimation {
  if (!animationEnabled()) {
    return {
      print: (text) => void stdout.write(text + "\n"),
      stop: () => {},
    };
  }

  let frame = 0;
  let elapsed = 0;
  let captionIdx = 0;
  let stopped = false;

  const render = (): void => {
    const legs = LEG_POSES[frame % LEG_POSES.length];
    const pad = " ".repeat(OFFSETS[frame % OFFSETS.length]);
    const horse = pc.yellow(`${pad}${BODY} ${legs}`);
    const caption = pc.dim(pc.yellow(CAPTIONS[captionIdx % CAPTIONS.length]));
    stdout.write(`${CLEAR_LINE}${horse}  ${caption}`);
  };

  const tick = (): void => {
    frame++;
    elapsed += FRAME_MS;
    if (elapsed >= CAPTION_MS) {
      elapsed = 0;
      captionIdx++;
    }
    render();
  };

  stdout.write(CURSOR_HIDE);
  render();
  const timer = setInterval(tick, FRAME_MS);

  return {
    print(text: string): void {
      stdout.write(CLEAR_LINE + text + "\n");
      if (!stopped) render(); // repaint the horse on the fresh bottom line
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      stdout.write(CLEAR_LINE + CURSOR_SHOW);
    },
  };
}
