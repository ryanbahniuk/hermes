import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CONFIG_PATH } from "../paths";
import {
  AwsProfileSchema,
  ModelInputSchema,
  ProjectSchema,
  normalizeModel,
  type AwsConfig,
  type AwsProfile,
  type ModelInput,
  type Project,
} from "./schema";

/**
 * Replaces every string literal and comment in `src` with same-length runs of
 * spaces (newlines preserved). Index positions map 1:1 back to the original, so
 * we can safely scan for the `projects:` key and bracket-match its array without
 * tripping over a `[`, `]`, or the word "projects" that lives inside a string or
 * comment.
 */
function blankNonCode(src: string): string {
  let out = "";
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && c2 === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += " ";
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += " ";
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Locates the `[start, end)` span of a top-level `<key>:` literal delimited by
 * `open`/`close` (e.g. `[`/`]` for an array, `{`/`}` for an object). Strings and
 * comments are blanked first so nested delimiters inside them don't confuse the
 * bracket matcher.
 */
function findDelimitedSpan(
  src: string,
  key: string,
  open: string,
  close: string,
): { start: number; end: number } {
  const blanked = blankNonCode(src);
  const match = new RegExp(`\\b${key}\\s*:`).exec(blanked);
  if (!match) throw new Error(`Could not find a \`${key}:\` key in the config.`);

  let j = match.index + match[0].length;
  while (j < blanked.length && /\s/.test(blanked[j]!)) j++;
  if (blanked[j] !== open) {
    throw new Error(`\`${key}\` is not a \`${open}${close}\` literal — edit the config by hand.`);
  }

  const start = j;
  let depth = 0;
  for (let k = start; k < blanked.length; k++) {
    if (blanked[k] === open) depth++;
    else if (blanked[k] === close && --depth === 0) return { start, end: k + 1 };
  }
  throw new Error(`Unterminated \`${key}\` literal in the config.`);
}

/** Locates the `[start, end)` span of a top-level `<key>:` array literal in `src`. */
function findArraySpan(src: string, key: string): { start: number; end: number } {
  return findDelimitedSpan(src, key, "[", "]");
}

/** Serializes projects as a TS array literal, one entry per line. */
function serializeProjects(projects: Project[]): string {
  if (projects.length === 0) return "[]";
  const lines = projects.map(
    (p) =>
      `    { name: ${JSON.stringify(p.name)}, path: ${JSON.stringify(p.path)}, ` +
      `description: ${JSON.stringify(p.description)} },`,
  );
  return `[\n${lines.join("\n")}\n  ]`;
}

/**
 * Reads the current projects as written in the config file. Imports the module
 * (like the loader) so `~` paths and other literals are preserved verbatim,
 * rather than the loader's expanded/normalized form.
 */
async function readProjects(path: string): Promise<Project[]> {
  const mod = (await import(path)) as { default?: unknown; config?: unknown };
  const raw = (mod.default ?? mod.config) as { projects?: unknown } | undefined;
  const projects = raw?.projects ?? [];
  if (!Array.isArray(projects)) {
    throw new Error("`projects` in the config is not an array.");
  }
  return projects as Project[];
}

/** Rewrites just the `projects:` array in the config, leaving the rest intact. */
function writeProjects(path: string, projects: Project[]): void {
  const src = readFileSync(path, "utf8");
  const { start, end } = findArraySpan(src, "projects");
  const next = src.slice(0, start) + serializeProjects(projects) + src.slice(end);
  writeFileSync(path, next);
}

/** Adds a project to the config. Throws if the name is already registered. */
export async function addProjectToConfig(
  input: Project,
  path = CONFIG_PATH,
): Promise<Project> {
  if (!existsSync(path)) {
    throw new Error(`No config found at ${path}. Run \`tack init\` to create one.`);
  }
  const project = ProjectSchema.parse(input);
  const existing = await readProjects(path);
  if (existing.some((p) => p.name === project.name)) {
    throw new Error(`A project named "${project.name}" already exists in the config.`);
  }
  writeProjects(path, [...existing, project]);
  return project;
}

/** Removes a project by name. Throws if no such project is registered. */
export async function removeProjectFromConfig(
  name: string,
  path = CONFIG_PATH,
): Promise<Project> {
  if (!existsSync(path)) {
    throw new Error(`No config found at ${path}. Run \`tack init\` to create one.`);
  }
  const existing = await readProjects(path);
  const removed = existing.find((p) => p.name === name);
  if (!removed) {
    throw new Error(`No project named "${name}" in the config.`);
  }
  writeProjects(path, existing.filter((p) => p.name !== name));
  return removed;
}

// --- Models -----------------------------------------------------------------

/** A model's config identity is `name@version`, matching the registry lookup. */
function modelRef(m: { name: string; version: string }): string {
  return `${m.name}@${m.version}`;
}

/** Serializes one model as a multi-line TS object literal, omitting unset fields. */
function serializeModel(m: ModelInput): string {
  const lines: string[] = [];
  lines.push(`      name: ${JSON.stringify(m.name)},`);
  lines.push(`      version: ${JSON.stringify(m.version)},`);
  lines.push(`      provider: ${JSON.stringify(m.provider)},`);
  if (m.runtime) lines.push(`      runtime: ${JSON.stringify(m.runtime)},`);
  if (m.backend) lines.push(`      backend: ${JSON.stringify(m.backend)},`);
  if (m.inferenceProfile) {
    lines.push(`      inferenceProfile: ${JSON.stringify(m.inferenceProfile)},`);
  }
  if (m.apiModelId) lines.push(`      apiModelId: ${JSON.stringify(m.apiModelId)},`);
  if (m.awsProfile) lines.push(`      awsProfile: ${JSON.stringify(m.awsProfile)},`);
  if (m.pricing) {
    const parts = Object.entries(m.pricing)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${v}`);
    lines.push(`      pricing: { ${parts.join(", ")} },`);
  }
  return `    {\n${lines.join("\n")}\n    },`;
}

/** Serializes the models array as a TS array literal, one object per entry. */
function serializeModels(models: ModelInput[]): string {
  if (models.length === 0) return "[]";
  return `[\n${models.map(serializeModel).join("\n")}\n  ]`;
}

/**
 * Reads the models as written in the config file (verbatim literals, before
 * `normalizeModel` fills defaults) — same import-based approach as `readProjects`.
 */
async function readModels(path: string): Promise<ModelInput[]> {
  const mod = (await import(path)) as { default?: unknown; config?: unknown };
  const raw = (mod.default ?? mod.config) as { models?: unknown } | undefined;
  const models = raw?.models ?? [];
  if (!Array.isArray(models)) {
    throw new Error("`models` in the config is not an array.");
  }
  return models as ModelInput[];
}

/** Rewrites just the `models:` array in the config, leaving the rest intact. */
function writeModels(path: string, models: ModelInput[]): void {
  const src = readFileSync(path, "utf8");
  const { start, end } = findArraySpan(src, "models");
  const next = src.slice(0, start) + serializeModels(models) + src.slice(end);
  writeFileSync(path, next);
}

/**
 * Adds a model to the config. Validates the entry with `normalizeModel` (so the
 * runtime/backend/target rules are enforced up front, independent of the config
 * reload) and rejects a duplicate — a model's identity is the full
 * `(name, version, runtime, backend)` tuple, so the same `name@version` may be
 * registered under several runtime/backend variants (e.g. an `anthropic` backend
 * alongside a `bedrock`/`tack` one).
 */
export async function addModelToConfig(
  input: ModelInput,
  path = CONFIG_PATH,
): Promise<ModelInput> {
  if (!existsSync(path)) {
    throw new Error(`No config found at ${path}. Run \`tack init\` to create one.`);
  }
  const model = ModelInputSchema.parse(input);
  // Surfaces "backend bedrock requires inferenceProfile", etc., before we write,
  // and fills the runtime/backend defaults we compare identity on.
  const normalized = normalizeModel(model);
  const existing = await readModels(path);
  const clash = existing.some((m) => {
    const n = normalizeModel(m);
    return (
      n.name === normalized.name &&
      n.version === normalized.version &&
      n.runtime === normalized.runtime &&
      n.backend === normalized.backend
    );
  });
  if (clash) {
    throw new Error(
      `A model "${modelRef(normalized)}" with runtime "${normalized.runtime}" and ` +
        `backend "${normalized.backend}" already exists in the config.`,
    );
  }
  writeModels(path, [...existing, model]);
  return model;
}

/**
 * Removes a model by `name`, narrowed by optional `version` and a
 * `runtime`/`backend` variant selector. Removes the sole match, or throws
 * listing the variants when the selection is still ambiguous.
 */
export async function removeModelFromConfig(
  name: string,
  version: string | undefined,
  selector: { runtime?: "claude" | "tack"; backend?: "bedrock" | "anthropic" } = {},
  path = CONFIG_PATH,
): Promise<ModelInput> {
  if (!existsSync(path)) {
    throw new Error(`No config found at ${path}. Run \`tack init\` to create one.`);
  }
  const existing = await readModels(path);
  let matches = existing.filter(
    (m) => m.name === name && (version ? m.version === version : true),
  );
  if (selector.backend) {
    matches = matches.filter((m) => normalizeModel(m).backend === selector.backend);
  }
  if (selector.runtime) {
    matches = matches.filter((m) => normalizeModel(m).runtime === selector.runtime);
  }
  if (matches.length === 0) {
    const ref = version ? `${name}@${version}` : name;
    const pins = [selector.backend, selector.runtime].filter(Boolean).join("/");
    throw new Error(`No model "${ref}"${pins ? ` (${pins})` : ""} in the config.`);
  }
  if (matches.length > 1) {
    const opts = matches
      .map((m) => {
        const n = normalizeModel(m);
        return `${n.name}@${n.version} (runtime=${n.runtime}, backend=${n.backend})`;
      })
      .join("; ");
    throw new Error(
      `Multiple "${name}" entries match. Narrow with a version and/or --runtime/--backend: ${opts}`,
    );
  }
  const removed = matches[0]!;
  writeModels(path, existing.filter((m) => m !== removed));
  return removed;
}

/**
 * Sets (or clears, with `undefined`) the `pricing` on a single model entry,
 * narrowed by optional `version` and a `runtime`/`backend` selector. Throws when
 * the selection matches zero or more than one entry, mirroring `remove`.
 */
export async function updateModelPricing(
  name: string,
  version: string | undefined,
  selector: { runtime?: "claude" | "tack"; backend?: "bedrock" | "anthropic" },
  pricing: ModelInput["pricing"] | undefined,
  path = CONFIG_PATH,
): Promise<ModelInput> {
  if (!existsSync(path)) {
    throw new Error(`No config found at ${path}. Run \`tack init\` to create one.`);
  }
  const existing = await readModels(path);
  let matches = existing.filter(
    (m) => m.name === name && (version ? m.version === version : true),
  );
  if (selector.backend) {
    matches = matches.filter((m) => normalizeModel(m).backend === selector.backend);
  }
  if (selector.runtime) {
    matches = matches.filter((m) => normalizeModel(m).runtime === selector.runtime);
  }
  if (matches.length === 0) {
    const ref = version ? `${name}@${version}` : name;
    throw new Error(`No model "${ref}" in the config.`);
  }
  if (matches.length > 1) {
    const opts = matches
      .map((m) => {
        const n = normalizeModel(m);
        return `${n.name}@${n.version} (runtime=${n.runtime}, backend=${n.backend})`;
      })
      .join("; ");
    throw new Error(
      `Multiple "${name}" entries match. Narrow with a version and/or runtime/backend: ${opts}`,
    );
  }
  const target = matches[0]!;
  const updated: ModelInput = { ...target };
  if (pricing && Object.keys(pricing).length > 0) updated.pricing = pricing;
  else delete updated.pricing;
  writeModels(path, existing.map((m) => (m === target ? updated : m)));
  return updated;
}

// --- Model role sections (defaults / overrides) -----------------------------

/** The per-role model keys a user can point at a registered model. */
export type ModelRoleKey = "plannerModel" | "implementerModel" | "summaryModel";

/** The config sections that hold per-role model selections. */
export type ModelSection = "defaults" | "overrides";

type RoleModels = Partial<Record<ModelRoleKey, string>>;

/** Serializes a role-model object, one key per line, omitting empty values. */
function serializeRoleModels(models: RoleModels): string {
  const entries = Object.entries(models).filter(([, v]) => v);
  if (entries.length === 0) return "{}";
  const lines = entries.map(([k, v]) => `    ${k}: ${JSON.stringify(v)},`);
  return `{\n${lines.join("\n")}\n  }`;
}

/** Reads a `defaults`/`overrides` object as written in the config (verbatim). */
async function readSection(path: string, section: ModelSection): Promise<RoleModels> {
  const mod = (await import(path)) as { default?: unknown; config?: unknown };
  const raw = (mod.default ?? mod.config) as Record<string, unknown> | undefined;
  const value = raw?.[section] ?? {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`\`${section}\` in the config is not an object.`);
  }
  return value as RoleModels;
}

/** Locates the top-level config object literal (`export default {…}` / `config = {…}`). */
function findConfigObjectSpan(src: string): { start: number; end: number } {
  const blanked = blankNonCode(src);
  const anchor = /\bexport\s+default\b|\bexport\s+const\s+config\b|\bmodule\.exports\b/.exec(
    blanked,
  );
  if (!anchor) {
    throw new Error("Could not locate the config object — edit the config by hand.");
  }
  let start = anchor.index + anchor[0].length;
  while (start < blanked.length && blanked[start] !== "{") start++;
  if (blanked[start] !== "{") {
    throw new Error("Could not locate the config object — edit the config by hand.");
  }
  let depth = 0;
  for (let k = start; k < blanked.length; k++) {
    if (blanked[k] === "{") depth++;
    else if (blanked[k] === "}" && --depth === 0) return { start, end: k + 1 };
  }
  throw new Error("Unterminated config object.");
}

/**
 * Rewrites a `defaults`/`overrides` object in place, or inserts the section
 * before the config object's closing brace when it doesn't exist yet (older
 * configs predate `overrides`).
 */
function writeSection(path: string, section: ModelSection, models: RoleModels): void {
  const src = readFileSync(path, "utf8");
  const serialized = serializeRoleModels(models);
  const hasKey = new RegExp(`\\b${section}\\s*:`).test(blankNonCode(src));
  if (hasKey) {
    const { start, end } = findDelimitedSpan(src, section, "{", "}");
    writeFileSync(path, src.slice(0, start) + serialized + src.slice(end));
    return;
  }
  const { end } = findConfigObjectSpan(src);
  const close = end - 1; // index of the config object's closing "}"
  const head = src.slice(0, close);
  const pad = head.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${head}${pad}  ${section}: ${serialized},\n${src.slice(close)}`);
}

/**
 * Points a role (`plannerModel`/`implementerModel`/`summaryModel`) at `ref` (a
 * `name` or `name@version`) within a section, merging into the existing object.
 * Does not validate that `ref` resolves — the caller checks that against the
 * loaded config so it can give a role-aware message.
 */
export async function setSectionModel(
  section: ModelSection,
  key: ModelRoleKey,
  ref: string,
  path = CONFIG_PATH,
): Promise<RoleModels> {
  if (!existsSync(path)) {
    throw new Error(`No config found at ${path}. Run \`tack init\` to create one.`);
  }
  const current = await readSection(path, section);
  const next = { ...current, [key]: ref };
  writeSection(path, section, next);
  return next;
}

// --- AWS profiles -----------------------------------------------------------

/** Serializes one aws profile as an inline object, omitting unset fields. */
function serializeAwsProfile(p: AwsProfile): string {
  const parts = [`profile: ${JSON.stringify(p.profile)}`];
  if (p.account) parts.push(`account: ${JSON.stringify(p.account)}`);
  if (p.region) parts.push(`region: ${JSON.stringify(p.region)}`);
  return `{ ${parts.join(", ")} }`;
}

/** Serializes the whole `aws` block (profiles map + optional default) as a TS object literal. */
function serializeAws(aws: AwsConfig): string {
  const keys = Object.keys(aws.profiles);
  const profiles =
    keys.length === 0
      ? "{}"
      : `{\n${keys
          .map((k) => `      ${JSON.stringify(k)}: ${serializeAwsProfile(aws.profiles[k]!)},`)
          .join("\n")}\n    }`;
  const lines = [`    profiles: ${profiles},`];
  if (aws.default) lines.push(`    default: ${JSON.stringify(aws.default)},`);
  return `{\n${lines.join("\n")}\n  }`;
}

/** Reads the `aws` block as written in the config (verbatim, before defaults). */
async function readAws(path: string): Promise<AwsConfig> {
  const mod = (await import(path)) as { default?: unknown; config?: unknown };
  const raw = (mod.default ?? mod.config) as { aws?: unknown } | undefined;
  const aws = raw?.aws ?? { profiles: {} };
  if (typeof aws !== "object" || aws === null || Array.isArray(aws)) {
    throw new Error("`aws` in the config is not an object.");
  }
  const value = aws as { profiles?: unknown; default?: unknown };
  if (value.profiles !== undefined && (typeof value.profiles !== "object" || value.profiles === null)) {
    throw new Error("`aws.profiles` in the config is not an object.");
  }
  return {
    profiles: (value.profiles as Record<string, AwsProfile>) ?? {},
    default: typeof value.default === "string" ? value.default : undefined,
  };
}

/** Rewrites the `aws` block in place, or inserts it before the config's closing brace. */
function writeAws(path: string, aws: AwsConfig): void {
  const src = readFileSync(path, "utf8");
  const serialized = serializeAws(aws);
  const hasKey = /\baws\s*:/.test(blankNonCode(src));
  if (hasKey) {
    const { start, end } = findDelimitedSpan(src, "aws", "{", "}");
    writeFileSync(path, src.slice(0, start) + serialized + src.slice(end));
    return;
  }
  const { end } = findConfigObjectSpan(src);
  const close = end - 1; // index of the config object's closing "}"
  const head = src.slice(0, close);
  const pad = head.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${head}${pad}  aws: ${serialized},\n${src.slice(close)}`);
}

/**
 * Adds a named aws profile. Rejects a duplicate key. Becomes the config default
 * when none is set yet (or when `makeDefault` is passed) — so the first profile a
 * user adds is used without an extra `set-default` step.
 */
export async function addAwsProfileToConfig(
  key: string,
  profile: AwsProfile,
  opts: { makeDefault?: boolean } = {},
  path = CONFIG_PATH,
): Promise<{ aws: AwsConfig; isDefault: boolean }> {
  if (!existsSync(path)) {
    throw new Error(`No config found at ${path}. Run \`tack init\` to create one.`);
  }
  if (!key.trim()) throw new Error("A profile key is required.");
  const parsed = AwsProfileSchema.parse(profile);
  const current = await readAws(path);
  if (current.profiles[key]) {
    throw new Error(`An aws profile "${key}" already exists in the config.`);
  }
  const makeDefault = opts.makeDefault || !current.default;
  const next: AwsConfig = {
    profiles: { ...current.profiles, [key]: parsed },
    default: makeDefault ? key : current.default,
  };
  writeAws(path, next);
  return { aws: next, isDefault: makeDefault };
}

/**
 * Removes a named aws profile. Refuses when a model still references it (which
 * would make the config fail to load), and clears `aws.default` if it pointed here.
 */
export async function removeAwsProfileFromConfig(
  key: string,
  path = CONFIG_PATH,
): Promise<AwsProfile> {
  if (!existsSync(path)) {
    throw new Error(`No config found at ${path}. Run \`tack init\` to create one.`);
  }
  const current = await readAws(path);
  const removed = current.profiles[key];
  if (!removed) {
    throw new Error(`No aws profile "${key}" in the config.`);
  }
  const models = await readModels(path);
  const referencing = models.filter((m) => m.awsProfile === key).map(modelRef);
  if (referencing.length > 0) {
    throw new Error(
      `Cannot remove aws profile "${key}" — still used by: ${referencing.join(", ")}. ` +
        `Repoint or remove those models first.`,
    );
  }
  const profiles = { ...current.profiles };
  delete profiles[key];
  writeAws(path, {
    profiles,
    default: current.default === key ? undefined : current.default,
  });
  return removed;
}

/** Sets (or clears, with `null`) the default aws profile. Validates the key exists. */
export async function setDefaultAwsProfile(
  key: string | null,
  path = CONFIG_PATH,
): Promise<AwsConfig> {
  if (!existsSync(path)) {
    throw new Error(`No config found at ${path}. Run \`tack init\` to create one.`);
  }
  const current = await readAws(path);
  if (key !== null && !current.profiles[key]) {
    const known = Object.keys(current.profiles).join(", ") || "(none)";
    throw new Error(`No aws profile "${key}" in the config. Defined: ${known}`);
  }
  const next: AwsConfig = { profiles: current.profiles, default: key ?? undefined };
  writeAws(path, next);
  return next;
}

/** Clears a role within a section, removing the key. */
export async function clearSectionModel(
  section: ModelSection,
  key: ModelRoleKey,
  path = CONFIG_PATH,
): Promise<RoleModels> {
  if (!existsSync(path)) {
    throw new Error(`No config found at ${path}. Run \`tack init\` to create one.`);
  }
  const current = await readSection(path, section);
  const next = { ...current };
  delete next[key];
  writeSection(path, section, next);
  return next;
}
