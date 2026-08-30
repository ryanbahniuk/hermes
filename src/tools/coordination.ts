import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import type { Coordination } from "../runtimes/types";

const READ_DESC =
  "Read the current shared coordination context (the cross-project contract for this run).";
const PROPOSE_DESC =
  "Propose an amendment to the shared context when you believe the contract is wrong or incomplete. " +
  "Use sparingly — the planner is authoritative; conform to the current contract unless told otherwise.";

/** LangChain coordination tools for the `tack` runtime. */
export function createTackCoordinationTools(c: Coordination) {
  const read = tool(() => c.readSharedContext(), {
    name: "read_shared_context",
    description: READ_DESC,
    schema: z.object({}),
  });
  const propose = tool(async ({ proposal }) => c.proposeAmendment(proposal), {
    name: "propose_amendment",
    description: PROPOSE_DESC,
    schema: z.object({ proposal: z.string().describe("What should change in the contract, and why") }),
  });
  return [read, propose];
}

/** In-process SDK MCP server exposing the same coordination tools to the `claude` runtime. */
export function createClaudeCoordinationServer(c: Coordination) {
  return createSdkMcpServer({
    name: "tack",
    version: "1.0.0",
    tools: [
      sdkTool("read_shared_context", READ_DESC, {}, async () => ({
        content: [{ type: "text", text: c.readSharedContext() }],
      })),
      sdkTool(
        "propose_amendment",
        PROPOSE_DESC,
        { proposal: z.string() },
        async (args) => ({ content: [{ type: "text", text: await c.proposeAmendment(args.proposal) }] }),
      ),
    ],
  });
}
