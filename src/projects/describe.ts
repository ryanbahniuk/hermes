import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ChatBedrockConverse } from "@langchain/aws";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { defaultRegion } from "../models/chat";
import { resolveModel } from "../models/registry";
import { expandHome } from "../paths";
import type { HermesConfig } from "../config/schema";

/** Docs we read to summarize a repo, in priority order. */
const DOC_FILES = ["README.md", "CLAUDE.md"];

/** Cap the doc text we send so a huge README can't blow up cost/latency. */
const MAX_DOC_CHARS = 20_000;

const SYSTEM = [
  "You write terse, factual one-sentence descriptions of code repositories.",
  "Given a repo's README and/or CLAUDE.md, produce a SINGLE sentence (~25 words max)",
  "describing what the repo is and what it does. This description guides a planner",
  "in selecting which projects are relevant to a problem, so favor concrete",
  "capabilities over marketing. Output only the sentence — no preamble, no quotes.",
].join("\n");

/** Reads and concatenates the known doc files from a repo root (expands `~`). */
export function readProjectDocs(repoPath: string): string {
  const root = expandHome(repoPath);
  const parts: string[] = [];
  for (const file of DOC_FILES) {
    const full = join(root, file);
    if (!existsSync(full)) continue;
    try {
      parts.push(`--- ${file} ---\n${readFileSync(full, "utf8")}`);
    } catch {
      // Skip unreadable files rather than failing the whole summary.
    }
  }
  return parts.join("\n\n").slice(0, MAX_DOC_CHARS);
}

/** Flattens a LangChain message content (string or content blocks) to text. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === "string" ? block : typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : "",
      )
      .join("");
  }
  return "";
}

/**
 * Auto-generates a project description by summarizing its README.md / CLAUDE.md
 * with the configured cheap `defaults.summaryModel`. Throws with an actionable
 * message when the model isn't configured or there's nothing to summarize.
 */
export async function generateProjectDescription(
  config: HermesConfig,
  repoPath: string,
): Promise<string> {
  const ref = config.defaults.summaryModel;
  if (!ref) {
    throw new Error(
      "Auto-generating a description needs `defaults.summaryModel` in your config. " +
        "Set one, or pass the description explicitly with --description/-d.",
    );
  }

  const docs = readProjectDocs(repoPath);
  if (!docs.trim()) {
    throw new Error(
      `No README.md or CLAUDE.md found under ${expandHome(repoPath)} to summarize. ` +
        "Pass the description explicitly with --description/-d.",
    );
  }

  const model = resolveModel(config, ref);
  if (model.target.kind !== "bedrock") {
    throw new Error(
      `defaults.summaryModel ("${ref}") must be a bedrock-backed model (got ${model.target.kind}).`,
    );
  }

  const llm = new ChatBedrockConverse({
    model: model.target.inferenceProfile,
    region: defaultRegion(),
  });
  const res = await llm.invoke([
    new SystemMessage(SYSTEM),
    new HumanMessage(`Repository docs:\n\n${docs}`),
  ]);

  const description = contentToText(res.content).trim();
  if (!description) {
    throw new Error("The summary model returned an empty description.");
  }
  return description;
}
