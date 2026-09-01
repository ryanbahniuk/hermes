// Prompt text lives in the sibling `.md` files, imported here as strings.
//
// Bun's text imports (`with { type: "text" }`) embed the file contents into the
// module graph — baked into the compiled binary by `bun build --compile`, and
// read from disk under `bun run`. So the markdown ships with the executable; no
// filesystem access or path resolution is needed at runtime.
import sessionPlanner from "./session-planner.md" with { type: "text" };
import runPlanner from "./run-planner.md" with { type: "text" };
import adjudicate from "./adjudicate.md" with { type: "text" };
import workerTack from "./worker-tack.md" with { type: "text" };
import workerClaude from "./worker-claude.md" with { type: "text" };
import gitOperations from "./git-operations.md" with { type: "text" };

/** Static system prompts (no interpolation), trailing whitespace trimmed. */
export const prompts = {
  sessionPlanner: sessionPlanner.trimEnd(),
  runPlanner: runPlanner.trimEnd(),
  adjudicate: adjudicate.trimEnd(),
};

/** Per-task prompt templates — fill in with `render()`. */
export const templates = {
  workerTack,
  workerClaude,
  /** Injected into worker prompts via `{{gitOperations}}`; `{{branch}}` = the session PR branch. */
  gitOperations,
};

/**
 * Minimal template renderer:
 *  - `{{var}}`           → the value of `vars.var` (empty string if absent)
 *  - `{{#if var}}…{{/if}}` → the enclosed block only when `vars.var` is non-blank
 *
 * Conditionals are resolved first so `{{var}}` inside a kept block still fills in.
 * Trailing whitespace is trimmed; leading whitespace is preserved (the claude
 * worker prompt intentionally opens with a blank line).
 */
export function render(template: string, vars: Record<string, string | undefined>): string {
  const withConditionals = template.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, key: string, body: string) => (vars[key]?.trim() ? body : ""),
  );
  return withConditionals
    .replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? "")
    .trimEnd();
}
