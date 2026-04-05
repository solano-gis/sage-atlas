#!/usr/bin/env node

import { Command } from "commander";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { getDaemonInfo, sendCommand, stopDaemon } from "./renderer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function ensureDaemon(webmap?: string): Promise<{ pid: number; apiPort: number; mapPort: number }> {
  const existing = getDaemonInfo();
  if (existing) return existing;

  // Resolve renderer path — works with both tsx (src/) and compiled (dist/)
  const ext = __dirname.includes("dist") ? "js" : "ts";
  const rendererPath = join(__dirname, `renderer.${ext}`);
  const args = [rendererPath];
  if (webmap) args.push(`--webmap=${webmap}`);

  const isWindows = process.platform === "win32";

  return new Promise((resolve, reject) => {
    const child = isWindows
      ? spawn("cmd", ["/c", "npx", "tsx", ...args], {
          cwd: join(__dirname, ".."),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        })
      : spawn("npx", ["tsx", ...args], {
          cwd: join(__dirname, ".."),
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    function finish(info: { pid: number; apiPort: number; mapPort: number }) {
      if (resolved) return;
      resolved = true;
      if (lockfilePoller) clearInterval(lockfilePoller);
      child.unref();
      resolve(info);
    }

    child.stdout!.on("data", (data: Buffer) => {
      stdout += data.toString();
      // Daemon writes JSON info on first line when ready
      const lines = stdout.split("\n");
      for (const line of lines) {
        if (line.trim()) {
          try {
            const info = JSON.parse(line.trim());
            if (info.apiPort) finish(info);
          } catch {
            // Not JSON yet, keep waiting
          }
        }
      }
    });

    child.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // On Windows, stdout through cmd.exe may not flush reliably.
    // Poll the lockfile as a fallback signal that the daemon is ready.
    let lockfilePoller: ReturnType<typeof setInterval> | undefined;
    if (isWindows) {
      lockfilePoller = setInterval(() => {
        const info = getDaemonInfo();
        if (info) finish(info);
      }, 500);
    }

    child.on("error", (err) => {
      if (lockfilePoller) clearInterval(lockfilePoller);
      if (!resolved) reject(new Error(`Failed to spawn daemon: ${err.message}`));
    });

    child.on("exit", (code) => {
      if (lockfilePoller) clearInterval(lockfilePoller);
      if (!resolved) {
        reject(new Error(`Daemon exited with code ${code}. stderr: ${stderr}`));
      }
    });

    // Timeout after 90 seconds (ArcGIS initial load can be slow)
    setTimeout(() => {
      if (!resolved) {
        if (lockfilePoller) clearInterval(lockfilePoller);
        child.kill();
        reject(new Error(`Daemon startup timed out. stderr: ${stderr}`));
      }
    }, 90000);
  });
}

function parseRgba(val: string): number[] {
  return val.split(",").map(Number);
}

const program = new Command();
program
  .name("atlas")
  .description("Headless ArcGIS map renderer")
  .version("0.1.0");

// Helper: print command result, extracting screenshot path if present
function printResult(result: unknown) {
  const r = result as Record<string, unknown>;
  if (r.screenshot) {
    const { screenshot, ...rest } = r;
    if (Object.keys(rest).length > 0) console.log(JSON.stringify(rest, null, 2));
    console.log(screenshot);
  } else {
    console.log(JSON.stringify(r, null, 2));
  }
}

// --- goto ---
program
  .command("goto")
  .description("Navigate to a location")
  .option("--apn <apn>", "Parcel APN")
  .option("--address <address>", "Street address to geocode")
  .option("--center <lon,lat>", "Center coordinates (lon,lat)")
  .option("--extent <xmin,ymin,xmax,ymax>", "Map extent")
  .option("--zoom <number>", "Zoom level", parseInt)
  .option("--padding <number>", "Padding in pixels", parseInt)
  .option("--pixel <x,y>", "Center on this screen pixel from the last screenshot")
  .option("--webmap <name-or-id>", "Web map preset name or AGOL item ID")
  .action(async (opts) => {
    const info = await ensureDaemon();
    const args: Record<string, unknown> = { screenshot: true };
    if (opts.apn) args.apn = opts.apn;
    if (opts.address) args.address = opts.address;
    if (opts.center) args.center = opts.center.split(",").map(Number);
    if (opts.extent) args.extent = opts.extent.split(",").map(Number);
    if (opts.pixel) args.pixel = opts.pixel.split(",").map(Number);
    if (opts.zoom) args.zoom = opts.zoom;
    if (opts.padding) args.padding = opts.padding;
    if (opts.webmap) args.webmap = opts.webmap;
    printResult(await sendCommand(info, "goto", args));
  });

// --- zoom ---
program
  .command("zoom <direction>")
  .description("Zoom in or out")
  .option("--levels <number>", "Number of zoom levels", parseInt)
  .action(async (direction: string, opts) => {
    const info = await ensureDaemon();
    printResult(await sendCommand(info, "zoom", {
      direction,
      levels: opts.levels,
      screenshot: true,
    }));
  });

// --- layers ---
program
  .command("layers")
  .description("Toggle layer visibility")
  .option("--show <layers>", "Comma-separated layer names to show")
  .option("--hide <layers>", "Comma-separated layer names to hide")
  .option("--list", "List all layers with visibility")
  .option("--detailed", "Include URLs and field names")
  .action(async (opts) => {
    const info = await ensureDaemon();
    const args: Record<string, unknown> = {};
    if (opts.show) args.show = opts.show.split(",").map((s: string) => s.trim());
    if (opts.hide) args.hide = opts.hide.split(",").map((s: string) => s.trim());
    if (opts.detailed) args.detailed = true;
    const wantScreenshot = !!(opts.show || opts.hide);
    if (wantScreenshot) args.screenshot = true;
    printResult(await sendCommand(info, "layers", args));
  });

// --- measure ---
program
  .command("measure")
  .description("Measure distance between two screen pixels")
  .requiredOption("--from <x,y>", "Start pixel")
  .requiredOption("--to <x,y>", "End pixel")
  .action(async (opts) => {
    const info = await ensureDaemon();
    printResult(await sendCommand(info, "measure", {
      from: opts.from.split(",").map(Number),
      to: opts.to.split(",").map(Number),
    }));
  });

// --- identify ---
program
  .command("identify")
  .description("Query features at a point or within a rectangle")
  .option("--pixel <x,y>", "Screen pixel to identify")
  .option("--bbox <x1,y1,x2,y2>", "Screen pixel rectangle to query")
  .option("--fields <fields>", "Comma-separated field names (default: all)")
  .option("--limit <number>", "Max features per layer", parseInt)
  .action(async (opts) => {
    const info = await ensureDaemon();
    const args: Record<string, unknown> = {};
    if (opts.pixel) args.pixel = opts.pixel.split(",").map(Number);
    if (opts.bbox) args.bbox = opts.bbox.split(",").map(Number);
    if (opts.fields) args.fields = opts.fields.split(",").map((s: string) => s.trim());
    if (opts.limit) args.limit = opts.limit;
    printResult(await sendCommand(info, "identify", args));
  });

// --- highlight ---
program
  .command("highlight")
  .description("Highlight features on the map")
  .option("--apns <apns>", "Comma-separated APNs")
  .option("--clear", "Clear all highlights")
  .option("--color <r,g,b,a>", "Fill color RGBA")
  .option("--outline-color <r,g,b,a>", "Outline color RGBA")
  .option("--outline-width <number>", "Outline width", parseInt)
  .action(async (opts) => {
    const info = await ensureDaemon();
    const args: Record<string, unknown> = {};
    if (opts.clear) args.clear = true;
    if (opts.apns) args.apns = opts.apns.split(",").map((s: string) => s.trim());
    if (opts.color || opts.outlineColor || opts.outlineWidth) {
      args.style = {
        ...(opts.color && { color: parseRgba(opts.color) }),
        ...(opts.outlineColor && { outlineColor: parseRgba(opts.outlineColor) }),
        ...(opts.outlineWidth && { outlineWidth: opts.outlineWidth }),
      };
    }
    if (!opts.clear) args.screenshot = true;
    printResult(await sendCommand(info, "highlight", args));
  });

// --- overlay ---
program
  .command("overlay")
  .description("Add or remove a GeoJSON overlay")
  .requiredOption("--id <id>", "Overlay identifier")
  .option("--file <path>", "Path to GeoJSON file")
  .option("--remove", "Remove overlay by ID")
  .option("--color <r,g,b,a>", "Fill/point color RGBA")
  .option("--outline-color <r,g,b,a>", "Outline color RGBA")
  .option("--size <number>", "Point size", parseInt)
  .option("--label-field <field>", "Property to use for labels")
  .action(async (opts) => {
    const info = await ensureDaemon();
    const args: Record<string, unknown> = { id: opts.id };

    if (opts.remove) {
      args.remove = true;
    } else if (opts.file) {
      const { readFileSync } = await import("node:fs");
      args.geojson = JSON.parse(readFileSync(resolve(opts.file), "utf-8"));
      if (opts.color || opts.outlineColor || opts.size) {
        args.style = {
          ...(opts.color && { color: parseRgba(opts.color) }),
          ...(opts.outlineColor && { outlineColor: parseRgba(opts.outlineColor) }),
          ...(opts.size && { size: opts.size }),
        };
      }
      if (opts.labelField) args.labelField = opts.labelField;
      args.screenshot = true;
    }
    printResult(await sendCommand(info, "overlay", args));
  });

// --- annotate ---
program
  .command("annotate")
  .description("Add annotations to the map")
  .option("--text <text>", "Text annotation")
  .option("--circle", "Circle annotation")
  .option("--at <lon,lat>", "Position (lon,lat)")
  .option("--radius <feet>", "Circle radius in feet", parseInt)
  .option("--color <r,g,b,a>", "Color RGBA")
  .option("--clear", "Clear all annotations")
  .action(async (opts) => {
    const info = await ensureDaemon();

    if (opts.clear) {
      printResult(await sendCommand(info, "annotate", { clear: true }));
      return;
    }

    const position = opts.at?.split(",").map(Number);
    const annotations = [];

    if (opts.text) {
      annotations.push({
        type: "text",
        position,
        text: opts.text,
        ...(opts.color && { color: parseRgba(opts.color) }),
      });
    } else if (opts.circle) {
      annotations.push({
        type: "circle",
        position,
        radius: opts.radius || 500,
        ...(opts.color && { color: parseRgba(opts.color) }),
      });
    }

    printResult(await sendCommand(info, "annotate", { annotations, screenshot: true }));
  });

// --- screenshot ---
program
  .command("screenshot")
  .description("Capture the current map view")
  .option("-o, --output <filename>", "Output filename")
  .option("--width <number>", "Width in pixels", parseInt)
  .option("--height <number>", "Height in pixels", parseInt)
  .option("--dpi <number>", "DPI (96 = normal, 192 = retina)", parseInt)
  .action(async (opts) => {
    const info = await ensureDaemon();
    const args: Record<string, unknown> = {};
    if (opts.output) args.filename = opts.output;
    if (opts.width) args.width = opts.width;
    if (opts.height) args.height = opts.height;
    if (opts.dpi) args.dpi = opts.dpi;

    const result = await sendCommand(info, "screenshot", args);
    console.log((result as any).path);
  });

// --- export ---
program
  .command("export <destination>")
  .description("Capture and save to a specific path")
  .option("--width <number>", "Width in pixels", parseInt)
  .option("--height <number>", "Height in pixels", parseInt)
  .option("--dpi <number>", "DPI", parseInt)
  .action(async (destination: string, opts) => {
    const info = await ensureDaemon();
    const result = await sendCommand(info, "screenshot", {
      destination: resolve(destination),
      ...(opts.width && { width: opts.width }),
      ...(opts.height && { height: opts.height }),
      ...(opts.dpi && { dpi: opts.dpi }),
    });
    console.log((result as any).path);
  });

// --- webmap ---
program
  .command("webmap <id>")
  .description("Switch to a different web map")
  .action(async (id: string) => {
    const info = await ensureDaemon();
    const result = await sendCommand(info, "webmap", { webmapId: id });
    console.log(JSON.stringify(result, null, 2));
  });

// --- status ---
program
  .command("status")
  .description("Check daemon status")
  .action(() => {
    const info = getDaemonInfo();
    if (info) {
      console.log(`Running — PID ${info.pid}, API port ${info.apiPort}, map port ${info.mapPort}`);
    } else {
      console.log("Not running");
    }
  });

// --- stop ---
program
  .command("stop")
  .description("Stop the daemon")
  .action(async () => {
    const stopped = await stopDaemon();
    console.log(stopped ? "Daemon stopped" : "Daemon was not running");
  });

program.parseAsync().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
