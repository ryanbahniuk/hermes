import { useEffect, useState } from "react";
import { Box, Text } from "ink";

// Two gaits: while idle the horse grazes in place; while work is loading it
// breaks into a gallop that canters across the line via a bobbing offset, with
// a single caption chosen when the gallop starts.
const FRAME_MS = 160;

// Head down, mid-stride — used while loading.
const GALLOP = [
  "            .''",
  "  ._.-.___.' (`\\",
  " //(        ( `'",
  "'/ )\\ ).__. ) ",
  "' <' `\\ ._/'\\",
  "   `   \\     \\",
];

// Head down at the grass by a fence — used while idle/waiting.
const GRAZE = [
  "       _ ____",
  "     /( ) _   \\",
  "    / //   /\\` \\,  ||--||--||-",
  "      \\|   |/  \\|  ||--||--||-",
  "~^~^~^~~^~~~^~~^^~^^^^^^^^^^^^",
];

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
 * A horse that grazes while idle and gallops while loading.
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

  if (!running) {
    return (
      <Box flexDirection="column">
        {GRAZE.map((line, i) => (
          <Text key={i} color="yellow">
            {line}
          </Text>
        ))}
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
      <Text color="yellow" dimColor>
        {pad}
        {"  "}
        {text}
      </Text>
    </Box>
  );
}
