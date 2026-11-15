import { spawn } from "node:child_process";

const listener = process.argv[2];
const port = process.argv[3];
const token = process.argv[4];

// `start /b` leaves the listener outside the launcher tree. taskkill /T of
// the pnpm shell therefore does not reach it. Node's own detached option
// still dies with that tree on this Windows host.
const child = process.platform === "win32"
  ? spawn("cmd.exe", [
      "/d", "/s", "/c", "start", "\"\"", "/b",
      process.execPath, listener, port, token,
    ], { detached: true, stdio: "ignore", windowsHide: true })
  : spawn(process.execPath, [listener, port, token], {
      detached: true,
      stdio: "ignore",
    });
child.unref();

async function announce() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if ((await response.text()) === token) {
        process.stdout.write("Ready\n");
        return;
      }
    } catch {
      // The detached listener is still binding.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  process.stderr.write("detached listener did not start\n");
  process.exit(1);
}

announce();
setInterval(() => {}, 1_000);
