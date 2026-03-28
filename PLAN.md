# sage-atlas — Headless Map Renderer for Claude

A standalone CLI tool that renders ArcGIS web maps in a headless browser via a persistent daemon. Claude navigates, overlays data, and captures screenshots as PNG images for vision analysis or document inclusion.

## Core Concept

**Ryan designs the cartography** in AGOL Map Viewer (symbology, labels, layer order, scale-dependent rendering). **Claude operates the map** via CLI commands — navigating, highlighting features, adding temporary overlays, and capturing images. The web map is the single source of cartographic truth.

## Starting Web Map

- **Title:** Sage_Atlas
- **ID:** `a30df87e755e4cab87acb5d9181bc11c`
- **Portal:** `ryanpream.maps.arcgis.com` (Ryan's personal AGOL)
- **Sharing:** Public
- **Layers:**
  - Address Points (yellow dots, visible at parcel scale)
  - County Boundary (blue dashed line)
  - City Boundary (black outlines with fill)
  - Parcels (blue outlines with APN labels at scale)
  - Aerial 2025 (basemap, currently toggled off)
- **Cartography:** APN labels properly placed and scaled per Esri's label engine. Building footprints from aerial. Road labels from basemap.

Future web maps can be added for different contexts (zoning, hazards, district boundaries, etc.).

## Architecture

```
sage-atlas/
├── package.json
├── tsconfig.json
├── CLAUDE.md              — Instructions for Claude Code sessions
├── PLAN.md                — This file
├── src/
│   ├── server.ts          — Local Express server serving the map page
│   ├── page.html          — ArcGIS JS SDK page that loads a web map
│   ├── renderer.ts        — Playwright daemon: launch browser, execute commands, screenshot
│   ├── commands.ts         — Command definitions (goto, highlight, overlay, screenshot)
│   └── cli.ts             — CLI entry point (commander-based)
├── output/                — Generated PNGs (gitignored)
└── data/                  — Local GeoJSON for overlays (gitignored)
```

## How It Works

### Daemon Architecture

The browser and MapView stay alive across commands. No re-initialization on pans/zooms.

```
atlas goto --apn "0150-082-200"
  ↓
  Is daemon running? (check .atlas-daemon lockfile)
  ├─ No  → spawn Express + Playwright, wait for READY, write { pid, port } to .atlas-daemon
  └─ Yes → connect to existing instance via HTTP
  ↓
  Send command → Playwright evaluates in same page context → screenshot → return path
```

**Daemon lifecycle:**
- Starts automatically on first command
- Stays alive between commands (MapView persists — pans/zooms are instant)
- `atlas stop` kills it explicitly
- Auto-exits after 30 minutes of inactivity
- Lockfile at `.atlas-daemon` has `{ pid, port }` — if process is dead, clean up and respawn

### Command Flow
1. CLI parses args, connects to daemon (or spawns it)
2. Sends command as JSON over HTTP to the daemon's Express server
3. Daemon executes JavaScript in the browser page context via Playwright:
   - Queries the parcel FeatureLayer for the APN
   - Gets the geometry extent
   - Calls `view.goTo(extent, { duration: 0 })` (instant, no animation)
4. Waits for `view.updating === false` + 500ms for tile loading
5. Captures screenshot via `page.screenshot()` (Playwright native)
6. Saves to `output/` and returns path to CLI
7. CLI prints the path — Claude reads the PNG with vision

### Why CLI Over MCP

- Claude Code already has Bash (run commands) + Read (view images) — that's the full loop
- No protocol overhead or SDK dependency
- Works outside Claude too — scripts, cron, other tooling
- Simpler to build, test, debug
- MCP can be added later as a thin wrapper if needed

## CLI Commands

### Navigation

**`atlas goto`** — Navigate to a location
```bash
atlas goto --apn "0150-082-200"                    # Query parcel layer, zoom to extent
atlas goto --address "675 Texas St, Fairfield"     # Geocode via AGOL World Geocoder
atlas goto --center "-122.05,38.25" --zoom 15      # Direct coordinates
atlas goto --extent "-122.1,38.2,-121.9,38.3"     # xmin,ymin,xmax,ymax

# Options
--zoom <number>       # Override zoom level (default: fit to feature)
--padding <number>    # Buffer around feature in pixels (default: 50)
```
Returns: image path, center, zoom, scale

**`atlas zoom`** — Zoom in/out relative to current view
```bash
atlas zoom in                # Zoom in 2 levels
atlas zoom out --levels 4    # Zoom out 4 levels
```

### Layer Control

**`atlas layers`** — Toggle layer visibility
```bash
atlas layers --show "Aerial 2025,Address Points"
atlas layers --hide "Parcels"
atlas layers --list                                # Print layer list with visibility
```

**`atlas webmap`** — Switch to a different web map
```bash
atlas webmap <id>      # AGOL web map item ID
```

### Overlay & Highlight

**`atlas highlight`** — Highlight specific features
```bash
atlas highlight --apns "0150-082-200,0150-082-210"
atlas highlight --addresses "675 Texas St"
atlas highlight --clear

# Style options
--color "255,255,0,0.3"           # Fill RGBA
--outline-color "255,0,0,1"       # Outline RGBA
--outline-width 3
```

**`atlas overlay`** — Add temporary GeoJSON layer
```bash
atlas overlay --file data/moved-points.geojson --id "moved-points"
atlas overlay --id "moved-points" --remove

# Style options
--color "255,0,0,0.8"
--size 8                          # Point size
--label-field "name"
```

**`atlas annotate`** — Add text/arrows/circles to the map
```bash
atlas annotate --text "Site A" --at "-122.05,38.25"
atlas annotate --circle --at "-122.05,38.25" --radius 500
atlas annotate --clear
```

### Capture

**`atlas screenshot`** — Capture current view
```bash
atlas screenshot                              # Default: output/atlas-{timestamp}.png
atlas screenshot -o my-map.png                # Custom filename
atlas screenshot --width 1920 --height 1080   # Dimensions (default: 1920x1080)
atlas screenshot --dpi 192                    # Retina quality
```

**`atlas export`** — Capture + copy to specific location
```bash
atlas export /Users/ryan/Development/vault-solano/_agent/map-output.png
```

### Daemon Control

**`atlas stop`** — Kill the daemon
```bash
atlas stop
```

**`atlas status`** — Check daemon state
```bash
atlas status    # Running on port 3333, PID 12345, idle 5m
```

## Tech Stack

| Package | Purpose |
|---------|---------|
| `playwright` | Headless Chromium automation |
| `express` | Local HTTP server (map page + daemon API) |
| `commander` | CLI argument parsing |
| `@arcgis/core` (via CDN in page.html) | ArcGIS Maps SDK — loaded in the browser, not in Node |

**Note:** `@arcgis/core` is loaded via CDN (`https://js.arcgis.com/4.34/`) in the HTML page, not installed as an npm dependency. This avoids the massive SDK install and keeps the Node project lightweight. The SDK runs entirely in the browser context.

## page.html — The Map Page

A minimal HTML page that:
1. Loads ArcGIS JS SDK 4.34 from CDN
2. Creates a `MapView` from a `WebMap` (ID passed as URL param)
3. Exposes control functions on `window` for Playwright to call:
   - `window.atlasGoTo(target)` — navigate
   - `window.atlasHighlight(features, style)` — highlight features
   - `window.atlasOverlay(geojson, style)` — add GeoJSON layer
   - `window.atlasAnnotate(annotations)` — add graphics
   - `window.atlasScreenshot(options)` — capture and return base64
   - `window.atlasLayers(show, hide)` — toggle visibility
   - `window.atlasGetState()` — return current center, zoom, scale, visible layers
4. Sets `view.ui.components = []` — no zoom widget, no attribution, clean output
5. Sizes the MapView to fill the viewport (Playwright controls viewport size)

```html
<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="https://js.arcgis.com/4.34/esri/themes/light/main.css">
  <script src="https://js.arcgis.com/4.34/"></script>
  <style>
    html, body, #viewDiv { margin: 0; padding: 0; width: 100%; height: 100%; }
  </style>
</head>
<body>
  <div id="viewDiv"></div>
  <script>
    require([
      "esri/WebMap",
      "esri/views/MapView",
      "esri/layers/GraphicsLayer",
      "esri/Graphic"
    ], function(WebMap, MapView, GraphicsLayer, Graphic) {
      const params = new URLSearchParams(window.location.search);
      const webmapId = params.get('webmap') || 'a30df87e755e4cab87acb5d9181bc11c';

      const webmap = new WebMap({ portalItem: { id: webmapId } });
      const highlightLayer = new GraphicsLayer({ title: '_highlights' });
      const overlayLayer = new GraphicsLayer({ title: '_overlays' });
      const annotationLayer = new GraphicsLayer({ title: '_annotations' });

      const view = new MapView({
        container: 'viewDiv',
        map: webmap,
        ui: { components: [] }  // Clean — no widgets
      });

      webmap.addMany([highlightLayer, overlayLayer, annotationLayer]);

      view.when(() => {
        document.title = 'READY';  // Signal to Playwright

        // Expose control API on window
        window.atlasView = view;
        window.atlasWebMap = webmap;
        window.atlasHighlightLayer = highlightLayer;
        // ... (control functions defined here)
      });
    });
  </script>
</body>
</html>
```

## Renderer — Playwright Integration

```typescript
// Core pattern
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await context.newPage();
await page.goto(`http://localhost:${port}?webmap=${webmapId}`);

// Wait for ArcGIS to fully load
await page.waitForFunction(() => document.title === 'READY', { timeout: 30000 });

// Execute a command
await page.evaluate(async (target) => {
  await window.atlasView.goTo(target, { duration: 0 });
  // Wait for tiles
  await new Promise(resolve => {
    const check = () => {
      if (!window.atlasView.updating) resolve();
      else setTimeout(check, 100);
    };
    check();
  });
}, { center: [-122.05, 38.25], zoom: 15 });

// Screenshot
const screenshot = await page.screenshot({ type: 'png', fullPage: false });
fs.writeFileSync('output/map.png', screenshot);
```

**Key detail:** Use `page.screenshot()` (Playwright's native screenshot) rather than `view.takeScreenshot()`. Playwright captures the full rendered page including basemap tiles that may not be in the MapView's internal canvas. Both work, but Playwright's is more reliable for headless capture.

## Startup Sequence

```bash
# Install
cd sage-atlas && npm install

# First command spawns daemon automatically
atlas goto --address "675 Texas St, Fairfield"

# Subsequent commands reuse the running daemon
atlas highlight --apns "0150-082-200"
atlas screenshot -o test.png

# Manual daemon control
atlas status
atlas stop
```

## Implementation Order

### Step 1: Minimal Viable Map
- `package.json` with dependencies
- `src/page.html` loading the Sage_Atlas web map
- `src/server.ts` serving the page
- `src/renderer.ts` with Playwright: launch → wait for READY → screenshot
- Test: `npx tsx src/renderer.ts` produces a PNG of the county overview

### Step 2: Daemon + CLI
- `src/cli.ts` with commander subcommands
- Daemon spawn/connect logic in renderer.ts
- `.atlas-daemon` lockfile management
- `atlas_goto` command: center/zoom, APN query, address geocode
- `atlas zoom`, `atlas layers` commands
- Test: navigate to specific APNs, toggle aerials, capture screenshots

### Step 3: Overlays & Highlights
- `atlas highlight`: query parcel layer by APN, add highlight graphics
- `atlas overlay`: load GeoJSON as temporary GraphicsLayer
- `atlas annotate`: text labels and arrows
- Test: highlight LAFCO boundary change parcels, overlay geodiff results

### Step 4: Polish
- Error handling (layer not found, APN not found, timeout)
- Multiple web map support (`atlas webmap` command)
- DPI/resolution options for document-quality output
- `atlas stop` and `atlas status` commands
- Inactivity auto-shutdown (30min)

## Authentication (Future)

The starting web map is public on Ryan's AGOL. No auth needed.

For secured Portal content (county internal layers, aerials):
- Use `esri/identity/IdentityManager` with an OAuth app registration
- Store client ID in env var
- Generate a token at startup via app credentials
- The MapView handles token refresh automatically

This is a later concern — start with public data, add auth when you need secured layers.

## Web Map Management

The web map ID is the cartographic contract. To change the cartography:

1. Open `https://ryanpream.maps.arcgis.com/apps/mapviewer/index.html?webmap=a30df87e755e4cab87acb5d9181bc11c`
2. Modify layers, symbology, labels, scale ranges
3. Save
4. sage-atlas automatically renders the updated cartography on next command

Multiple web maps for different contexts:
```typescript
const WEBMAPS = {
  default: 'a30df87e755e4cab87acb5d9181bc11c',  // Sage_Atlas (parcels, boundaries, aerials)
  zoning: 'TBD',                                  // Zoning + land use
  hazards: 'TBD',                                 // Flood, fire, seismic
  districts: 'TBD',                               // LAFCO districts, SOIs
};
```

## Output Examples

After implementation, Claude can do things like:

```
"Show me the 3 RNVWD annexation parcels from 2022"
→ atlas goto --apn "0105-190-070"
→ atlas highlight --apns "0105-190-070,0104-150-210,0105-190-090"
→ atlas screenshot -o rnvwd-2022-annexations.png
→ [Claude reads the image, sees parcels highlighted on the map]
→ atlas export /Users/ryan/Development/vault-solano/_agent/rnvwd-2022-annexations.png

"Show me the 61 address points that moved between Mar 13 and Mar 27"
→ atlas overlay --file data/moved-points.geojson --id "moved-points" --color "255,0,0,0.8" --size 8
→ atlas goto --center "-122.1,38.27" --zoom 12
→ atlas screenshot -o address-moves-overview.png
```
