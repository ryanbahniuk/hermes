import { stdout } from "node:process";
import pc from "picocolors";

const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const CLEAR_LINE = "\r\x1b[K";

const FRAME_MS = 130;
const CAPTION_MS = 1700;

const BODY = "▄▟██▛▜";
const LEG_POSES = ["╱ ╲", "▏ ▕", "╲ ╱", "▏ ▕"];
const OFFSETS = [0, 1, 2, 3, 2, 1];

const CAPTIONS = [
  "wranglin' workers…",
  "saddlin' up…",
  "roundin' up the herd…",
  "gallopin'…",
  "headin' to town…",
  "hitchin' the wagon…",
  "kickin' up dust…",
];

export interface HorseAnimation {
  print(text: string): void;
  stop(): void;
}

function animationEnabled(): boolean {
  if (process.stdout.isTTY !== true) return false;
  const flag = process.env.TACK_NO_ANIM;
  if (flag && flag !== "0" && flag.toLowerCase() !== "false") return false;
  return true;
}

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
      if (!stopped) render();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      stdout.write(CLEAR_LINE + CURSOR_SHOW);
    },
  };
}
