import { useEffect, useState } from "react";
import { useStdout } from "ink";

export interface TerminalSize {
  columns: number;
  rows: number;
}

/**
 * The current terminal viewport size, re-read on every resize. Ink recalculates
 * its own layout on resize but does not re-run components (no state changes), so
 * anything that reads `stdout.columns/rows` during render — full-width rules,
 * tiled grass, a fullscreen bottom-pinned layout — needs this hook to re-render.
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => ({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  }));

  useEffect(() => {
    if (!stdout) return;
    const onResize = () =>
      setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    onResize(); // sync once in case the size changed before the listener attached
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}
