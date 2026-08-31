import { useEffect, useState } from "react";
import { Box, Text } from "ink";

// Two gaits: while idle the horse grazes in place; while work is loading it
// breaks into a gallop that canters across the line via a bobbing offset, with
// a rotating caption alongside.
const FRAME_MS = 160;
const CAPTION_MS = 1700;

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

const CAPTIONS = [
  "wranglin' workers…",
  "saddlin' up…",
  "roundin' up the herd…",
  "gallopin'…",
  "headin' to town…",
  "hitchin' the wagon…",
  "kickin' up dust…",
];

/**
 * A horse that grazes while idle and gallops while loading.
 * @param running when true, the horse gallops with a rotating caption; when
 *   false it stands and grazes.
 */
export function Horse({
  running = true,
  caption,
}: {
  running?: boolean;
  caption?: string;
}): React.ReactElement {
  const [frame, setFrame] = useState(0);
  const [captionIdx, setCaptionIdx] = useState(0);

  useEffect(() => {
    if (!running) return; // grazing is still; no per-frame animation needed
    const timer = setInterval(() => setFrame((f) => f + 1), FRAME_MS);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (!running || caption) return; // idle, or a fixed caption was supplied
    const timer = setInterval(() => setCaptionIdx((i) => i + 1), CAPTION_MS);
    return () => clearInterval(timer);
  }, [running, caption]);

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
  const text = caption ?? CAPTIONS[captionIdx % CAPTIONS.length];

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
