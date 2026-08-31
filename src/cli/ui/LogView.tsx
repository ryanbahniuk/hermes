import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { getRun, listTasks, type RunRow, type TaskRow } from "../../db";
import { runLogFile, readLog } from "../../logging/logs";
import { runLive, statusColor, usd } from "./theme";

/** How many trailing log lines to keep on screen (a rough terminal-height budget). */
function viewportRows(): number {
  const rows = process.stdout.rows ?? 40;
  return Math.max(8, rows - 12);
}

export interface LogViewProps {
  runId: string;
  /** Called on Esc / q — pops back to the caller (dashboard). */
  onExit: () => void;
}

/**
 * A read-only, auto-following view of one run's execution: its live status, the
 * per-project task strip, and the tail of the supervisor log. Polls on an
 * interval — this view never writes, so it's safe to open on any run.
 */
export function LogView({ runId, onExit }: LogViewProps): React.ReactElement {
  const [run, setRun] = useState<RunRow | undefined>(() => getRun(runId));
  const [tasks, setTasks] = useState<TaskRow[]>(() => listTasks(runId));
  const [tail, setTail] = useState<string[]>([]);

  useInput((input, key) => {
    if (key.escape || input === "q") onExit();
  });

  useEffect(() => {
    const file = runLogFile(runId);
    const rows = viewportRows();
    const tick = () => {
      setRun(getRun(runId));
      setTasks(listTasks(runId));
      const lines = readLog(file).split("\n");
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      setTail(lines.slice(-rows));
    };
    tick();
    const interval = setInterval(tick, 400);
    return () => clearInterval(interval);
  }, [runId]);

  if (!run) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">No such run: {runId}</Text>
        <Text dimColor>press q or Esc to go back</Text>
      </Box>
    );
  }

  const live = runLive(run);

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text color={live.color} dimColor={live.dim}>
          ●{" "}
        </Text>
        <Text bold>{run.id}</Text>
        <Text> </Text>
        <Text color={live.color} dimColor={live.dim}>
          {live.label}
        </Text>
        <Text dimColor>{"  " + usd(run.cost)}</Text>
      </Box>
      <Text dimColor>{run.problem.slice(0, 100)}</Text>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>tasks ({tasks.length}):</Text>
        {tasks.length === 0 && <Text dimColor>{"  (none yet)"}</Text>}
        {tasks.map((t) => (
          <Text key={t.id}>
            {"  "}
            {t.project_name} <Text color={statusColor(t.status)}>{t.status}</Text>{" "}
            <Text dimColor>
              {(t.runtime ?? "-") + " " + usd(t.cost)}
            </Text>
          </Text>
        ))}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>── run log ──</Text>
        {tail.length === 0 && <Text dimColor>{"  (empty)"}</Text>}
        {tail.map((l, i) => (
          <Text key={i} wrap="truncate-end">
            {l}
          </Text>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>following · press q or Esc to go back</Text>
      </Box>
    </Box>
  );
}
