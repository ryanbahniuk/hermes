import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as ops from "./ops";

/**
 * Builds the worktree-scoped LangChain tools for the `hermes` runtime. All file
 * ops are bound to `scoping`; thrown errors are surfaced to the model as tool errors.
 */
export function createHermesTools(scoping: ops.Scoping) {
  const readFile = tool(({ path }) => ops.opRead(scoping, path), {
    name: "read_file",
    description: "Read a file. Allowed within the worktree and the read allowlist.",
    schema: z.object({
      path: z.string().describe("Path relative to the worktree, or absolute within an allowed dir"),
    }),
  });

  const writeFile = tool(({ path, content }) => ops.opWrite(scoping, path, content), {
    name: "write_file",
    description: "Create or overwrite a file in the worktree.",
    schema: z.object({
      path: z.string().describe("Path relative to the worktree"),
      content: z.string(),
    }),
  });

  const editFile = tool(({ path, find, replace }) => ops.opEdit(scoping, path, find, replace), {
    name: "edit_file",
    description: "Replace an exact, unique snippet of text in a worktree file.",
    schema: z.object({
      path: z.string(),
      find: z.string().describe("Exact text to replace; must appear exactly once in the file"),
      replace: z.string(),
    }),
  });

  const search = tool(({ pattern, path }) => ops.opSearch(scoping, pattern, path), {
    name: "search",
    description: "ripgrep for a regex pattern within the worktree (optionally scoped to a path).",
    schema: z.object({
      pattern: z.string(),
      path: z.string().optional(),
    }),
  });

  const shell = tool(({ command }) => ops.opShell(scoping, command), {
    name: "shell",
    description: "Run a bash command with the worktree as the working directory.",
    schema: z.object({ command: z.string() }),
  });

  const git = tool(({ args }) => ops.opGit(scoping, args), {
    name: "git",
    description: 'Run a git command in the worktree. Pass args as an array, e.g. ["status", "--short"].',
    schema: z.object({ args: z.array(z.string()) }),
  });

  return [readFile, writeFile, editFile, search, shell, git];
}
