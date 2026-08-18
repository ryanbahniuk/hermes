import { existsSync, readdirSync, statSync } from "node:fs";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import type { HermesConfig } from "../config/schema";
import { assertReadable, opRead, opSearch, type Scoping } from "../tools/ops";
import type { PlannerActions } from "./actions";

const DELEGATE_DESC =
  "Delegate work to the background worker swarm. Call this ONLY once requirements are clear. " +
  "Provide a refined problem statement. Optionally name the exact projects and a focused subtask " +
  "for each (you have context from the conversation); omit `projects` to let the run's own planner " +
  "select them. Optionally provide a `sharedContext` contract every worker must conform to. Returns " +
  "a run id immediately — the swarm runs in the background while you keep talking to the user.";
const LIST_PROJECTS_DESC = "List the projects available to delegate work to (name + description).";
const CHECK_RUNS_DESC =
  "Check the status, per-project task states, and cost of the runs you have dispatched in this session.";
const READ_DESC = "Read a file to understand the code (read-only). Use an absolute path inside a project.";
const SEARCH_DESC =
  "ripgrep for a regex pattern across the projects to investigate the code (read-only). " +
  "Pass an absolute `path` inside a project to scope the search.";
const LIST_DIR_DESC = "List the entries of a directory inside a project (read-only).";

/** Zod shape for `delegate`, shared by both runtimes' tool bindings. */
const delegateSchema = {
  problem: z.string().describe("The refined problem statement handed to the worker swarm"),
  projects: z
    .array(
      z.object({
        name: z.string().describe("Exact name of a configured project"),
        subtask: z.string().describe("Focused, self-contained task for that project's worker"),
      }),
    )
    .optional()
    .describe("Explicit project selection; omit to let the run's planner choose"),
  sharedContext: z
    .string()
    .optional()
    .describe("Cross-project contract (interfaces, naming, shapes) every worker must conform to"),
};

/**
 * A read-only filesystem boundary spanning every configured project root plus
 * the read allowlist. There is no writable worktree — the planner never edits.
 */
export function plannerScoping(config: HermesConfig): Scoping {
  const roots = [...config.projects.map((p) => p.path), ...config.readAllowlist];
  return { worktree: roots[0] ?? process.cwd(), readAllowlist: roots };
}

function listDir(scoping: Scoping, path: string): string {
  const abs = assertReadable(scoping, path);
  if (!existsSync(abs)) throw new Error(`no such directory: ${path}`);
  const entries = readdirSync(abs).sort();
  return (
    entries
      .map((name) => {
        try {
          return statSync(`${abs}/${name}`).isDirectory() ? `${name}/` : name;
        } catch {
          return name;
        }
      })
      .join("\n") || "(empty)"
  );
}

/** LangChain planner tools for the `hermes` runtime. */
export function createHermesPlannerTools(actions: PlannerActions, scoping: Scoping) {
  return [
    tool(() => actions.listProjects(), {
      name: "list_projects",
      description: LIST_PROJECTS_DESC,
      schema: z.object({}),
    }),
    tool((input) => actions.delegate(input), {
      name: "delegate",
      description: DELEGATE_DESC,
      schema: z.object(delegateSchema),
    }),
    tool(() => actions.checkRuns(), {
      name: "check_runs",
      description: CHECK_RUNS_DESC,
      schema: z.object({}),
    }),
    tool(({ path }) => opRead(scoping, path), {
      name: "read_file",
      description: READ_DESC,
      schema: z.object({ path: z.string() }),
    }),
    tool(({ pattern, path }) => opSearch(scoping, pattern, path), {
      name: "search",
      description: SEARCH_DESC,
      schema: z.object({ pattern: z.string(), path: z.string().optional() }),
    }),
    tool(({ path }) => listDir(scoping, path), {
      name: "list_dir",
      description: LIST_DIR_DESC,
      schema: z.object({ path: z.string() }),
    }),
  ];
}

/**
 * In-process SDK MCP server exposing the planner delegation tools to the `claude`
 * runtime. Read-only exploration uses the SDK's native Read/Grep/Glob/LS (scoped
 * by a PreToolUse hook in the runtime), so only the Hermes-specific tools live here.
 */
export function createClaudePlannerServer(actions: PlannerActions) {
  return createSdkMcpServer({
    name: "hermes_planner",
    version: "1.0.0",
    tools: [
      sdkTool("list_projects", LIST_PROJECTS_DESC, {}, async () => ({
        content: [{ type: "text", text: actions.listProjects() }],
      })),
      sdkTool("delegate", DELEGATE_DESC, delegateSchema, async (args) => ({
        content: [{ type: "text", text: await actions.delegate(args) }],
      })),
      sdkTool("check_runs", CHECK_RUNS_DESC, {}, async () => ({
        content: [{ type: "text", text: await actions.checkRuns() }],
      })),
    ],
  });
}
