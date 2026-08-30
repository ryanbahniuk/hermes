import { useEffect, useState } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import { db, listRuns, listTasks, type RunRow, type TaskRow } from "../db";
import { isAlive } from "../process/spawn";

function statusColor(status: string): string {
  if (status === "done") return "green";
  if (status === "failed") return "red";
  if (status === "stalled") return "yellow";
  if (status === "pending") return "gray";
  return "cyan";
}

function Dashboard() {
  const { exit } = useApp();
  useInput(
    (input) => {
      if (input === "q") exit();
    },
    { isActive: process.stdin.isTTY === true },
  );

  const [runs, setRuns] = useState<RunRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);

  useEffect(() => {
    const tick = () => {
      setRuns(listRuns().slice(0, 12));
      setTasks(listTasks());
    };
    tick();
    const interval = setInterval(tick, 500);
    return () => clearInterval(interval);
  }, []);

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Tack — live dashboard</Text>
      {runs.length === 0 && <Text dimColor>No runs yet.</Text>}
      {runs.map((r) => {
        const runTasks = tasks.filter((t) => t.run_id === r.id);
        const terminal = r.status === "done" || r.status === "failed";
        const live = terminal ? r.status : isAlive(r.supervisor_pid) ? "running" : "stalled";
        return (
          <Box key={r.id} flexDirection="column" marginTop={1}>
            <Text>
              <Text color={statusColor(live)}>●</Text> <Text bold>{r.id}</Text>{" "}
              <Text color={statusColor(r.status)}>{r.status}</Text>{" "}
              <Text dimColor>${r.cost.toFixed(4)}</Text> <Text dimColor>{r.problem.slice(0, 48)}</Text>
            </Text>
            {runTasks.map((t) => (
              <Text key={t.id}>
                {"   "}
                {t.project_name} <Text color={statusColor(t.status)}>{t.status}</Text>{" "}
                <Text dimColor>
                  {t.runtime ?? "-"} ${t.cost.toFixed(4)}
                </Text>
              </Text>
            ))}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>refreshing every 0.5s · press q to quit</Text>
      </Box>
    </Box>
  );
}

/** Renders the live dashboard until the user quits. */
export async function runWatch(): Promise<void> {
  db();
  const app = render(<Dashboard />);
  await app.waitUntilExit();
}
