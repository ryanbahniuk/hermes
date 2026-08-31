import * as readline from "node:readline";
import { stdin, stdout } from "node:process";
import pc from "picocolors";
import type { TackConfig } from "../config/schema";
import { db, listRunsBySession, sessionTotalCost } from "../db";
import { isAlive } from "../process/spawn";
import { PlannerSession } from "../planner/session";
import type { PlannerEvent } from "../planner/runtime";
import { startHorseAnimation, type HorseAnimation } from "./horse";

function shortJSON(input: unknown): string {
  const s = typeof input === "string" ? input : JSON.stringify(input ?? {});
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

function formatEvent(ev: PlannerEvent): string | null {
  switch (ev.type) {
    case "text":
      return ev.text.trim();
    case "tool_call":
      return pc.dim(`  → ${ev.tool}(${shortJSON(ev.input)})`);
    case "tool_result":
      return pc.dim(`  ← ${ev.ok ? "" : "ERR "}${ev.preview.replace(/\s+/g, " ")}`);
    case "error":
      return pc.red(`  error: ${ev.message}`);
    default:
      return null;
  }
}

function makePrintEvent(anim: HorseAnimation): (ev: PlannerEvent) => void {
  return (ev) => {
    const line = formatEvent(ev);
    if (line !== null) anim.print(line);
  };
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
  "    /exit     leave the session (it's saved; resume with `tack session start --resume <id>`)",
].join("\n");

/**
 * The interactive planning REPL — Tack's primary interface. You converse with a
 * planner agent that clarifies requirements and delegates to the worker swarm; the
 * session persists so it never "disappears" between commands.
 */
export async function runChat(
  config: TackConfig,
  opts: { modelRef?: string; resume?: string },
): Promise<void> {
  db();

  const session = opts.resume
    ? PlannerSession.open(config, opts.resume)
    : PlannerSession.start(config, opts.modelRef);

  stdout.write(
    pc.green(`Tack planning session ${pc.bold(session.id)}`) +
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
    const anim = startHorseAnimation();
    try {
      await session.sendTurn(line, makePrintEvent(anim));
    } catch (err) {
      anim.print(pc.red(`  error: ${(err as Error).message}`));
    } finally {
      anim.stop();
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

  stdout.write(pc.dim(`\nSession saved: ${session.id}. Resume with \`tack session start --resume ${session.id}\`.\n`));
}
