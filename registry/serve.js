#!/usr/bin/env node
// DarkSpriteLib – Local preview server
// Run from the repo root:  node registry/serve.js
// Then open:  http://localhost:8080

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = process.env.PORT ?? 8080;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".ts":   "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".css":  "text/css; charset=utf-8",
  ".txt":  "text/plain; charset=utf-8",
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split("?")[0];

  // Redirect root to the preview tool
  if (urlPath === "/" || urlPath === "") {
    res.writeHead(302, { Location: "/registry/preview.html" });
    res.end();
    return;
  }

  // Resolve file path and guard against traversal
  const filePath = path.resolve(ROOT, "." + urlPath);
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`Not found: ${urlPath}`);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] ?? "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": mime,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\nDarkSpriteLib preview server`);
  console.log(`  http://localhost:${PORT}\n`);
});
