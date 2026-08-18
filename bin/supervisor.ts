#!/usr/bin/env bun
// Detached per-run supervisor entrypoint: `bun supervisor.ts <runId>`.
import { supervise } from "../src/orchestrator/supervise";

const runId = process.argv[2];
if (!runId) {
  console.error("usage: supervisor <runId>");
  process.exit(1);
}

await supervise(runId);
