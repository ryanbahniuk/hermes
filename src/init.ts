import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { CONFIG_PATH, TACK_HOME } from "./paths";
import { STARTER_CONFIG } from "./config/starter";
import { db } from "./db";

export interface InitResult {
  home: string;
  configPath: string;
  createdConfig: boolean;
}

/** Creates the Tack home dir, a starter config (if absent), and the database. */
export function initHome(): InitResult {
  mkdirSync(TACK_HOME, { recursive: true });
  const createdConfig = !existsSync(CONFIG_PATH);
  if (createdConfig) writeFileSync(CONFIG_PATH, STARTER_CONFIG);
  db(); // opens + migrates
  return { home: TACK_HOME, configPath: CONFIG_PATH, createdConfig };
}
