import * as readline from "node:readline";
import { stdin, stdout } from "node:process";
import pc from "picocolors";
import type { HermesConfig } from "../config/schema";
import { db, listRunsBySession, sessionTotalCost } from "../db";
import { isAlive } from "../process/spawn";
import { PlannerSession } from "../planner/session";
import type { PlannerEvent } from "../planner/runtime";

function shortJSON(input: unknown): string {
  const s = typeof input === "string" ? input : JSON.stringify(input ?? {});
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/** Renders one streamed planner event to the terminal. */
function printEvent(ev: PlannerEvent): void {
  switch (ev.type) {
    case "text":
      stdout.write(ev.text.trim() + "\n");
      break;
    case "tool_call":
      stdout.write(pc.dim(`  → ${ev.tool}(${shortJSON(ev.input)})`) + "\n");
      break;
    case "tool_result":
      stdout.write(pc.dim(`  ← ${ev.ok ? "" : "ERR "}${ev.preview.replace(/\s+/g, " ")}`) + "\n");
      break;
    case "error":
      stdout.write(pc.red(`  error: ${ev.message}`) + "\n");
      break;
  }
}

function printRuns(sessionId: string): void {
  const runs = listRunsBySession(sessionId);
  if (runs.length === 0) return void stdout.write(pc.dim("  (no runs dispatched yet)\n"));
  for (const r of runs) {
    const terminal = r.status === "done" || r.status === "failed";
    const live = terminal
      ? pc.dim(r.status)
      : isAlive(r.supervisor_pid)
        ? pc.green("running")
        : pc.yellow("stalled");
    stdout.write(`  ${pc.bold(r.id)}  ${live}  ${pc.dim(`$${r.cost.toFixed(4)}`)}  ${pc.dim(r.problem.slice(0, 60))}\n`);
  }
}

const HELP = [
  "  Commands:",
  "    /runs     list runs dispatched from this session",
  "    /help     show this help",
  "    /exit     leave the session (it's saved; resume with `hermes chat --resume <id>`)",
].join("\n");

/**
 * The interactive planning REPL — Hermes's primary interface. You converse with a
 * planner agent that clarifies requirements and delegates to the worker swarm; the
 * session persists so it never "disappears" between commands.
 */
export async function runChat(
  config: HermesConfig,
  opts: { modelRef?: string; resume?: string },
): Promise<void> {
  db();

  const session = opts.resume
    ? PlannerSession.open(config, opts.resume)
    : PlannerSession.start(config, opts.modelRef);

  stdout.write(
    pc.green(`Hermes planning session ${pc.bold(session.id)}`) +
      pc.dim(`  (${session.model.name}@${session.model.version}, runtime=${session.model.runtime})`) +
      "\n",
  );

  if (opts.resume) {
    const history = session.history();
    if (history.length > 0) {
      stdout.write(pc.dim(`  resuming — ${history.length} prior message(s)\n\n`));
      for (const m of history) {
        stdout.write((m.role === "user" ? pc.cyan("you › ") : "") + m.content.trim() + "\n");
      }
      stdout.write("\n");
    }
  }
  stdout.write(pc.dim("  Talk to the planner. It clarifies, then delegates to worker agents. /help for commands.\n\n"));

  // Classic readline consumed as an async iterable: this buffers piped input
  // correctly under Bun (readline/promises does not) and pauses between turns.
  const rl = readline.createInterface({ input: stdin, output: stdout });
  rl.on("SIGINT", () => rl.close());

  const prompt = () => stdout.write(pc.cyan("you › "));
  prompt();

  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) {
      prompt();
      continue;
    }
    if (line === "/exit" || line === "/quit") break;
    if (line === "/help") {
      stdout.write(HELP + "\n\n");
      prompt();
      continue;
    }
    if (line === "/runs") {
      printRuns(session.id);
      stdout.write("\n");
      prompt();
      continue;
    }

    stdout.write(pc.dim("planner ›\n"));
    try {
      await session.sendTurn(line, printEvent);
    } catch (err) {
      stdout.write(pc.red(`  error: ${(err as Error).message}`) + "\n");
    }
    const cost = sessionTotalCost(session.id);
    stdout.write(
      pc.dim(
        `  ── session cost $${cost.total.toFixed(4)} (planning $${cost.planner.toFixed(4)} + work $${cost.work.toFixed(4)})\n\n`,
      ),
    );
    prompt();
  }
  rl.close();

  stdout.write(pc.dim(`\nSession saved: ${session.id}. Resume with \`hermes chat --resume ${session.id}\`.\n`));
}
