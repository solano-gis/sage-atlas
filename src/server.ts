import express from "express";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function startServer(port: number = 0): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const app = express();

    app.get("/", (_req, res) => {
      res.sendFile(join(__dirname, "page.html"));
    });

    const server = createServer(app);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }
      resolve({ server, port: addr.port });
    });
    server.on("error", reject);
  });
}
