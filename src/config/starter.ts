/** Written to $HERMES_HOME/hermes.config.ts by `hermes init`. */
export const STARTER_CONFIG = `// Hermes configuration.
// Imported at runtime — must \`export default\` a config object.

export default {
  // Locally checked-out repos Hermes may use. The \`description\` guides the
  // planner when it selects which projects are relevant to a problem.
  projects: [
    // { name: "example", path: "~/code/example", description: "What this repo is / does." },
  ],

  // Models available to the planner and implementers.
  //   runtime  defaults: provider "anthropic" -> "claude", otherwise -> "hermes".
  //   backend  defaults to "bedrock".
  models: [
    {
      name: "claude-sonnet",
      version: "4.5",
      provider: "anthropic",
      // Replace with a real Bedrock inference-profile id for your account:
      inferenceProfile: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    },

    // First-party Anthropic API backend (needs ANTHROPIC_API_KEY in your env):
    // {
    //   name: "claude-sonnet",
    //   version: "4.5-api",
    //   provider: "anthropic",
    //   backend: "anthropic",
    //   apiModelId: "claude-sonnet-4-5",
    // },

    // A non-Anthropic Bedrock model runs through the "hermes" runtime.
    // Add "pricing" (USD per 1M tokens) so Hermes can compute cost — the
    // hermes runtime has no SDK-reported cost like the claude runtime does.
    // {
    //   name: "llama",
    //   version: "3.3-70b",
    //   provider: "meta",
    //   inferenceProfile: "us.meta.llama3-3-70b-instruct-v1:0",
    //   pricing: { inputPer1M: 0.72, outputPer1M: 0.72 },
    // },
  ],

  // Extra directories the read tool may read (read-only), beyond each worktree.
  readAllowlist: [],

  defaults: {
    plannerModel: "claude-sonnet",
    // implementerModel: "claude-sonnet",

    // Cheap/fast model for lightweight chores — e.g. \`hermes project add\`
    // auto-generates a description from the repo's README.md / CLAUDE.md when
    // you omit --description. Point this at a small model to keep it cheap.
    // summaryModel: "claude-haiku",
  },
};
`;
