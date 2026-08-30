import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CONFIG_PATH } from "../paths";
import {
  ModelInputSchema,
  ProjectSchema,
  normalizeModel,
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
    throw new Error(`No config found at ${path}. Run \`hermes init\` to create one.`);
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
    throw new Error(`No config found at ${path}. Run \`hermes init\` to create one.`);
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
 * reload) and rejects a duplicate `name@version`.
 */
export async function addModelToConfig(
  input: ModelInput,
  path = CONFIG_PATH,
): Promise<ModelInput> {
  if (!existsSync(path)) {
    throw new Error(`No config found at ${path}. Run \`hermes init\` to create one.`);
  }
  const model = ModelInputSchema.parse(input);
  // Surfaces "backend bedrock requires inferenceProfile", etc., before we write.
  normalizeModel(model);
  const existing = await readModels(path);
  if (existing.some((m) => modelRef(m) === modelRef(model))) {
    throw new Error(`A model "${modelRef(model)}" already exists in the config.`);
  }
  writeModels(path, [...existing, model]);
  return model;
}

/**
 * Removes a model by `name` (and optional `version`). With no version, removes
 * the sole entry for that name, or throws listing the versions when ambiguous.
 */
export async function removeModelFromConfig(
  name: string,
  version: string | undefined,
  path = CONFIG_PATH,
): Promise<ModelInput> {
  if (!existsSync(path)) {
    throw new Error(`No config found at ${path}. Run \`hermes init\` to create one.`);
  }
  const existing = await readModels(path);
  const matches = existing.filter(
    (m) => m.name === name && (version ? m.version === version : true),
  );
  if (matches.length === 0) {
    const ref = version ? `${name}@${version}` : name;
    throw new Error(`No model "${ref}" in the config.`);
  }
  if (matches.length > 1) {
    const versions = matches.map((m) => m.version).join(", ");
    throw new Error(
      `Multiple "${name}" entries (versions: ${versions}). Specify a version to remove one.`,
    );
  }
  const removed = matches[0]!;
  writeModels(path, existing.filter((m) => m !== removed));
  return removed;
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
    throw new Error(`No config found at ${path}. Run \`hermes init\` to create one.`);
  }
  const current = await readSection(path, section);
  const next = { ...current, [key]: ref };
  writeSection(path, section, next);
  return next;
}

/** Clears a role within a section, removing the key. */
export async function clearSectionModel(
  section: ModelSection,
  key: ModelRoleKey,
  path = CONFIG_PATH,
): Promise<RoleModels> {
  if (!existsSync(path)) {
    throw new Error(`No config found at ${path}. Run \`hermes init\` to create one.`);
  }
  const current = await readSection(path, section);
  const next = { ...current };
  delete next[key];
  writeSection(path, section, next);
  return next;
}
