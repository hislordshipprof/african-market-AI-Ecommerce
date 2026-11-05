import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { expect, it } from "vitest";
import { laneSmokePort, reservePort, startSpawnedServer } from "./spawned-server";

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True once `pid` is gone. A live process stays false for the whole wait. */
async function waitUntilDead(pid: number, ms = 2_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processAlive(pid);
}

function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const killer = process.platform === "win32"
      ? spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true })
      : spawn("kill", ["-TERM", String(pid)], { stdio: "ignore" });
    killer.on("exit", () => resolve());
    killer.on("error", () => resolve());
  });
}

function listenOn(port: number): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      resolve({
        port: actual,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

function httpOn(
  port: number,
  status: number,
  body: string,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createHttpServer((_req, res) => {
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(body);
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      resolve({
        port: actual,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

it("gives each lane its own smoke port", () => {
  expect(laneSmokePort("3000")).toBe(3299);
  expect(laneSmokePort("3100")).toBe(3399);
  expect(laneSmokePort("3200")).toBe(3499);
  expect(new Set([laneSmokePort("3000"), laneSmokePort("3100"), laneSmokePort("3200")]).size).toBe(3);
});

it("rejects an E2E_PORT that cannot host a smoke port", () => {
  expect(() => laneSmokePort("0")).toThrow(/port/i);
  expect(() => laneSmokePort("nope")).toThrow(/port/i);
  expect(() => laneSmokePort("65535")).toThrow(/port/i);
});

it("does not return a port a dummy listener already holds", async () => {
  const held = await listenOn(0);
  try {
    expect(await reservePort(held.port)).not.toBe(held.port);
    expect(await reservePort(held.port)).not.toBe(held.port);
  } finally {
    await held.close();
  }
});

it("returns the preferred port when that port is free", async () => {
  const probe = await listenOn(0);
  const preferred = probe.port;
  await probe.close();
  expect(await reservePort(preferred)).toBe(preferred);
});

it("does not treat a stranger health response as this child", async () => {
  const stranger = await httpOn(0, 503, "stranger");
  const script = `
    const net = require("node:net");
    process.stdout.write("PID=" + process.pid + "\\n");
    const server = net.createServer();
    server.on("error", (error) => {
      process.stdout.write(String(error.code) + "\\n");
      setInterval(() => {}, 1000);
    });
    server.listen(${stranger.port}, "127.0.0.1");
  `;
  let childPid = 0;
  try {
    let message = "";
    try {
      await startSpawnedServer({
        command: process.execPath,
        args: ["-e", script],
        port: stranger.port,
        healthUrl: `http://127.0.0.1:${stranger.port}/api/health`,
        healthOk: (status) => status === 200 || status === 503,
        timeoutMs: 5_000,
      });
      message = "resolved";
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/taken|EADDRINUSE/i);
    childPid = Number(message.match(/PID=(\d+)/)?.[1]);
    expect(childPid).toBeGreaterThan(0);
    expect(await waitUntilDead(childPid)).toBe(true);
    const still = await fetch(`http://127.0.0.1:${stranger.port}/api/health`);
    expect(still.status).toBe(503);
    expect(await still.text()).toBe("stranger");
  } finally {
    if (childPid > 0 && processAlive(childPid)) await killTree(childPid);
    await stranger.close();
  }
});

it("waits until this child is ready and stop releases the port", async () => {
  const port = await reservePort();
  const token = "child-ready-token";
  const script = `
    const http = require("node:http");
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(${JSON.stringify(token)});
    });
    server.listen(${port}, "127.0.0.1", () => {
      process.stdout.write("Ready\\n");
    });
  `;
  const running = await startSpawnedServer({
    command: process.execPath,
    args: ["-e", script],
    port,
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    healthOk: (status) => status === 200,
    timeoutMs: 5_000,
  });
  expect(await (await fetch(`http://127.0.0.1:${port}/api/health`)).text()).toBe(token);
  await running.stop();
  await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
});

it("stop kills the listener pnpm exec leaves after the launcher is gone", async () => {
  const port = await reservePort();
  const token = "detached-listener";
  const launcher = path.join(process.cwd(), "e2e/fixtures/detached-launcher.mjs").replaceAll("\\", "/");
  const listener = path.join(process.cwd(), "e2e/fixtures/detached-listener.mjs").replaceAll("\\", "/");
  const running = await startSpawnedServer({
    command: `pnpm exec node "${launcher}" "${listener}" ${port} ${token}`,
    shell: true,
    port,
    healthUrl: `http://127.0.0.1:${port}/`,
    healthOk: (status) => status === 200,
    timeoutMs: 20_000,
  });
  try {
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe(token);
    if (running.pid === undefined) throw new Error("launcher pid missing");
    await killTree(running.pid);
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe(token);
    await running.stop();
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    const rebound = await listenOn(port);
    expect(rebound.port).toBe(port);
    await rebound.close();
  } finally {
    await running.stop();
  }
}, 40_000);

it("a start that never becomes ready kills the child that stays up", async () => {
  const port = await reservePort();
  const script = `
    process.stdout.write("PID=" + process.pid + "\\n");
    setInterval(() => {}, 1000);
  `;
  let childPid = 0;
  try {
    let message = "";
    try {
      await startSpawnedServer({
        command: process.execPath,
        args: ["-e", script],
        port,
        timeoutMs: 400,
      });
      message = "resolved";
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/not ready/i);
    childPid = Number(message.match(/PID=(\d+)/)?.[1]);
    expect(childPid).toBeGreaterThan(0);
    expect(await waitUntilDead(childPid)).toBe(true);
  } finally {
    if (childPid > 0 && processAlive(childPid)) await killTree(childPid);
  }
});

it("fails when the child exits before it is ready", async () => {
  const port = await reservePort();
  await expect(
    startSpawnedServer({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      port,
      timeoutMs: 3_000,
    }),
  ).rejects.toThrow(/exited/i);
});
