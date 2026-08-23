/**
 * Runs the API and the Vite dev server together with prefixed output.
 * Vite proxies /api, /media and /socket.io to the API, so the browser only
 * ever talks to one origin.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const COLOURS = { api: "\x1b[36m", web: "\x1b[35m", reset: "\x1b[0m" };

// The two ports are assigned here rather than inherited: a PORT set by an outer
// tool (an IDE preview pane, a hosting shim) would otherwise land on both.
const API_PORT = Number(process.env.LUMEN_API_PORT ?? 4310);
const WEB_PORT = Number(process.env.LUMEN_WEB_PORT ?? 5190);

const children = [];
let shuttingDown = false;

function run(name, command, args, cwd, env = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = `${COLOURS[name]}[${name}]${COLOURS.reset} `;
  const write = (stream) => (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) stream.write(prefix + line + "\n");
    }
  };
  child.stdout.on("data", write(process.stdout));
  child.stderr.on("data", write(process.stderr));
  child.on("exit", (code) => {
    if (shuttingDown) return;
    console.log(`${prefix}exited with code ${code}`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 250);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("api", "node", ["--watch", "--watch-preserve-output", "src/index.ts"], path.join(root, "server"), {
  PORT: String(API_PORT),
});
run("web", "npx", ["vite", "--port", String(WEB_PORT), "--strictPort"], path.join(root, "web"), {
  PORT: String(WEB_PORT),
  LUMEN_API: `http://localhost:${API_PORT}`,
});
