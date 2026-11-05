import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { expect, it } from "vitest";
import { laneSmokePort, reservePort, startSpawnedServer } from "./spawned-server";

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
    const server = net.createServer();
    server.on("error", (error) => {
      process.stdout.write(String(error.code) + "\\n");
      process.exit(1);
    });
    server.listen(${stranger.port}, "127.0.0.1");
  `;
  try {
    await expect(
      startSpawnedServer({
        command: process.execPath,
        args: ["-e", script],
        port: stranger.port,
        healthUrl: `http://127.0.0.1:${stranger.port}/api/health`,
        healthOk: (status) => status === 200 || status === 503,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/taken|EADDRINUSE|exited/i);
    const still = await fetch(`http://127.0.0.1:${stranger.port}/api/health`);
    expect(still.status).toBe(503);
    expect(await still.text()).toBe("stranger");
  } finally {
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
