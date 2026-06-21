// Ren local proxy — serves the static app and proxies HydraDB + OpenAI so that
// API keys stay on the server (never shipped to the browser) and CORS is moot.
//
// Run:  HYDRA_KEY=sk_live_... OPENAI_KEY=sk-... node proxy.js
//   - HYDRA_KEY  (or HYDRA_DB_API_KEY) is required.
//   - OPENAI_KEY is read from env; if absent, falls back to parsing config.js.
//
// Then open:  http://localhost:8787

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { HydraDBClient } from "@hydradb/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const TENANT_ID = "ren_dev";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

/* ---- keys ---------------------------------------------------------------- */
const HYDRA_KEY = process.env.HYDRA_KEY || process.env.HYDRA_DB_API_KEY;
if (!HYDRA_KEY) {
  console.error("✗ Missing HYDRA_KEY. Run: HYDRA_KEY=sk_live_... node proxy.js");
  process.exit(1);
}

let OPENAI_KEY = process.env.OPENAI_KEY;
if (!OPENAI_KEY) {
  // Fall back to the gitignored config.js so you don't have to pass it twice.
  try {
    const cfg = await readFile(join(__dirname, "config.js"), "utf8");
    const m = cfg.match(/OPENAI_KEY:\s*["']([^"']+)["']/);
    if (m && !m[1].includes("YOUR_")) OPENAI_KEY = m[1];
  } catch { /* no config.js — fine */ }
}
if (!OPENAI_KEY) {
  console.warn("⚠ No OPENAI_KEY (env or config.js). /api/openai will return an error until set.");
}

const hydra = new HydraDBClient({ token: HYDRA_KEY });

/* ---- shared-secret gate -------------------------------------------------- */
// Protects both the app page and the /api/* endpoints so that exposing this
// proxy publicly (e.g. via ngrok) doesn't hand the world an open relay to your
// OpenAI / HydraDB keys. Set REN_SECRET to pin a value; otherwise one is
// generated per run. Access with ?key=SECRET once — a cookie carries it after.
const SECRET = process.env.REN_SECRET || randomBytes(16).toString("hex");

function presentedSecret(req) {
  const url = new URL(req.url, "http://x");
  const q = url.searchParams.get("key");
  if (q) return q;
  const h = req.headers["x-ren-key"];
  if (h) return Array.isArray(h) ? h[0] : h;
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/(?:^|;\s*)ren_key=([^;]+)/);
  if (m) return decodeURIComponent(m[1]);
  return null;
}
function authed(req) { return presentedSecret(req) === SECRET; }

const UNAUTH_PAGE =
  "<!doctype html><meta charset=utf-8><title>Ren — locked</title>" +
  "<body style=\"font-family:Georgia,serif;background:#FAF7F2;color:#4A1942;" +
  "display:flex;height:100vh;margin:0;align-items:center;justify-content:center;text-align:center\">" +
  "<div><h1 style=\"letter-spacing:.12em\">REN 恋</h1>" +
  "<p>This instance is locked. Append <code>?key=YOUR_SECRET</code> to the URL.</p></div>";

/* ---- HydraDB helpers ----------------------------------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let tenantReady = null; // cache the readiness promise so we only do this once
async function ensureTenant() {
  if (tenantReady) return tenantReady;
  tenantReady = (async () => {
    console.log("→ ensuring tenant:", TENANT_ID);
    try {
      await hydra.tenants.create({ tenantId: TENANT_ID });
    } catch {
      // already exists — fine
    }
    while (true) {
      const res = await hydra.tenants.status({ tenantId: TENANT_ID });
      const infra = res.data?.infra;
      if (infra?.ready_for_ingestion || infra?.readyForIngestion) break;
      await sleep(3000);
    }
    console.log("✓ tenant ready");
  })();
  return tenantReady;
}

async function hydraQuery(query) {
  await ensureTenant();
  const res = await hydra.query({ tenantId: TENANT_ID, type: "memory", query });
  const chunks = res.data?.chunks || [];
  return chunks.map((c) => c.chunkContent).filter(Boolean);
}

async function hydraIngest(text, { waitForIndex = true } = {}) {
  await ensureTenant();
  const ingest = await hydra.context.ingest({
    type: "memory",
    tenantId: TENANT_ID,
    memories: JSON.stringify([{ text }]),
  });
  const id = ingest.data?.results?.[0]?.id;
  if (waitForIndex && id) {
    // Block until indexed so the next panel's recall actually sees it.
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const res = await hydra.context.status({ tenantId: TENANT_ID, ids: [id] });
      const s = res.data?.statuses?.[0] || {};
      const status = s.indexingStatus || s.indexing_status;
      if (status === "completed") break;
      if (status === "errored") throw new Error(s.errorMessage || s.error_message || "indexing errored");
      await sleep(2000);
    }
  }
  return { id };
}

/* ---- OpenAI -------------------------------------------------------------- */
async function callOpenAI(system, user) {
  if (!OPENAI_KEY) throw new Error("OPENAI_KEY not configured on the proxy");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: 1000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

/* ---- tiny HTTP plumbing -------------------------------------------------- */
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(body);
}

async function serveStatic(req, res, extraHeaders = {}) {
  let path = req.url.split("?")[0];
  if (path === "/") path = "/index.html";
  // confine to this directory
  const safe = join(__dirname, path.replace(/\.\.+/g, "."));
  try {
    const data = await readFile(safe);
    res.writeHead(200, { "Content-Type": MIME[extname(safe)] || "application/octet-stream", ...extraHeaders });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  try {
    const pathname = req.url.split("?")[0];

    // ---- /api/* : always require the shared secret ----
    if (pathname.startsWith("/api/")) {
      if (!authed(req)) return sendJSON(res, 401, { error: "unauthorized" });
      if (req.method === "POST" && pathname === "/api/hydra/query") {
        const { query } = await readBody(req);
        const memories = await hydraQuery(String(query || ""));
        return sendJSON(res, 200, { memories });
      }
      if (req.method === "POST" && pathname === "/api/hydra/ingest") {
        const { text } = await readBody(req);
        const r = await hydraIngest(String(text || ""));
        return sendJSON(res, 200, { ok: true, ...r });
      }
      if (req.method === "POST" && pathname === "/api/openai") {
        const { system, user } = await readBody(req);
        const text = await callOpenAI(String(system || ""), String(user || ""));
        return sendJSON(res, 200, { text });
      }
      res.writeHead(404); return res.end("Not found");
    }

    // ---- static : also gated; ?key=SECRET sets a cookie for later requests ----
    if (req.method === "GET") {
      if (!authed(req)) {
        res.writeHead(401, { "Content-Type": "text/html" });
        return res.end(UNAUTH_PAGE);
      }
      const headers = {};
      if (new URL(req.url, "http://x").searchParams.get("key") === SECRET) {
        headers["Set-Cookie"] = `ren_key=${encodeURIComponent(SECRET)}; Path=/; SameSite=Lax; Max-Age=86400`;
      }
      return serveStatic(req, res, headers);
    }

    res.writeHead(405); res.end("Method not allowed");
  } catch (e) {
    console.error("✗", e.message);
    sendJSON(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Ren proxy listening → http://localhost:${PORT}`);
  console.log(`  HydraDB key:  ${HYDRA_KEY.slice(0, 12)}…  (tenant: ${TENANT_ID})`);
  console.log(`  OpenAI key:   ${OPENAI_KEY ? OPENAI_KEY.slice(0, 10) + "…" : "(not set)"}  model: ${OPENAI_MODEL}`);
  console.log(`  🔒 access secret: ${SECRET}`);
  console.log(`  Open locally → http://localhost:${PORT}/?key=${SECRET}`);
  console.log(`  (when tunneled, use https://<ngrok-host>/?key=${SECRET})`);
});
