import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { useTerminalSize } from "./useTerminalSize";

// Two gaits: while idle the horse grazes in place; while work is loading it
// breaks into a gallop that canters across the line via a bobbing offset, with
// a single caption chosen when the gallop starts.
const FRAME_MS = 160;

// The silhouettes below are the horse BODY only. The ground it stands on is a
// separate full-width grass line (see GRASS_UNIT / grassLine), rendered beneath
// the body so it can span the whole terminal instead of a fixed-width stub.

// Head down, mid-stride — used while loading.
const GALLOP = [
  "            .''",
  "  ._.-.___.' (`\\",
  " //(        ( `'",
  "'/ )\\ ).__. ) ",
  "' <' `\\ ._/'\\",
  "   `   \\     \\",
];

// Head down at the grass by a fence. The fence stands to the LEFT of the horse,
// with the horse body grazing to its right.
export const GRAZE = [
  "                _ ____",
  "              /( ) _   \\,",
  "||--||--||-  / //   /\\` \\,",
  "||--||--||-    \\|   |/  \\|",
];

// One tile of ground; grassLine repeats it to fill the terminal width.
export const GRASS_UNIT = "~^";

/**
 * The grass ground line, tiled to exactly `width` columns (never wider, so it
 * can't wrap and jitter on resize). A width of 0 or less yields an empty line.
 */
export function grassLine(width: number, unit: string = GRASS_UNIT): string {
  if (width <= 0 || unit.length === 0) return "";
  return unit.repeat(Math.ceil(width / unit.length)).slice(0, width);
}

const OFFSETS = [0, 1, 2, 3, 2, 1];

// One is chosen at random each time the horse breaks into a gallop; exported so
// tests can assert the roster's size and tone.
export const CAPTIONS = [
  "wranglin' workers…",
  "saddlin' up…",
  "roundin' up the herd…",
  "gallopin'…",
  "headin' to town…",
  "hitchin' the wagon…",
  "kickin' up dust…",
  "brandin' the calves…",
  "mendin' the fences…",
  "waterin' the horses…",
  "lassoin' strays…",
  "crossin' the river…",
  "ridin' the range…",
  "chasin' the sunset…",
  "spurrin' onward…",
  "trailin' the herd…",
  "breakin' broncos…",
  "cinchin' the saddle…",
  "loadin' the six-shooter…",
  "wettin' the whistle…",
  "polishin' the boots…",
  "tippin' the ten-gallon…",
  "wanderin' the prairie…",
  "corralin' the cattle…",
  "shoein' the mare…",
  "diggin' for gold…",
  "pannin' the creek…",
  "settlin' the frontier…",
  "rustlin' up grub…",
  "stokin' the campfire…",
  "whittlin' by the fire…",
  "moseyin' along…",
];

/**
 * A horse that grazes while idle and gallops while loading. In both gaits it
 * stands on a full-width grass line so the ground spans the terminal.
 * @param running when true, the horse gallops with a single caption chosen when
 *   the gallop starts; when false it stands and grazes.
 * @param caption when supplied, overrides the random caption for the gallop.
 */
export function Horse({
  running = true,
  caption,
}: {
  running?: boolean;
  caption?: string;
}): React.ReactElement {
  const { columns } = useTerminalSize();
  const [frame, setFrame] = useState(0);
  // Index into CAPTIONS, re-rolled each time the horse breaks into a gallop.
  const [captionIdx, setCaptionIdx] = useState(() =>
    Math.floor(Math.random() * CAPTIONS.length),
  );

  useEffect(() => {
    if (!running) return; // grazing is still; no per-frame animation needed
    // Pick one caption for the whole gallop (unless overridden by the prop).
    setCaptionIdx(Math.floor(Math.random() * CAPTIONS.length));
    const timer = setInterval(() => setFrame((f) => f + 1), FRAME_MS);
    return () => clearInterval(timer);
  }, [running]);

  // The ground is fixed to the terminal width and never bobs with the gait.
  const grass = grassLine(columns);

  if (!running) {
    return (
      <Box flexDirection="column">
        {GRAZE.map((line, i) => (
          <Text key={i} color="yellow">
            {line}
          </Text>
        ))}
        <Text color="yellow" wrap="truncate">
          {grass}
        </Text>
        <Text color="yellow" dimColor>
          {"  "}grazin'…
        </Text>
      </Box>
    );
  }

  const pad = " ".repeat(OFFSETS[frame % OFFSETS.length]);
  const text = caption ?? CAPTIONS[captionIdx];

  return (
    <Box flexDirection="column">
      {GALLOP.map((line, i) => (
        <Text key={i} color="yellow">
          {pad}
          {line}
        </Text>
      ))}
      <Text color="yellow" wrap="truncate">
        {grass}
      </Text>
      <Text color="yellow" dimColor>
        {pad}
        {"  "}
        {text}
      </Text>
    </Box>
  );
}
