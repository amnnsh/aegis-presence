// A tiny local STATIC file server for the export, not an application backend.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep, extname } from "node:path";
const root = resolve(import.meta.dirname, "../out");
if (!existsSync(resolve(root, "index.html"))) { console.error("No export found. Run npm run build first."); process.exit(1); }
const arg = process.argv.indexOf("--port");
const port = Number(arg >= 0 ? process.argv[arg + 1] : process.env.PORT || 3000);
const headers = JSON.parse(readFileSync(resolve(import.meta.dirname, "../vercel.json"), "utf8")).headers[0].headers;
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".task": "application/octet-stream", ".ico": "image/x-icon" };
createServer(async (req, res) => {
  headers.forEach(h => res.setHeader(h.key, h.value));
  try {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    let path = resolve(root, "." + pathname);
    if (path !== root && !path.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
    if ((await stat(path)).isDirectory()) path = resolve(path, "index.html");
    const bytes = await readFile(path);
    res.setHeader("Content-Type", mime[extname(path)] || "application/octet-stream");
    res.writeHead(200); res.end(req.method === "HEAD" ? undefined : bytes);
  } catch { res.writeHead(404); res.end("Not found"); }
}).listen(port, "127.0.0.1", () => console.log(`Aegis static export: http://localhost:${port}`));
