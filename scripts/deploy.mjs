#!/usr/bin/env node
// Build the web app and deploy the Worker with your tracker.config.json values.
import { spawnSync } from "node:child_process";
import { writeDeployConfig } from "./wrangler-config.mjs";

const run = (cmd, args, cwd = ".") => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run("npm", ["run", "build"]);
const config = writeDeployConfig();
run("npx", ["wrangler", "deploy", "--config", config, ...process.argv.slice(2)], "worker");
