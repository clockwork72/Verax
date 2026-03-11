import { ipcMain as d, app as C, BrowserWindow as j } from "electron";
import { fileURLToPath as dt } from "node:url";
import o from "node:path";
import u from "node:fs";
import { spawn as X } from "node:child_process";
const G = o.dirname(dt(import.meta.url));
process.env.APP_ROOT = o.join(G, "..");
const M = process.env.VITE_DEV_SERVER_URL, Ct = o.join(process.env.APP_ROOT, "dist-electron"), Q = o.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = M ? o.join(process.env.APP_ROOT, "public") : Q;
const m = o.resolve(process.env.APP_ROOT, ".."), pt = process.env.PRIVACY_DATASET_HPC_ORIGIN || "http://127.0.0.1:8910";
let w, k = null, v = null;
const H = /* @__PURE__ */ new Set(), V = /* @__PURE__ */ new Set();
let N = 0, P = null;
const mt = 2, ht = 8, gt = 1200, yt = 20;
let O = null, R = null, A = !1;
function Z() {
  if (process.env.PRIVACY_DATASET_PYTHON) return process.env.PRIVACY_DATASET_PYTHON;
  const n = process.env.CONDA_PREFIX;
  if (n) {
    const t = o.join(n, "bin", "python");
    if (u.existsSync(t)) return t;
  }
  return "python";
}
function tt(n = {}) {
  const t = { ...process.env, PYTHONUNBUFFERED: "1", ...n }, e = [], r = process.env.CONDA_PREFIX;
  if (r) {
    const s = r.lastIndexOf("/envs/");
    s !== -1 && e.push(o.join(r.slice(0, s), "bin"));
  }
  const a = process.env.MAMBA_ROOT_PREFIX || process.env.CONDA_ROOT;
  if (a && e.push(o.join(a, "bin")), e.length > 0) {
    const s = t.PATH || "", i = new Set(s.split(":")), c = e.filter((l) => !i.has(l));
    c.length > 0 && (t.PATH = s + ":" + c.join(":"));
  }
  return t;
}
function S(n, t) {
  w && !w.isDestroyed() && w.webContents.send(n, t);
}
async function p(n, t) {
  return (await fetch(`${pt}${n}`, {
    ...t,
    headers: {
      "content-type": "application/json",
      ...(t == null ? void 0 : t.headers) || {}
    }
  })).json();
}
async function et() {
  try {
    return await p("/health");
  } catch {
    return null;
  }
}
async function h() {
  const n = await et();
  return !!(n != null && n.ok);
}
function St() {
  P || (P = setInterval(async () => {
    if (!(!w || w.isDestroyed()))
      try {
        const n = await p(`/api/poll?cursor=${N}`);
        if (!(n != null && n.ok)) return;
        N = Number(n.cursor || N);
        for (const t of n.items || [])
          t != null && t.channel && S(t.channel, t.payload);
      } catch {
      }
  }, 1500));
}
function _t() {
  P && (clearInterval(P), P = null);
}
function g(n) {
  const t = n ? o.resolve(m, n) : o.join(m, "outputs");
  return {
    outDir: t,
    resultsJsonl: o.join(t, "results.jsonl"),
    summaryJson: o.join(t, "results.summary.json"),
    stateJson: o.join(t, "run_state.json"),
    explorerJsonl: o.join(t, "explorer.jsonl"),
    artifactsDir: o.join(t, "artifacts"),
    artifactsOkDir: o.join(t, "artifacts_ok"),
    // Shared across all runs so CrUX lookups are reused between separate outputs.
    cruxCacheJson: o.join(m, "results.crux_cache.json")
  };
}
function wt(n, t) {
  const e = n.split(/\r?\n/), r = [];
  for (const a of e) {
    const s = a.trim();
    if (s)
      try {
        r.push(JSON.parse(s)), t && r.length >= t;
      } catch {
        r.push({ _error: "invalid_json", raw: s });
      }
  }
  return r;
}
const W = /* @__PURE__ */ new Map(), z = /* @__PURE__ */ new Map(), Y = /* @__PURE__ */ new Map();
async function U(n) {
  const t = await u.promises.stat(n), e = W.get(n);
  if (e && e.mtimeMs === t.mtimeMs)
    return e.data;
  const r = await u.promises.readFile(n, "utf-8"), a = JSON.parse(r);
  return W.set(n, { mtimeMs: t.mtimeMs, data: a }), a;
}
async function rt(n) {
  const t = await u.promises.stat(n), e = z.get(n);
  if (e && e.mtimeMs === t.mtimeMs)
    return e.data;
  const r = await u.promises.readFile(n, "utf-8"), a = wt(r);
  return z.set(n, { mtimeMs: t.mtimeMs, data: a }), a;
}
async function nt(n, t, e) {
  const r = Date.now(), a = Y.get(n);
  if (a && a.expiresAt > r)
    return a.value;
  const s = await e();
  return Y.set(n, { expiresAt: r + t, value: s }), s;
}
function I(n) {
  return n.trim().toLowerCase();
}
function at(n) {
  const t = String(n || "").trim().toLowerCase();
  return t ? t.includes("/") && t.split("/").pop() || t : "";
}
function x(n, t) {
  if (!n.startsWith(`${t}-`)) return !1;
  const e = n.slice(t.length + 1);
  return /^\d/.test(e);
}
function kt(n) {
  return n === "gpt-4o" || x(n, "gpt-4o") || n === "gpt-4.1" || x(n, "gpt-4.1");
}
function st(n) {
  const t = at(n);
  return t === "local" ? ["--llm-max-output-tokens", "2048", "--disable-exhaustion-check"] : t === "gpt-4o" || x(t, "gpt-4o") ? [
    "--model-tpm",
    "30000",
    "--tpm-headroom-ratio",
    "0.65",
    "--tpm-safety-factor",
    "1.30",
    "--llm-max-output-tokens",
    "650",
    "--rate-limit-retries",
    "12",
    "--disable-exhaustion-check"
  ] : t === "gpt-4.1" || x(t, "gpt-4.1") ? [
    "--model-tpm",
    "30000",
    "--tpm-headroom-ratio",
    "0.70",
    "--tpm-safety-factor",
    "1.25",
    "--llm-max-output-tokens",
    "700",
    "--rate-limit-retries",
    "10",
    "--disable-exhaustion-check"
  ] : t === "gpt-4o-mini" || x(t, "gpt-4o-mini") ? [
    "--model-tpm",
    "200000",
    "--tpm-headroom-ratio",
    "0.80",
    "--tpm-safety-factor",
    "1.15",
    "--llm-max-output-tokens",
    "900",
    "--rate-limit-retries",
    "8"
  ] : t === "gpt-4.1-mini" || x(t, "gpt-4.1-mini") ? [
    "--model-tpm",
    "200000",
    "--tpm-headroom-ratio",
    "0.80",
    "--tpm-safety-factor",
    "1.15",
    "--llm-max-output-tokens",
    "900",
    "--rate-limit-retries",
    "8"
  ] : t === "gpt-4.1-nano" || x(t, "gpt-4.1-nano") ? [
    "--model-tpm",
    "1000000",
    "--tpm-headroom-ratio",
    "0.85",
    "--tpm-safety-factor",
    "1.10",
    "--llm-max-output-tokens",
    "850",
    "--rate-limit-retries",
    "8"
  ] : [];
}
function it(n) {
  return o.join(g(n).outDir, "audit_state.json");
}
function $(n) {
  return o.join(g(n).outDir, "dashboard_run_manifest.json");
}
async function K(n, t) {
  await u.promises.mkdir(o.dirname(n), { recursive: !0 }), await u.promises.writeFile(n, JSON.stringify(t, null, 2), "utf-8");
}
async function vt(n) {
  if (!u.existsSync(n))
    return { verifiedSites: [], urlOverrides: {} };
  try {
    const t = await u.promises.readFile(n, "utf-8"), e = JSON.parse(t), a = (Array.isArray(e == null ? void 0 : e.verifiedSites) ? e.verifiedSites : []).filter((c) => typeof c == "string" && c.trim().length > 0).map((c) => I(c)), s = e != null && e.urlOverrides && typeof e.urlOverrides == "object" ? e.urlOverrides : {}, i = {};
    for (const [c, l] of Object.entries(s))
      typeof l == "string" && l.trim().length > 0 && (i[I(c)] = l.trim());
    return { verifiedSites: a, urlOverrides: i, updatedAt: e == null ? void 0 : e.updatedAt };
  } catch {
    return { verifiedSites: [], urlOverrides: {} };
  }
}
async function ot(n, t = {}, e) {
  const r = Z();
  try {
    k = X(r, n, {
      cwd: m,
      env: tt(t)
    });
  } catch (s) {
    return k = null, { ok: !1, error: String(s) };
  }
  if (A = !1, O = (e == null ? void 0 : e.path) || null, R = (e == null ? void 0 : e.data) || null, O && R)
    try {
      await K(O, R);
    } catch (s) {
      S("scraper:error", { message: "run_manifest_write_failed", error: String(s) });
    }
  let a = "";
  return k.stdout.on("data", (s) => {
    a += s.toString();
    const i = a.split(/\r?\n/);
    a = i.pop() || "";
    for (const c of i) {
      const l = c.trim();
      if (l)
        try {
          const f = JSON.parse(l);
          (f == null ? void 0 : f.type) === "run_completed" && (A = !0), S("scraper:event", f);
        } catch {
          S("scraper:log", { message: l });
        }
    }
  }), k.stderr.on("data", (s) => {
    S("scraper:error", { message: s.toString() });
  }), k.on("error", (s) => {
    S("scraper:error", { message: String(s) });
  }), k.on("close", (s, i) => {
    if (S("scraper:exit", { code: s, signal: i }), O && R) {
      const c = {
        ...R,
        status: A ? "completed" : "interrupted",
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      A && (c.completedAt = c.updatedAt), K(O, c).catch((l) => {
        S("scraper:error", { message: "run_manifest_update_failed", error: String(l) });
      });
    }
    O = null, R = null, A = !1, k = null;
  }), { ok: !0 };
}
async function ct(n, t = {}) {
  const e = Z();
  try {
    v = X(e, n, {
      cwd: m,
      env: tt(t)
    });
  } catch (a) {
    return v = null, { ok: !1, error: String(a) };
  }
  let r = "";
  return v.stdout.on("data", (a) => {
    r += a.toString();
    const s = r.split(/\r?\n/);
    r = s.pop() || "";
    for (const i of s)
      if (i.trim())
        if (i.startsWith("[STREAM] "))
          try {
            const c = JSON.parse(i.slice(9));
            S("annotator:stream", c);
          } catch {
            S("annotator:log", { message: i });
          }
        else
          S("annotator:log", { message: i });
  }), v.stderr.on("data", (a) => {
    S("annotator:log", { message: a.toString().trimEnd() });
  }), v.on("error", (a) => {
    S("annotator:log", { message: `Error: ${String(a)}` });
  }), v.on("close", (a, s) => {
    S("annotator:exit", { code: a, signal: s }), v = null;
  }), { ok: !0 };
}
async function ut(n) {
  let t = 0;
  const e = await u.promises.readdir(n, { withFileTypes: !0 });
  for (const r of e) {
    const a = o.join(n, r.name);
    if (r.isDirectory())
      t += await ut(a);
    else if (r.isFile())
      try {
        const s = await u.promises.stat(a);
        t += s.size;
      } catch {
        continue;
      }
  }
  return t;
}
function lt() {
  w = new j({
    icon: o.join(process.env.VITE_PUBLIC, "electron-vite.svg"),
    webPreferences: {
      preload: o.join(G, "preload.mjs")
    }
  }), w.webContents.on("did-finish-load", () => {
    w == null || w.webContents.send("main-process-message", (/* @__PURE__ */ new Date()).toLocaleString());
  }), M ? w.loadURL(M) : w.loadFile(o.join(Q, "index.html")), St();
}
function xt(n) {
  const t = new j({
    width: 1200,
    height: 800,
    title: "Policy Viewer",
    backgroundColor: "#0B0E14",
    webPreferences: {
      contextIsolation: !0,
      nodeIntegration: !1,
      sandbox: !0
    }
  });
  return t.setMenuBarVisibility(!1), t.loadURL(n), H.add(t), t.on("closed", () => {
    H.delete(t);
  }), t;
}
function q(n) {
  return n.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function Ot(n, t) {
  const e = new j({
    width: 1100,
    height: 800,
    title: t || "Run logs",
    backgroundColor: "#0B0E14",
    webPreferences: {
      contextIsolation: !0,
      nodeIntegration: !1,
      sandbox: !0
    }
  });
  e.setMenuBarVisibility(!1);
  const r = q(n || ""), a = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${q(t || "Run logs")}</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; background: #0B0E14; color: #E6EDF3; }
      header { padding: 16px 20px; border-bottom: 1px solid #1f2630; background: #0F141C; }
      h1 { font-size: 14px; letter-spacing: 0.16em; text-transform: uppercase; margin: 0 0 6px; color: #b9c2cc; }
      .sub { font-size: 12px; color: #b9c2cc; }
      pre { margin: 0; padding: 16px 20px; white-space: pre-wrap; word-break: break-word; line-height: 1.5; font-size: 12px; }
    </style>
  </head>
  <body>
    <header>
      <h1>Run logs</h1>
      <div class="sub">Full log output</div>
    </header>
    <pre>${r}</pre>
  </body>
</html>`;
  return e.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(a)}`), V.add(e), e.on("closed", () => {
    V.delete(e);
  }), e;
}
d.handle("scraper:get-paths", async (n, t) => {
  if (await h()) {
    const e = await p(`/api/paths?outDir=${encodeURIComponent(String(t || ""))}`);
    return (e == null ? void 0 : e.data) || g(t);
  }
  return g(t);
});
d.handle("scraper:read-summary", async (n, t) => {
  if (await h())
    return p(`/api/summary?filePath=${encodeURIComponent(String(t || ""))}`);
  try {
    const e = t ? o.resolve(m, t) : g().summaryJson;
    return u.existsSync(e) ? { ok: !0, data: await U(e), path: e } : { ok: !1, error: "not_found", path: e };
  } catch (e) {
    return { ok: !1, error: String(e) };
  }
});
d.handle("scraper:read-state", async (n, t) => {
  if (await h())
    return p(`/api/state?filePath=${encodeURIComponent(String(t || ""))}`);
  try {
    const e = t ? o.resolve(m, t) : g().stateJson;
    return u.existsSync(e) ? { ok: !0, data: await U(e), path: e } : { ok: !1, error: "not_found", path: e };
  } catch (e) {
    return { ok: !1, error: String(e) };
  }
});
d.handle("scraper:read-explorer", async (n, t, e) => {
  if (await h()) {
    const r = new URLSearchParams();
    return t && r.set("filePath", String(t)), e && r.set("limit", String(e)), p(`/api/explorer?${r.toString()}`);
  }
  try {
    const r = t ? o.resolve(m, t) : g().explorerJsonl;
    return u.existsSync(r) ? { ok: !0, data: r.endsWith(".jsonl") ? (await rt(r)).slice(0, e || void 0) : await U(r), path: r } : { ok: !1, error: "not_found", path: r };
  } catch (r) {
    return { ok: !1, error: String(r) };
  }
});
d.handle("scraper:read-results", async (n, t, e) => {
  if (await h()) {
    const r = new URLSearchParams();
    return t && r.set("filePath", String(t)), e && r.set("limit", String(e)), p(`/api/results?${r.toString()}`);
  }
  try {
    const r = t ? o.resolve(m, t) : g().resultsJsonl;
    return u.existsSync(r) ? { ok: !0, data: (await rt(r)).slice(0, e || void 0), path: r } : { ok: !1, error: "not_found", path: r };
  } catch (r) {
    return { ok: !1, error: String(r) };
  }
});
d.handle("scraper:read-audit-state", async (n, t) => {
  if (await h())
    return p(`/api/audit-state?outDir=${encodeURIComponent(String(t || ""))}`);
  try {
    const e = it(t);
    return { ok: !0, data: await vt(e), path: e };
  } catch (e) {
    return { ok: !1, error: String(e) };
  }
});
d.handle("scraper:read-run-manifest", async (n, t) => {
  if (await h())
    return p(`/api/run-manifest?outDir=${encodeURIComponent(String(t || ""))}`);
  try {
    const e = $(t);
    if (!u.existsSync(e))
      return { ok: !1, error: "not_found", path: e };
    const r = await u.promises.readFile(e, "utf-8");
    return { ok: !0, data: JSON.parse(r), path: e };
  } catch (e) {
    return { ok: !1, error: String(e) };
  }
});
d.handle(
  "scraper:write-audit-state",
  async (n, t) => {
    if (await h())
      return p("/api/write-audit-state", {
        method: "POST",
        body: JSON.stringify(t || {})
      });
    try {
      const e = it(t == null ? void 0 : t.outDir), r = o.dirname(e);
      await u.promises.mkdir(r, { recursive: !0 });
      const a = Array.isArray(t == null ? void 0 : t.verifiedSites) ? t.verifiedSites.filter((l) => typeof l == "string" && l.trim().length > 0).map((l) => I(l)) : [], s = (t == null ? void 0 : t.urlOverrides) || {}, i = {};
      for (const [l, f] of Object.entries(s))
        typeof f == "string" && f.trim().length > 0 && (i[I(l)] = f.trim());
      const c = {
        verifiedSites: Array.from(new Set(a)),
        urlOverrides: i,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      return await u.promises.writeFile(e, JSON.stringify(c, null, 2), "utf-8"), { ok: !0, data: c, path: e };
    } catch (e) {
      return { ok: !1, error: String(e) };
    }
  }
);
d.handle("scraper:read-artifact-text", async (n, t) => {
  if (await h())
    return p("/api/artifact-text", {
      method: "POST",
      body: JSON.stringify(t || {})
    });
  try {
    const e = t == null ? void 0 : t.relativePath;
    if (!e)
      return { ok: !1, error: "missing_relative_path" };
    const r = t != null && t.outDir ? o.resolve(m, t.outDir) : g().outDir, a = o.resolve(r, e), s = r.endsWith(o.sep) ? r : `${r}${o.sep}`;
    return a !== r && !a.startsWith(s) ? { ok: !1, error: "path_outside_root" } : u.existsSync(a) ? { ok: !0, data: await u.promises.readFile(a, "utf-8"), path: a } : { ok: !1, error: "not_found", path: a };
  } catch (e) {
    return { ok: !1, error: String(e) };
  }
});
d.handle("scraper:folder-size", async (n, t) => {
  if (await h())
    return p(`/api/folder-size?outDir=${encodeURIComponent(String(t || ""))}`);
  try {
    const e = t ? o.resolve(m, t) : g().outDir;
    return u.existsSync(e) ? { ok: !0, bytes: await nt(`folder-size:${e}`, 1e4, () => ut(e)), path: e } : { ok: !1, error: "not_found", path: e };
  } catch (e) {
    return { ok: !1, error: String(e) };
  }
});
d.handle("scraper:list-runs", async (n, t) => {
  if (await h())
    return p(`/api/list-runs?baseOutDir=${encodeURIComponent(String(t || ""))}`);
  try {
    const e = t ? o.resolve(m, t) : g().outDir;
    if (!u.existsSync(e))
      return { ok: !1, error: "not_found", path: e };
    const r = await u.promises.readdir(e, { withFileTypes: !0 }), a = [];
    for (const s of r) {
      if (!s.isDirectory()) continue;
      const i = o.join(e, s.name), c = o.join(i, "results.summary.json"), l = o.join(i, "run_state.json");
      let f = null, y = null;
      if (u.existsSync(c))
        try {
          f = JSON.parse(await u.promises.readFile(c, "utf-8"));
        } catch {
          f = null;
        }
      if (u.existsSync(l))
        try {
          y = JSON.parse(await u.promises.readFile(l, "utf-8"));
        } catch {
          y = null;
        }
      if (!f && !y && !s.name.startsWith("output_"))
        continue;
      let _ = "";
      try {
        _ = (await u.promises.stat(i)).mtime.toISOString();
      } catch {
        _ = "";
      }
      const D = (f == null ? void 0 : f.run_id) || (y == null ? void 0 : y.run_id) || s.name.replace(/^output_/, "");
      a.push({
        runId: D,
        folder: s.name,
        outDir: o.relative(m, i),
        summary: f,
        state: y,
        updated_at: (f == null ? void 0 : f.updated_at) || (y == null ? void 0 : y.updated_at) || _,
        started_at: (f == null ? void 0 : f.started_at) || (y == null ? void 0 : y.started_at) || null
      });
    }
    return a.sort((s, i) => String(i.updated_at || "").localeCompare(String(s.updated_at || ""))), { ok: !0, root: e, runs: a };
  } catch (e) {
    return { ok: !1, error: String(e) };
  }
});
d.handle("scraper:start", async (n, t = {}) => {
  if (await h())
    return p("/api/start-run", {
      method: "POST",
      body: JSON.stringify(t || {})
    });
  if (k)
    return { ok: !1, error: "scraper_already_running" };
  const e = g(t.outDir), r = [
    "-m",
    "privacy_research_dataset.cli",
    "--out",
    e.resultsJsonl,
    "--artifacts-dir",
    t.artifactsDir ? o.resolve(m, t.artifactsDir) : e.artifactsDir,
    "--artifacts-ok-dir",
    e.artifactsOkDir,
    "--emit-events",
    "--state-file",
    e.stateJson,
    "--summary-out",
    e.summaryJson,
    "--explorer-out",
    e.explorerJsonl,
    "--concurrency",
    String(mt),
    "--crux-concurrency",
    String(ht),
    "--policy-cache-max-entries",
    String(gt),
    "--tp-cache-flush-entries",
    String(yt)
  ];
  if (Array.isArray(t.sites) && t.sites.length > 0)
    for (const c of t.sites) {
      const l = String(c || "").trim();
      l && r.push("--site", l);
    }
  else t.topN && r.push("--tranco-top", String(t.topN));
  if (t.trancoDate && r.push("--tranco-date", t.trancoDate), t.resumeAfterRank && Number.isFinite(t.resumeAfterRank) && r.push("--resume-after-rank", String(t.resumeAfterRank)), t.expectedTotalSites && Number.isFinite(t.expectedTotalSites) && r.push("--expected-total-sites", String(t.expectedTotalSites)), t.trackerRadarIndex) {
    const c = o.resolve(m, t.trackerRadarIndex);
    u.existsSync(c) ? r.push("--tracker-radar-index", c) : S("scraper:error", { message: "tracker_radar_index_not_found", path: c });
  }
  if (t.trackerDbIndex) {
    const c = o.resolve(m, t.trackerDbIndex);
    u.existsSync(c) ? r.push("--trackerdb-index", c) : S("scraper:error", { message: "trackerdb_index_not_found", path: c });
  }
  t.runId && r.push("--run-id", t.runId), t.upsertBySite && r.push("--upsert-by-site"), r.push("--crux-cache-file", e.cruxCacheJson), t.cruxFilter && (r.push("--crux-filter"), t.cruxApiKey && r.push("--crux-api-key", t.cruxApiKey)), t.skipHomeFailed && r.push("--skip-home-fetch-failed"), t.excludeSameEntity && r.push("--exclude-same-entity");
  const a = (/* @__PURE__ */ new Date()).toISOString(), s = {
    version: 1,
    status: "running",
    mode: Array.isArray(t.sites) && t.sites.length > 0 ? "append_sites" : "tranco",
    runId: t.runId,
    topN: t.topN,
    trancoDate: t.trancoDate,
    resumeAfterRank: t.resumeAfterRank,
    expectedTotalSites: t.expectedTotalSites,
    requestedSites: Array.isArray(t.sites) ? t.sites.map((c) => String(c).trim()).filter(Boolean) : [],
    cruxFilter: !!t.cruxFilter,
    startedAt: a,
    updatedAt: a
  }, i = await ot(r, {}, {
    path: $(t.outDir),
    data: s
  });
  return i.ok ? { ok: !0, paths: e } : { ok: !1, error: i.error || "failed_to_start" };
});
d.handle("scraper:rerun-site", async (n, t = {}) => {
  if (await h())
    return p("/api/rerun-site", {
      method: "POST",
      body: JSON.stringify(t || {})
    });
  if (k)
    return { ok: !1, error: "scraper_already_running" };
  if (v)
    return { ok: !1, error: "annotator_running" };
  const e = String(t.site || "").trim();
  if (!e)
    return { ok: !1, error: "missing_site" };
  const r = g(t.outDir), a = [
    "-m",
    "privacy_research_dataset.cli",
    "--site",
    e,
    "--out",
    r.resultsJsonl,
    "--artifacts-dir",
    t.artifactsDir ? o.resolve(m, t.artifactsDir) : r.artifactsDir,
    "--artifacts-ok-dir",
    r.artifactsOkDir,
    "--emit-events",
    "--state-file",
    r.stateJson,
    "--summary-out",
    r.summaryJson,
    "--explorer-out",
    r.explorerJsonl,
    "--force",
    "--upsert-by-site",
    "--concurrency",
    "1"
  ];
  if (t.trackerRadarIndex) {
    const i = o.resolve(m, t.trackerRadarIndex);
    u.existsSync(i) ? a.push("--tracker-radar-index", i) : S("scraper:error", { message: "tracker_radar_index_not_found", path: i });
  }
  if (t.trackerDbIndex) {
    const i = o.resolve(m, t.trackerDbIndex);
    u.existsSync(i) ? a.push("--trackerdb-index", i) : S("scraper:error", { message: "trackerdb_index_not_found", path: i });
  }
  t.runId && a.push("--run-id", t.runId), t.excludeSameEntity && a.push("--exclude-same-entity"), t.policyUrlOverride && t.policyUrlOverride.trim() && a.push("--policy-url-override", t.policyUrlOverride.trim()), t.llmModel && t.llmModel.trim() && a.push("--llm-model", t.llmModel.trim());
  const s = await ot(a);
  return s.ok ? { ok: !0, paths: r, site: e } : { ok: !1, error: s.error || "failed_to_start" };
});
d.handle("scraper:stop", async () => await h() ? p("/api/stop-run", {
  method: "POST",
  body: JSON.stringify({})
}) : k ? (k.kill(), { ok: !0 }) : { ok: !1, error: "not_running" });
d.handle("scraper:open-log-window", async (n, t) => {
  try {
    const e = (t == null ? void 0 : t.content) ?? "", r = t == null ? void 0 : t.title;
    return Ot(e, r), { ok: !0 };
  } catch (e) {
    return { ok: !1, error: String(e) };
  }
});
d.handle("scraper:open-policy-window", async (n, t) => {
  if (!t || typeof t != "string")
    return { ok: !1, error: "invalid_url" };
  try {
    const e = new URL(t);
    return ["http:", "https:"].includes(e.protocol) ? (xt(t), { ok: !0 }) : { ok: !1, error: "unsupported_protocol" };
  } catch (e) {
    return { ok: !1, error: String(e) };
  }
});
d.handle("scraper:clear-results", async (n, t) => {
  if (await h())
    return p("/api/clear-results", {
      method: "POST",
      body: JSON.stringify(t || {})
    });
  if (k)
    return { ok: !1, error: "scraper_running" };
  const e = g(t == null ? void 0 : t.outDir), r = [
    e.resultsJsonl,
    e.summaryJson,
    e.stateJson,
    e.explorerJsonl,
    o.join(e.outDir, "audit_state.json"),
    $(t == null ? void 0 : t.outDir)
  ], a = [], s = [], i = [];
  for (const c of r)
    try {
      u.existsSync(c) ? (await u.promises.rm(c, { force: !0 }), a.push(c)) : s.push(c);
    } catch (l) {
      i.push(`${c}: ${String(l)}`);
    }
  if (t != null && t.includeArtifacts)
    try {
      u.existsSync(e.artifactsDir) && (await u.promises.rm(e.artifactsDir, { recursive: !0, force: !0 }), a.push(e.artifactsDir));
    } catch (c) {
      i.push(`${e.artifactsDir}: ${String(c)}`);
    }
  return { ok: i.length === 0, removed: a, missing: s, errors: i, paths: e };
});
d.handle("scraper:delete-output", async (n, t) => {
  if (await h())
    return p("/api/delete-output", {
      method: "POST",
      body: JSON.stringify({ outDir: t })
    });
  try {
    const e = t ? o.resolve(m, t) : g().outDir;
    return u.existsSync(e) ? (await u.promises.rm(e, { recursive: !0, force: !0 }), { ok: !0, path: e }) : { ok: !1, error: "not_found", path: e };
  } catch (e) {
    return { ok: !1, error: String(e) };
  }
});
d.handle("scraper:start-annotate", async (n, t = {}) => {
  if (await h())
    return p("/api/start-annotate", {
      method: "POST",
      body: JSON.stringify(t || {})
    });
  if (v)
    return { ok: !1, error: "annotator_already_running" };
  const e = t.artifactsDir ? o.resolve(m, t.artifactsDir) : o.join(g().outDir, "artifacts"), r = [
    "-m",
    "privacy_research_dataset.annotate_cli",
    "--artifacts-dir",
    e
  ];
  t.llmModel && r.push("--llm-model", t.llmModel), t.tokenLimit && r.push("--token-limit", String(t.tokenLimit));
  const a = at(t.llmModel), s = kt(a) ? 1 : void 0;
  let i = t.concurrency || s;
  s && i && i > s && (i = s, S("annotator:log", {
    message: `[info] ${t.llmModel || a}: forcing concurrency ${s} for TPM stability.`
  })), i && r.push("--concurrency", String(i)), r.push(...st(t.llmModel)), t.force && r.push("--force");
  const c = await ct(r);
  return c.ok ? { ok: !0, artifactsDir: e } : { ok: !1, error: c.error || "failed_to_start" };
});
d.handle("scraper:annotate-site", async (n, t = {}) => {
  if (await h())
    return p("/api/annotate-site", {
      method: "POST",
      body: JSON.stringify(t || {})
    });
  if (v)
    return { ok: !1, error: "annotator_already_running" };
  if (k)
    return { ok: !1, error: "scraper_running" };
  const e = String(t.site || "").trim();
  if (!e)
    return { ok: !1, error: "missing_site" };
  const r = g(t.outDir), a = [
    "-m",
    "privacy_research_dataset.annotate_cli",
    "--artifacts-dir",
    r.artifactsDir,
    "--target-dir",
    e,
    "--concurrency",
    "1"
  ];
  t.llmModel && t.llmModel.trim() && a.push("--llm-model", t.llmModel.trim()), a.push(...st(t.llmModel)), typeof t.tokenLimit == "number" && Number.isFinite(t.tokenLimit) && a.push("--token-limit", String(t.tokenLimit)), t.force !== !1 && a.push("--force");
  const s = await ct(a);
  return s.ok ? { ok: !0, artifactsDir: r.artifactsDir, site: e } : { ok: !1, error: s.error || "failed_to_start" };
});
d.handle("scraper:stop-annotate", async () => await h() ? p("/api/stop-annotate", {
  method: "POST",
  body: JSON.stringify({})
}) : v ? (v.kill(), { ok: !0 }) : { ok: !1, error: "not_running" });
d.handle("scraper:check-tunnel", async () => {
  const n = await et();
  return n ? { ok: !0, status: 200, data: n } : { ok: !1, error: "offline" };
});
d.handle("scraper:annotation-stats", async (n, t) => {
  if (await h())
    return p(`/api/annotation-stats?artifactsDir=${encodeURIComponent(String(t || ""))}`);
  try {
    const e = t ? o.resolve(m, t) : o.join(g().outDir, "artifacts");
    return u.existsSync(e) ? await nt(`annotation-stats:${e}`, 5e3, async () => {
      const r = async (_) => {
        try {
          return (await u.promises.readFile(_, "utf-8")).split(`
`).filter((b) => b.trim()).length;
        } catch {
          return 0;
        }
      }, a = await u.promises.readdir(e, { withFileTypes: !0 }), s = [], i = [];
      let c = 0, l = 0;
      for (const _ of a) {
        if (!_.isDirectory()) continue;
        const D = o.join(e, _.name, "policy_statements.jsonl"), b = u.existsSync(D);
        let T = 0;
        b && (T = await r(D), c += T), s.push({ site: _.name, count: T, has_statements: b });
        const J = o.join(e, _.name, "third_party");
        if (u.existsSync(J)) {
          const ft = await u.promises.readdir(J, { withFileTypes: !0 });
          for (const E of ft) {
            if (!E.isDirectory()) continue;
            const L = o.join(J, E.name, "policy_statements.jsonl"), B = u.existsSync(L);
            let F = 0;
            B && (F = await r(L), l += F), i.push({ site: _.name, tp: E.name, count: F, has_statements: B });
          }
        }
      }
      const f = s.filter((_) => _.has_statements).length, y = i.filter((_) => _.has_statements).length;
      return {
        ok: !0,
        total_sites: s.length,
        annotated_sites: f,
        total_statements: c,
        per_site: s,
        tp_total: i.length,
        tp_annotated: y,
        tp_total_statements: l,
        per_tp: i
      };
    }) : { ok: !0, total_sites: 0, annotated_sites: 0, total_statements: 0, per_site: [] };
  } catch (e) {
    return { ok: !1, error: String(e) };
  }
});
d.handle("scraper:count-ok-artifacts", async (n, t) => {
  if (await h())
    return p(`/api/count-ok-artifacts?outDir=${encodeURIComponent(String(t || ""))}`);
  try {
    const r = g(t).artifactsOkDir;
    if (!u.existsSync(r))
      return { ok: !0, count: 0, sites: [], path: r };
    const s = (await u.promises.readdir(r, { withFileTypes: !0 })).filter((i) => i.isDirectory() || i.isSymbolicLink()).map((i) => i.name);
    return { ok: !0, count: s.length, sites: s, path: r };
  } catch (e) {
    return { ok: !1, error: String(e), count: 0, sites: [] };
  }
});
d.handle("scraper:read-tp-cache", async (n, t) => {
  if (await h())
    return p(`/api/read-tp-cache?outDir=${encodeURIComponent(String(t || ""))}`);
  try {
    const e = t ? o.resolve(m, t) : g().outDir, r = o.join(e, "results.tp_cache.json");
    if (!u.existsSync(r))
      return { ok: !1, error: "not_found", path: r };
    const a = await u.promises.readFile(r, "utf-8"), s = JSON.parse(a);
    let i = 0, c = 0, l = 0;
    const f = {};
    for (const y of Object.values(s)) {
      i++, y.text !== null && y.text !== void 0 ? c++ : y.error_message && l++;
      const _ = String(y.status_code ?? "unknown");
      f[_] = (f[_] || 0) + 1;
    }
    return { ok: !0, total: i, fetched: c, failed: l, by_status: f };
  } catch (e) {
    return { ok: !1, error: String(e) };
  }
});
d.handle("scraper:crux-cache-stats", async (n, t) => {
  if (await h())
    return p(`/api/crux-cache-stats?outDir=${encodeURIComponent(String(t || ""))}`);
  try {
    const r = g(t).cruxCacheJson;
    if (!u.existsSync(r))
      return { ok: !0, count: 0, present: 0, absent: 0, path: r };
    const a = await u.promises.readFile(r, "utf-8"), s = JSON.parse(a), i = Object.values(s), c = i.filter(Boolean).length, l = i.length - c;
    return { ok: !0, count: i.length, present: c, absent: l, path: r };
  } catch (e) {
    return { ok: !1, error: String(e), count: 0, present: 0, absent: 0 };
  }
});
C.on("window-all-closed", () => {
  _t(), process.platform !== "darwin" && (C.quit(), w = null);
});
C.on("activate", () => {
  j.getAllWindows().length === 0 && lt();
});
C.whenReady().then(lt);
export {
  Ct as MAIN_DIST,
  Q as RENDERER_DIST,
  M as VITE_DEV_SERVER_URL
};
