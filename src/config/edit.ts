import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CONFIG_PATH } from "../paths";
import { ProjectSchema, type Project } from "./schema";

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

/** Locates the `[start, end)` span of the `projects:` array literal in `src`. */
function findProjectsArraySpan(src: string): { start: number; end: number } {
  const blanked = blankNonCode(src);
  const key = /\bprojects\s*:/.exec(blanked);
  if (!key) throw new Error("Could not find a `projects:` key in the config.");

  let j = key.index + key[0].length;
  while (j < blanked.length && /\s/.test(blanked[j]!)) j++;
  if (blanked[j] !== "[") {
    throw new Error("`projects` is not an array literal — edit the config by hand.");
  }

  const start = j;
  let depth = 0;
  for (let k = start; k < blanked.length; k++) {
    if (blanked[k] === "[") depth++;
    else if (blanked[k] === "]" && --depth === 0) return { start, end: k + 1 };
  }
  throw new Error("Unterminated `projects` array in the config.");
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
  const { start, end } = findProjectsArraySpan(src);
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
