import { useEffect, useState } from "react";
import { Box, Text } from "ink";

// The galloping horse: a body glyph, a cycling leg pose, and a bobbing
// horizontal offset so it canters across the line. Ported from the old
// stdout-frame animation into a self-contained Ink component.
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

/** A looping galloping-horse spinner with a rotating caption. */
export function Horse({ caption }: { caption?: string }): React.ReactElement {
  const [frame, setFrame] = useState(0);
  const [captionIdx, setCaptionIdx] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => f + 1), FRAME_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (caption) return; // a fixed caption was supplied; don't rotate
    const timer = setInterval(() => setCaptionIdx((i) => i + 1), CAPTION_MS);
    return () => clearInterval(timer);
  }, [caption]);

  const legs = LEG_POSES[frame % LEG_POSES.length];
  const pad = " ".repeat(OFFSETS[frame % OFFSETS.length]);
  const text = caption ?? CAPTIONS[captionIdx % CAPTIONS.length];

  return (
    <Box>
      <Text color="yellow">
        {pad}
        {BODY} {legs}
      </Text>
      <Text> </Text>
      <Text color="yellow" dimColor>
        {text}
      </Text>
    </Box>
  );
}
