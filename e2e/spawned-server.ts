import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

const SMOKE_PORT_OFFSET = 299;

/**
 * Port for a lane's extra production server. Playwright keeps `E2E_PORT`.
 * 3000 → 3299, 3100 → 3399, 3200 → 3499, so lanes do not share one port.
 * Each Playwright worker adds its parallel index, so workers in one lane do not race for it.
 */
export function laneSmokePort(
  e2ePort: string = process.env.E2E_PORT || "3000",
  worker: string = process.env.TEST_PARALLEL_INDEX || "0",
): number {
  if (!/^[1-9]\d*$/.test(e2ePort)) {
    throw new Error(`E2E_PORT must be a port number, received ${e2ePort}`);
  }
  const base = Number(e2ePort);
  if (base > 65535) {
    throw new Error(`E2E_PORT must be a port number, received ${e2ePort}`);
  }
  const preferred = base + SMOKE_PORT_OFFSET + (/^\d+$/.test(worker) ? Number(worker) : 0);
  if (preferred > 65535) {
    throw new Error(`smoke port ${preferred} is outside the port range`);
  }
  return preferred;
}

function bindEphemeral(avoid?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => {
        if (error) reject(error);
        else if (avoid !== undefined && port === avoid) resolve(bindEphemeral(avoid));
        else resolve(port);
      });
    });
  });
}

function freeOn(port: number, host: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
      else reject(error);
    });
    probe.listen(port, host, () => {
      probe.close((error) => (error ? reject(error) : resolve(true)));
    });
  });
}

/**
 * Preferred port when it is free; otherwise a free port that is not that one.
 * `next start` binds all interfaces (::), and macOS lets a loopback probe succeed
 * beside a :: listener and the reverse, so both must be free.
 */
export async function reservePort(preferred?: number): Promise<number> {
  if (preferred === undefined) return bindEphemeral();
  if ((await freeOn(preferred, "127.0.0.1")) && (await freeOn(preferred, "::"))) return preferred;
  return bindEphemeral(preferred);
}

/**
 * PIDs that own a listener on `port`.
 * `netstat -ano` omits node sockets bound to 127.0.0.1 on this Windows host,
 * so a detached listener survives `stop()`. Get-NetTCPConnection returns them.
 * RemotePort 0 is the listener; established clients have a remote port.
 */
function pidsListeningOn(port: number): Promise<number[]> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve([]);
  if (process.platform === "win32") return windowsListeners(port);
  if (process.platform === "darwin") return lsofListeners(port);
  return ssListeners(port);
}

function windowsListeners(port: number): Promise<number[]> {
  const script = [
    `$rows = Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue`,
    "$rows | Where-Object { $_.RemotePort -eq 0 -and $_.OwningProcess -gt 0 } | Select-Object -ExpandProperty OwningProcess",
  ].join("; ");
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-Command", script],
      { windowsHide: true, encoding: "utf8", timeout: 20_000 },
      (error, stdout) => {
        if (error || typeof stdout !== "string") {
          resolve([]);
          return;
        }
        resolve(pidsFromLines(stdout));
      },
    );
  });
}

// macOS has no `ss`.
function lsofListeners(port: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8", timeout: 5_000 },
      (error, stdout) => {
        // lsof exits 1 when nothing listens; stdout is then empty.
        resolve(typeof stdout === "string" ? pidsFromLines(stdout) : []);
      },
    );
  });
}

function ssListeners(port: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile(
      "ss",
      ["-H", "-ltnp", `sport = :${port}`],
      { encoding: "utf8", timeout: 5_000 },
      (error, stdout) => {
        if (error || typeof stdout !== "string") {
          resolve([]);
          return;
        }
        const pids = new Set<number>();
        for (const match of stdout.matchAll(/pid=(\d+)/g)) {
          const pid = Number(match[1]);
          if (pid > 0) pids.add(pid);
        }
        resolve([...pids]);
      },
    );
  });
}

function pidsFromLines(stdout: string): number[] {
  const pids = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    const pid = Number(line.trim());
    if (pid > 0) pids.add(pid);
  }
  return [...pids];
}

function forceKill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const killer =
      process.platform === "win32"
        ? spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true })
        : spawn("kill", ["-TERM", String(pid)], { stdio: "ignore" });
    killer.on("exit", () => resolve());
    killer.on("error", () => resolve());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function releaseChild(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined) await forceKill(child.pid);
}

/** Kills this child and any listener it left on the port (`pnpm exec` detaches `next`). */
async function releaseOwned(child: ChildProcess, port: number): Promise<void> {
  if (child.pid !== undefined) await forceKill(child.pid);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const pids = await pidsListeningOn(port);
    if (pids.length === 0) return;
    await Promise.all(pids.map((pid) => forceKill(pid)));
    await sleep(200);
  }
}

export type StartSpawnedServerOptions = {
  command: string;
  args?: readonly string[];
  shell?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  port: number;
  readyText?: string;
  busyText?: string;
  healthUrl?: string;
  healthOk?: (status: number) => boolean;
  timeoutMs?: number;
  healthTimeoutMs?: number;
};

export type RunningServer = {
  port: number;
  /** Launcher PID. A detached listener is not this process. */
  pid: number | undefined;
  stop: () => Promise<void>;
};

/**
 * Starts a child and resolves only after that child prints its ready line.
 * A health response before then, including a stranger already bound to the
 * port, does not count. A failed start kills this child and leaves the stranger.
 */
export async function startSpawnedServer(options: StartSpawnedServerOptions): Promise<RunningServer> {
  const readyText = options.readyText ?? "Ready";
  const busyText = options.busyText ?? "EADDRINUSE";
  const timeoutMs = options.timeoutMs ?? 60_000;
  const child: ChildProcess = options.args
    ? spawn(options.command, [...options.args], {
        shell: options.shell ?? false,
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
    : spawn(options.command, {
        shell: options.shell ?? false,
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  let logs = "";
  let exited = false;
  let exitCode: number | null = null;
  child.stdout?.on("data", (chunk: string) => {
    logs += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    logs += chunk;
  });
  child.on("error", (error) => {
    logs += `${error.message}\n`;
    exited = true;
  });
  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
  });

  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    const readyAt = logs.indexOf(readyText);
    const busyAt = logs.indexOf(busyText);
    if (busyAt !== -1 && (readyAt === -1 || busyAt < readyAt)) {
      await releaseChild(child);
      throw new Error(`port ${options.port} is already taken\n${logs}`);
    }
    if (exited && readyAt === -1) {
      await releaseChild(child);
      throw new Error(`server exited before it was ready (code ${exitCode})\n${logs}`);
    }
    if (readyAt !== -1) {
      ready = true;
      break;
    }
    await sleep(50);
  }
  if (!ready) {
    await releaseChild(child);
    throw new Error(`server was not ready within ${timeoutMs}ms\n${logs}`);
  }
  if (exited) {
    await releaseChild(child);
    throw new Error(`server exited before it was ready (code ${exitCode})\n${logs}`);
  }

  if (options.healthUrl) {
    const healthOk = options.healthOk ?? ((status: number) => status === 200);
    const healthDeadline = Date.now() + (options.healthTimeoutMs ?? 15_000);
    let healthy = false;
    while (Date.now() < healthDeadline) {
      if (exited) {
        await releaseOwned(child, options.port);
        throw new Error(`server exited before it was ready (code ${exitCode})\n${logs}`);
      }
      try {
        const response = await fetch(options.healthUrl, { signal: AbortSignal.timeout(1_000) });
        if (healthOk(response.status)) {
          healthy = true;
          break;
        }
      } catch {
        // The child printed Ready and is still coming up.
      }
      await sleep(200);
    }
    if (exited) {
      await releaseOwned(child, options.port);
      throw new Error(`server exited before it was ready (code ${exitCode})\n${logs}`);
    }
    if (!healthy) {
      await releaseOwned(child, options.port);
      throw new Error(`server health did not answer on port ${options.port}\n${logs}`);
    }
  }

  return {
    port: options.port,
    pid: child.pid,
    stop: () => releaseOwned(child, options.port),
  };
}
