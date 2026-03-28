import { chromium } from "playwright";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const OUTPUT_DIR = join(PROJECT_ROOT, "output");
const LOCKFILE = join(PROJECT_ROOT, ".atlas-daemon");
const DEFAULT_WEBMAP = "a30df87e755e4cab87acb5d9181bc11c";
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

import express from "express";
import { createServer as createHttpServer } from "node:http";

interface DaemonInfo {
  pid: number;
  apiPort: number;
  mapPort: number;
}

export function getDaemonInfo(): DaemonInfo | null {
  let info: DaemonInfo;
  try {
    info = JSON.parse(readFileSync(LOCKFILE, "utf-8"));
  } catch {
    return null;
  }
  try {
    process.kill(info.pid, 0);
    return info;
  } catch {
    try { unlinkSync(LOCKFILE); } catch { /* already gone */ }
    return null;
  }
}

export async function sendCommand(
  info: DaemonInfo,
  command: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${info.apiPort}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, args }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Daemon error (${res.status}): ${text}`);
  }
  return res.json();
}

export async function stopDaemon(): Promise<boolean> {
  const info = getDaemonInfo();
  if (!info) return false;
  try {
    await fetch(`http://127.0.0.1:${info.apiPort}/shutdown`, { method: "POST" });
  } catch {
    try { process.kill(info.pid, "SIGTERM"); } catch { /* already dead */ }
  }
  try { unlinkSync(LOCKFILE); } catch { /* already gone */ }
  return true;
}

export async function startDaemon(webmapId: string = DEFAULT_WEBMAP): Promise<void> {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Launch server + browser in parallel (browser launch is the slow part)
  const [{ server: mapServer, port: mapPort }, browser] = await Promise.all([
    startServer(0),
    chromium.launch({
      headless: true,
      args: [
        "--enable-unsafe-swiftshader",
        "--enable-webgl",
        "--enable-webgl2",
        "--ignore-gpu-blocklist",
      ],
    }),
  ]);

  const page = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  }).then((ctx) => ctx.newPage());
  await page.goto(`http://127.0.0.1:${mapPort}?webmap=${webmapId}`);

  // Wait for ArcGIS to load
  await page.waitForFunction(() => document.title === "READY", { timeout: 60000 });

  // Inactivity timer
  let inactivityTimer: ReturnType<typeof setTimeout>;
  function resetInactivity() {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      shutdown();
    }, INACTIVITY_TIMEOUT_MS);
  }
  resetInactivity();

  // Screenshot helper — reused by explicit screenshot command and auto-screenshot
  let outputDirVerified = false;
  async function takeScreenshot(opts: {
    filename?: string;
    width?: number;
    height?: number;
    dpi?: number;
    destination?: string;
  } = {}): Promise<{ path: string; width: number; height: number; bytes: number }> {
    const filename = opts.filename || `atlas-${Date.now()}.jpg`;
    const outputPath = opts.destination || join(OUTPUT_DIR, filename);

    if (opts.destination) {
      mkdirSync(dirname(outputPath), { recursive: true });
    } else if (!outputDirVerified) {
      mkdirSync(OUTPUT_DIR, { recursive: true });
      outputDirVerified = true;
    }

    const width = opts.width || 1920;
    const height = opts.height || 1080;
    const currentViewport = page.viewportSize();
    if (currentViewport?.width !== width || currentViewport?.height !== height) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => (window as any).waitForTiles());
    }

    const scale = opts.dpi ? opts.dpi / 96 : 1;
    const buffer = await page.screenshot({
      type: "jpeg",
      quality: 85,
      fullPage: false,
      scale: scale === 1 ? "css" : "device",
    });
    await writeFile(outputPath, buffer);

    return { path: outputPath, width, height, bytes: buffer.length };
  }

  // Command handlers
  async function handleCommand(
    command: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    resetInactivity();

    // Extract screenshot flag — if true, auto-capture after the command
    const wantScreenshot = !!args.screenshot;
    const commandArgs = { ...args };
    delete commandArgs.screenshot;

    let result: unknown;

    switch (command) {
      case "goto":
        result = await page.evaluate((a) => (window as any).atlasGoTo(a), commandArgs);
        break;

      case "zoom":
        result = await page.evaluate(
          ({ direction, levels }) => (window as any).atlasZoom(direction, levels),
          commandArgs as { direction: string; levels?: number }
        );
        break;

      case "layers":
        result = await page.evaluate(
          ({ show, hide }) => (window as any).atlasLayers(show, hide),
          commandArgs as { show?: string[]; hide?: string[] }
        );
        break;

      case "highlight":
        result = await page.evaluate((a) => (window as any).atlasHighlight(a), commandArgs);
        break;

      case "overlay":
        result = await page.evaluate((a) => (window as any).atlasOverlay(a), commandArgs);
        break;

      case "annotate":
        result = await page.evaluate((a) => (window as any).atlasAnnotate(a), commandArgs);
        break;

      case "screenshot":
        return takeScreenshot(commandArgs as Parameters<typeof takeScreenshot>[0]);

      case "state":
        return page.evaluate(() => (window as any).atlasGetState());

      case "webmap": {
        const id = (commandArgs as { webmapId: string }).webmapId;
        await page.goto(`http://127.0.0.1:${mapPort}?webmap=${id}`);
        await page.waitForFunction(() => document.title === "READY", { timeout: 60000 });
        return { webmapId: id };
      }

      default:
        throw new Error(`Unknown command: ${command}`);
    }

    if (wantScreenshot) {
      const ss = await takeScreenshot();
      return { ...(result as object), screenshot: ss.path };
    }

    return result;
  }

  // Start API server for CLI communication
  const apiApp = express();
  apiApp.use(express.json());

  apiApp.post("/command", async (req, res) => {
    try {
      const { command, args } = req.body;
      const result = await handleCommand(command, args || {});
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  apiApp.post("/shutdown", (_req, res) => {
    res.json({ ok: true });
    shutdown();
  });

  apiApp.get("/health", (_req, res) => {
    res.json({ ok: true, pid: process.pid });
  });

  const apiServer = createHttpServer(apiApp);
  await new Promise<void>((resolve, reject) => {
    apiServer.listen(0, "127.0.0.1", () => resolve());
    apiServer.on("error", reject);
  });

  const apiAddr = apiServer.address();
  if (!apiAddr || typeof apiAddr === "string") {
    throw new Error("Failed to get API server address");
  }
  const apiPort = apiAddr.port;

  // Write lockfile
  const daemonInfo: DaemonInfo = { pid: process.pid, apiPort, mapPort };
  writeFileSync(LOCKFILE, JSON.stringify(daemonInfo));

  // Write port to stdout so the spawning CLI can read it
  process.stdout.write(JSON.stringify(daemonInfo) + "\n");

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(inactivityTimer);
    try { rmSync(LOCKFILE, { force: true }); } catch { /* ignore */ }
    try { await browser.close(); } catch { /* ignore */ }
    try { apiServer.close(); } catch { /* ignore */ }
    try { mapServer.close(); } catch { /* ignore */ }
    process.exit(0);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// If run directly, start the daemon
if (process.argv[1] && (process.argv[1].endsWith("renderer.ts") || process.argv[1].endsWith("renderer.js"))) {
  const webmap = process.argv.find((a) => a.startsWith("--webmap="))?.split("=")[1];
  startDaemon(webmap).catch((err) => {
    console.error("Daemon failed:", err.message);
    process.exit(1);
  });
}
