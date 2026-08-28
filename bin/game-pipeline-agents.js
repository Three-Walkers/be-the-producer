#!/usr/bin/env node
import { exec, execFile } from "node:child_process";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const port = readArgValue(args, "--port") ?? process.env.PORT ?? "8787";
const host = readArgValue(args, "--host") ?? process.env.HOST ?? "127.0.0.1";
const shouldOpen = args.includes("--open");

if (!isLoopbackHost(host) && !process.env.BTP_API_TOKEN) {
  console.error("Refusing to bind the API to a non-loopback host without BTP_API_TOKEN.");
  process.exit(1);
}

process.env.PORT = port;
process.env.HOST = host;
process.env.INIT_CWD = process.env.INIT_CWD ?? repoRoot;

// On Windows, npm is exposed as npm.cmd rather than an executable named npm.
// Calling npm.cmd explicitly keeps this launcher working from PowerShell and cmd.
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const build = spawnSync(npmCommand, ["run", "build"], {
  cwd: repoRoot,
  // Node requires a shell to launch .cmd shims on Windows.
  shell: process.platform === "win32",
  stdio: "inherit"
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const serverModule = await import(pathToFileURL(join(repoRoot, "apps", "api", "dist", "server.js")).href);
serverModule.startServer(Number(port), host);

if (shouldOpen) {
  const url = `http://localhost:${port}`;
  if (process.platform === "win32") {
    // `start` is a cmd builtin; the empty title prevents the URL from being
    // interpreted as a window title.
    exec(`start "" ${JSON.stringify(url)}`);
  } else if (process.platform === "darwin") {
    execFile("open", [url]);
  } else {
    execFile("xdg-open", [url]);
  }
}

function readArgValue(values, name) {
  const index = values.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return values[index + 1];
}

function isLoopbackHost(value) {
  const host = value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const ipv4 = host.startsWith("::ffff:") ? host.slice("::ffff:".length) : host;
  const octets = ipv4.split(".");
  return octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) && Number(octets[0]) === 127;
}
