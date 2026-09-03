#!/usr/bin/env node
/**
 * serve-tracker.mjs — local win/loss tracker page for your Mac.
 *
 * Reads tracker-data/picks.json (written by capture-picks.mjs) and serves
 * tracker.html at http://localhost:PORT showing every pick with W / L
 * buttons. Your marks are saved straight back into the file.
 *
 * Usage:
 *     node scripts/serve-tracker.mjs            # http://localhost:4173
 *     node scripts/serve-tracker.mjs --port 8000
 *     node scripts/serve-tracker.mjs --open     # also open the browser
 */
import http from "node:http";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, "..", "tracker-data");
const PICKS_FILE = path.join(DATA_DIR, "picks.json");
const HTML_FILE = path.join(HERE, "tracker.html");

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = portArg !== -1 ? Number(args[portArg + 1]) : 4173;
const SHOULD_OPEN = args.includes("--open");

async function loadPicks() {
  try {
    const raw = await readFile(PICKS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : parsed.picks || [];
  } catch {
    return [];
  }
}

async function savePicks(picks) {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${PICKS_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(picks, null, 2) + "\n", "utf8");
  await rename(tmp, PICKS_FILE);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (url.pathname === "/api/picks" && req.method === "GET") {
      const picks = await loadPicks();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(picks));
      return;
    }

    if (url.pathname === "/api/grade" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { id, result } = JSON.parse(body || "{}");
      if (!id || !["W", "L", "pending"].includes(result)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Expected { id, result: 'W' | 'L' | 'pending' }");
        return;
      }
      const picks = await loadPicks();
      const pick = picks.find((p) => p.id === id);
      if (!pick) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end(`No pick with id ${id}`);
        return;
      }
      pick.status = result;
      pick.gradedAt = new Date().toISOString();
      await savePicks(picks);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, id, status: result }));
      return;
    }

    if (url.pathname === "/api/picks" && req.method === "DELETE") {
      const id = url.searchParams.get("id");
      const picks = await loadPicks();
      const next = picks.filter((p) => p.id !== id);
      if (next.length === picks.length) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end(`No pick with id ${id}`);
        return;
      }
      await savePicks(next);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, removed: id }));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(await readFile(HTML_FILE, "utf8"));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(err.message || "Server error");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`🎯 Pick Tracker running at ${url}`);
  console.log(`   Data file: ${PICKS_FILE}`);
  if (SHOULD_OPEN) {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  }
});
