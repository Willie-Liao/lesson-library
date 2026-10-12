import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
const envArg = existsSync(envFile) ? ["--env-file=.env"] : [];
const servicesOnly = process.argv.includes("--services");

export function childAction(portBusy: boolean, shuttingDown: boolean): "start" | "skip" | "stop" {
  if (shuttingDown) return "stop";
  return portBusy ? "skip" : "start";
}

export function afterExit(owned: boolean, shuttingDown: boolean): "restart" | "leave" {
  if (!owned || shuttingDown) return "leave";
  return "restart";
}

export function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(300);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

type Owned = { name: string; child: ChildProcess };

const owned: Owned[] = [];
let shuttingDown = false;

function track(name: string, child: ChildProcess, restart: () => void) {
  owned.push({ name, child });
  child.on("exit", (code) => {
    const index = owned.findIndex((row) => row.child === child);
    if (index >= 0) owned.splice(index, 1);
    if (afterExit(true, shuttingDown) === "restart") {
      console.warn(name, "exited", code, "— restarting");
      setTimeout(restart, 400);
    }
  });
}

function spawnLibrary(): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", ...envArg, "server/index.ts"], {
    cwd: root,
    stdio: "inherit",
  });
}

function spawnEmbed(): ChildProcess {
  return spawn("python3", [path.join(root, "scripts", "embed_server.py")], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env },
  });
}

function spawnMcp(): ChildProcess {
  return spawn("python3", [path.join(root, "mcp", "server.py")], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env },
  });
}

function spawnEsbuildWatch(): ChildProcess {
  return spawn(
    path.join(root, "node_modules/esbuild/bin/esbuild"),
    ["web/app.ts", "--bundle", "--outfile=web/app.js", "--format=iife", "--sourcemap", "--watch=forever"],
    { cwd: root, stdio: "inherit" },
  );
}

async function bootPort(name: string, port: number, start: () => ChildProcess) {
  const action = childAction(await portOpen(port), shuttingDown);
  if (action !== "start") {
    if (action === "skip") console.warn(name, "already listening on", port);
    return;
  }
  const child = start();
  child.on("error", (err) => console.warn(name, "not started:", err.message));
  track(name, child, () => {
    void bootPort(name, port, start);
  });
}

function bootEsbuild() {
  if (shuttingDown) return;
  const child = spawnEsbuildWatch();
  child.on("error", (err) => console.warn("esbuild not started:", err.message));
  track("esbuild", child, bootEsbuild);
}

function buildOnce() {
  const appJs = path.join(root, "web", "app.js");
  if (existsSync(appJs)) return;
  const built = spawnSync(
    path.join(root, "node_modules/esbuild/bin/esbuild"),
    ["web/app.ts", "--bundle", "--outfile=web/app.js", "--format=iife", "--sourcemap"],
    { cwd: root, stdio: "inherit" },
  );
  if (built.status) process.exit(built.status);
}

function shutdown() {
  shuttingDown = true;
  for (const row of owned) {
    try {
      row.child.kill();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}

async function main() {
  if (servicesOnly) buildOnce();
  else bootEsbuild();
  await bootPort("library", 8787, spawnLibrary);
  await bootPort("embed", 8788, spawnEmbed);
  await bootPort("mcp", 8789, spawnMcp);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) void main();
