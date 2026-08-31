import { render, useApp } from "ink";
import pc from "picocolors";
import type { TackConfig } from "../config/schema";
import { db } from "../db";
import { PlannerSession } from "../planner/session";
import { ChatView } from "./ui/ChatView";
import { ensureInteractive } from "./ui/tty";

function StandaloneChat({
  session,
  history,
}: {
  session: PlannerSession;
  history: { role: "user" | "assistant"; content: string }[];
}): React.ReactElement {
  const { exit } = useApp();
  return <ChatView session={session} history={history} onExit={() => exit()} />;
}

/**
 * The interactive planning REPL — Tack's primary interface, rendered with Ink.
 * You converse with a planner agent that clarifies requirements and delegates to
 * the worker swarm; the session persists so it never "disappears" between runs.
 */
export async function runChat(
  config: TackConfig,
  opts: { modelRef?: string; resume?: string },
): Promise<void> {
  if (!ensureInteractive("session start")) return;
  db();

  const session = opts.resume
    ? PlannerSession.open(config, opts.resume)
    : PlannerSession.start(config, opts.modelRef);
  const history = opts.resume ? session.history() : [];

  const app = render(<StandaloneChat session={session} history={history} />);
  await app.waitUntilExit();
  session.close(); // clean exit: stop the heartbeat, mark the session closed

  process.stdout.write(
    pc.dim(`\nSession saved: ${session.id}. Resume with \`tack session start --resume ${session.id}\`.\n`),
  );
}
