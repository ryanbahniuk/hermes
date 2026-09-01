import { useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import type { TackConfig } from "../config/schema";
import { db } from "../db";
import { PlannerSession } from "../planner/session";
import { ChatView } from "./ui/ChatView";
import { Dashboard } from "./ui/Dashboard";
import { LogView } from "./ui/LogView";
import { ensureInteractive, withAltScreen } from "./ui/tty";

type PriorMessage = { role: "user" | "assistant"; content: string };

// The stable app is a small view state machine: the dashboard is home, and
// selecting a row pushes into either a live chat or a read-only run log. Esc/q
// from those pops back home; q at home quits.
type Mode =
  | { name: "dashboard" }
  | { name: "chat"; session: PlannerSession; history: PriorMessage[] }
  | { name: "log"; runId: string }
  | { name: "error"; message: string };

function ErrorView({ message, onBack }: { message: string; onBack: () => void }): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input === "q") onBack();
  });
  return (
    <Box flexDirection="column" padding={1}>
      <Text color="red">Couldn't open session: {message}</Text>
      <Text dimColor>press q or Esc to go back</Text>
    </Box>
  );
}

function Stable({ config }: { config: TackConfig }): React.ReactElement {
  const { exit } = useApp();
  const [mode, setMode] = useState<Mode>({ name: "dashboard" });

  const openSession = (sessionId: string) => {
    try {
      const session = PlannerSession.open(config, sessionId);
      setMode({ name: "chat", session, history: session.history() });
    } catch (err) {
      setMode({ name: "error", message: (err as Error).message });
    }
  };
  const newSession = () => {
    try {
      const session = PlannerSession.start(config);
      setMode({ name: "chat", session, history: [] });
    } catch (err) {
      setMode({ name: "error", message: (err as Error).message });
    }
  };
  const back = () => setMode({ name: "dashboard" });
  // Leaving a chat is a clean exit for that session: stop its heartbeat and mark
  // it closed so the dashboard stops showing it live. Reopening reactivates it.
  const leaveChat = (session: PlannerSession) => {
    session.close();
    back();
  };

  switch (mode.name) {
    case "dashboard":
      return (
        <Dashboard
          config={config}
          onOpenSession={openSession}
          onOpenRun={(runId) => setMode({ name: "log", runId })}
          onNewSession={newSession}
          onQuit={() => exit()}
        />
      );
    case "chat":
      return (
        <ChatView
          session={mode.session}
          history={mode.history}
          onExit={() => leaveChat(mode.session)}
          // Detaching mid-turn returns to the dashboard WITHOUT closing the
          // session, so the in-flight turn keeps running in the background and
          // the row stays live; reopening it later picks the conversation back up.
          onDetach={back}
          embedded
        />
      );
    case "log":
      return <LogView runId={mode.runId} onExit={back} />;
    case "error":
      return <ErrorView message={mode.message} onBack={back} />;
  }
}

/** Renders the interactive stable dashboard until the user quits. */
export async function runStable(config: TackConfig): Promise<void> {
  if (!ensureInteractive("stable")) return;
  db();
  // Paint into the alternate screen buffer (like vim/less) so the dashboard gets
  // clean full-screen real estate and the user's scrollback is restored on exit.
  await withAltScreen(async () => {
    const app = render(<Stable config={config} />);
    await app.waitUntilExit();
  });
}
