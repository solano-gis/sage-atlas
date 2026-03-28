import { chromium, type Browser, type Page } from "playwright";
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.js";
import type { Server } from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const OUTPUT_DIR = join(PROJECT_ROOT, "output");
const LOCKFILE = join(PROJECT_ROOT, ".atlas-daemon");
const DEFAULT_WEBMAP = "a30df87e755e4cab87acb5d9181bc11c";
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// --- Daemon IPC via Express ---

import express from "express";
import { createServer as createHttpServer } from "node:http";

interface DaemonInfo {
  pid: number;
  apiPort: number;
  mapPort: number;
}

/**
 * Check if daemon is running. Returns daemon info or null.
 */
export function getDaemonInfo(): DaemonInfo | null {
  if (!existsSync(LOCKFILE)) return null;
  try {
    const info: DaemonInfo = JSON.parse(readFileSync(LOCKFILE, "utf-8"));
    // Check if process is still alive
    try {
      process.kill(info.pid, 0);
      return info;
    } catch {
      // Process is dead, clean up lockfile
      unlinkSync(LOCKFILE);
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Send a command to the running daemon via HTTP.
 */
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

/**
 * Stop the daemon.
 */
export async function stopDaemon(): Promise<boolean> {
  const info = getDaemonInfo();
  if (!info) return false;
  try {
    await fetch(`http://127.0.0.1:${info.apiPort}/shutdown`, { method: "POST" });
  } catch {
    // If fetch fails, kill directly
    try { process.kill(info.pid, "SIGTERM"); } catch { /* already dead */ }
  }
  if (existsSync(LOCKFILE)) unlinkSync(LOCKFILE);
  return true;
}

/**
 * Start the daemon process. This function runs forever (it IS the daemon).
 * Called from cli.ts in a detached child process.
 */
export async function startDaemon(webmapId: string = DEFAULT_WEBMAP): Promise<void> {
  // Ensure output dir
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Start map page server
  const { server: mapServer, port: mapPort } = await startServer(0);

  // Launch browser with WebGL support (SwiftShader software renderer)
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--enable-unsafe-swiftshader",
      "--enable-webgl",
      "--enable-webgl2",
      "--ignore-gpu-blocklist",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  });
  const page = await context.newPage();
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

  // Command handlers
  async function handleCommand(
    command: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    resetInactivity();

    switch (command) {
      case "goto":
        return page.evaluate((a) => (window as any).atlasGoTo(a), args);

      case "zoom":
        return page.evaluate(
          ({ direction, levels }) => (window as any).atlasZoom(direction, levels),
          args as { direction: string; levels?: number }
        );

      case "layers":
        return page.evaluate(
          ({ show, hide }) => (window as any).atlasLayers(show, hide),
          args as { show?: string[]; hide?: string[] }
        );

      case "highlight":
        return page.evaluate((a) => (window as any).atlasHighlight(a), args);

      case "overlay":
        return page.evaluate((a) => (window as any).atlasOverlay(a), args);

      case "annotate":
        return page.evaluate((a) => (window as any).atlasAnnotate(a), args);

      case "screenshot": {
        const opts = args as {
          filename?: string;
          width?: number;
          height?: number;
          dpi?: number;
          destination?: string;
        };
        const filename = opts.filename || `atlas-${Date.now()}.png`;
        const outputPath = opts.destination || join(OUTPUT_DIR, filename);

        // Ensure destination directory exists
        mkdirSync(dirname(outputPath), { recursive: true });

        // Resize viewport if requested
        const width = opts.width || 1920;
        const height = opts.height || 1080;
        const currentViewport = page.viewportSize();
        if (currentViewport?.width !== width || currentViewport?.height !== height) {
          await page.setViewportSize({ width, height });
          // Wait for map to re-render after resize
          await page.evaluate(() => {
            return new Promise<void>((resolve) => {
              const view = (window as any).atlasView;
              if (!view.updating) { setTimeout(resolve, 500); return; }
              const handle = view.watch("updating", (updating: boolean) => {
                if (!updating) {
                  handle.remove();
                  setTimeout(resolve, 500);
                }
              });
            });
          });
        }

        const scale = opts.dpi ? opts.dpi / 96 : 1;
        const buffer = await page.screenshot({
          type: "png",
          fullPage: false,
          scale: scale === 1 ? "css" : "device",
        });
        writeFileSync(outputPath, buffer);

        return { path: outputPath, width, height, bytes: buffer.length };
      }

      case "state":
        return page.evaluate(() => (window as any).atlasGetState());

      case "webmap": {
        const id = (args as { webmapId: string }).webmapId;
        await page.goto(`http://127.0.0.1:${mapPort}?webmap=${id}`);
        await page.waitForFunction(() => document.title === "READY", { timeout: 60000 });
        return { webmapId: id };
      }

      default:
        throw new Error(`Unknown command: ${command}`);
    }
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

  // Cleanup
  async function shutdown() {
    clearTimeout(inactivityTimer);
    if (existsSync(LOCKFILE)) {
      try { unlinkSync(LOCKFILE); } catch { /* ignore */ }
    }
    try { await browser.close(); } catch { /* ignore */ }
    try { apiServer.close(); } catch { /* ignore */ }
    try { mapServer.close(); } catch { /* ignore */ }
    process.exit(0);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// If run directly, start the daemon
if (process.argv[1] && process.argv[1].endsWith("renderer.ts") || process.argv[1]?.endsWith("renderer.js")) {
  const webmap = process.argv.find((a) => a.startsWith("--webmap="))?.split("=")[1];
  startDaemon(webmap).catch((err) => {
    console.error("Daemon failed:", err.message);
    process.exit(1);
  });
}
