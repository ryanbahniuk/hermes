/** Written to $HERMES_HOME/hermes.config.ts by `hermes init`. */
export const STARTER_CONFIG = `// Hermes configuration.
// Imported at runtime — must \`export default\` a config object.

export default {
  // Locally checked-out repos Hermes may use. The \`description\` guides the
  // planner when it selects which projects are relevant to a problem.
  projects: [
    // { name: "example", path: "~/code/example", description: "What this repo is / does." },
  ],

  // Named AWS identities that bedrock models authenticate through. Each entry pins
  // a shared-config \`profile\`, its 12-digit \`account\` (verified via STS so a wrong
  // or expired profile fails loudly), and the \`region\` its inference profiles live
  // in. A model selects one by key with \`awsProfile\`; \`default\` is used otherwise —
  // so different models can live in different accounts. Manage with \`hermes aws …\`
  // (add / remove / set-default / login / whoami).
  aws: {
    profiles: {
      // "coding-tools": { profile: "coding-tools-aws-coding-tools-bedrock", account: "602028460818", region: "us-east-1" },
    },
    // default: "coding-tools",
  },

  // Models available to the planner and implementers.
  //   runtime     defaults: provider "anthropic" -> "claude", otherwise -> "hermes".
  //   backend     defaults to "bedrock".
  //   awsProfile  key into \`aws.profiles\` above; falls back to \`aws.default\`.
  // Tip: \`hermes model add <name> <version> --model-id <id> --aws-profile <key>\`
  // appends entries here and resolves the inference profile for you —
  // \`hermes model discover\` lists ids.
  models: [
    {
      name: "claude-sonnet",
      version: "4.5",
      provider: "anthropic",
      // Replace with a real Bedrock inference-profile id for your account (or run
      // \`hermes model remove claude-sonnet 4.5\` then \`hermes model add\` to resolve it):
      inferenceProfile: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      // awsProfile: "coding-tools",  // which account/region this model uses
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

  // Fallback models per role (set via \`hermes model set-default <role> <model>\`).
  // Used when nothing higher-priority applies.
  defaults: {
    plannerModel: "claude-sonnet",
    // implementerModel: "claude-sonnet",

    // Cheap/fast model for lightweight chores — e.g. \`hermes project add\`
    // auto-generates a description from the repo's README.md / CLAUDE.md when
    // you omit --description. Point this at a small model to keep it cheap.
    // summaryModel: "claude-haiku",
  },

  // Hard pins per role (set via \`hermes model set <role> <model>\`). These win
  // over intelligent routing — use them to force a specific model regardless of
  // what the router would pick. Precedence: overrides > routing > defaults.
  overrides: {
    // plannerModel: "claude-sonnet",
  },
};
`;
