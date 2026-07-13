#!/usr/bin/env node
// Single entrypoint for npx / git installs -- dispatches to the runner's CLIs:
//
//   kimi-workflows run <script.js> [flags]     execute a workflow (run-workflow)
//   kimi-workflows fleet status|answer [...]     supervise concurrent runs (fleet)
//   kimi-workflows view [target] [...]           generate/open the HTML run viewer
//   kimi-workflows map [target] [...]            render the ASCII execution map
//   kimi-workflows summarize [target] [...]      cost/performance/reliability report
//   kimi-workflows doctor                      check that Kimi CLI is ready
//
// e.g.  npx github:da-moon/claude-dynamic-workflows-kimi doctor

import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "..", "runner");
const MAP = {
  run: "bin/run-workflow.js",
  fleet: "bin/fleet.js",
  supervise: "bin/supervise.js",
  view: "bin/view-run.js",
  map: "bin/map-run.js",
  summarize: "bin/summarize-run.js",
  compare: "bin/compare-runs.js",
  doctor: "test/handshake.js",
};

const [cmd, ...rest] = process.argv.slice(2);
const wantsHelp = (s) => s === "-h" || s === "--help" || s === "help";
if (!cmd || wantsHelp(cmd) || !MAP[cmd] || (cmd === "doctor" && rest.some(wantsHelp))) {
  console.error(
    "usage: kimi-workflows <command> [args]\n\n" +
      "  run <script.js> [flags]   execute a workflow against Kimi CLI\n" +
      "  fleet status|answer [...]   supervise concurrent runs\n" +
      "  supervise -- <cmd> [args] wrap ANY command in the fleet protocol (gates via @@ASK)\n" +
      "  view [target] [...]         generate/open the HTML run viewer\n" +
      "  map [target] [...]          render the ASCII execution map\n" +
      "  summarize [target] [...]    cost/performance/reliability report (one run)\n" +
      "  compare [dir ...]           cost/reliability/trend across MANY runs\n" +
      "  doctor                      check that Kimi CLI is ready\n" +
      "                            (takes no flags -- it just runs the check)\n\n" +
      "Each other command accepts its underlying CLI's flags (pass -h for them).",
  );
  // help was asked for -> success; an unknown command -> error
  process.exit(!cmd || wantsHelp(cmd) || (cmd === "doctor" && MAP[cmd]) ? 0 : 1);
}

const child = spawn(process.execPath, [join(RUNNER, MAP[cmd]), ...rest], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
