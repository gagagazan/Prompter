import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
const args = process.argv.slice(2);
const env = { ...process.env };

if (process.platform === "darwin" && args[0] === "dev") {
  const runner = path.join(projectRoot, "src-tauri", "scripts", "macos-dev-runner.sh");
  env.CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER = runner;
  env.CARGO_TARGET_X86_64_APPLE_DARWIN_RUNNER = runner;
}

const child = spawn(process.execPath, [cli, ...args], {
  cwd: projectRoot,
  env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Could not start the Tauri CLI: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
