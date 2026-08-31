import { useState } from "react";
import { Box, Text, useInput } from "ink";

interface PromptProps {
  /** Called with the submitted line (may be empty). The buffer is cleared. */
  onSubmit: (value: string) => void;
  /** When false, the input is inert and shows a dim placeholder. */
  isActive?: boolean;
  /** Leading label, e.g. `you › `. */
  label?: string;
  placeholder?: string;
}

/**
 * A minimal single-line text input with a block cursor. Self-contained: it owns
 * its buffer and clears on submit, so callers only handle finished lines. Built
 * on Ink's `useInput` to avoid pulling in an external text-input dependency.
 */
export function Prompt({
  onSubmit,
  isActive = true,
  label = "you › ",
  placeholder = "",
}: PromptProps): React.ReactElement {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);

  useInput(
    (input, key) => {
      if (key.return) {
        const submitted = value;
        setValue("");
        setCursor(0);
        onSubmit(submitted);
        return;
      }
      if (key.escape) return; // reserved for the parent view
      if (key.leftArrow) return void setCursor((c) => Math.max(0, c - 1));
      if (key.rightArrow) return void setCursor((c) => Math.min(value.length, c + 1));
      if (key.backspace || input === "\x7f") {
        if (cursor === 0) return;
        setValue(value.slice(0, cursor - 1) + value.slice(cursor));
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.delete) {
        setValue(value.slice(0, cursor) + value.slice(cursor + 1));
        return;
      }
      // Ctrl-A / Ctrl-E: jump to start / end (common readline muscle memory).
      if (key.ctrl && input === "a") return void setCursor(0);
      if (key.ctrl && input === "e") return void setCursor(value.length);
      if (key.ctrl || key.meta || key.tab) return; // ignore other chords
      if (input) {
        setValue(value.slice(0, cursor) + input + value.slice(cursor));
        setCursor((c) => c + input.length);
      }
    },
    { isActive },
  );

  if (!isActive) {
    return (
      <Box>
        <Text dimColor>{label}</Text>
        <Text dimColor>{value || placeholder}</Text>
      </Box>
    );
  }

  const before = value.slice(0, cursor);
  const at = value[cursor] ?? " ";
  const after = value.slice(cursor + 1);

  return (
    <Box>
      <Text color="cyan">{label}</Text>
      {value.length === 0 && placeholder ? (
        <Text>
          <Text inverse>{placeholder[0]}</Text>
          <Text dimColor>{placeholder.slice(1)}</Text>
        </Text>
      ) : (
        <Text>
          {before}
          <Text inverse>{at}</Text>
          {after}
        </Text>
      )}
    </Box>
  );
}
