import { ipcMain as f, app as b, BrowserWindow as P } from "electron";
import { fileURLToPath as ie } from "node:url";
import i from "node:path";
import l from "node:fs";
import { spawn as z } from "node:child_process";
const Y = i.dirname(ie(import.meta.url));
process.env.APP_ROOT = i.join(Y, "..");
const I = process.env.VITE_DEV_SERVER_URL, ve = i.join(process.env.APP_ROOT, "dist-electron"), K = i.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = I ? i.join(process.env.APP_ROOT, "public") : K;
const m = i.resolve(process.env.APP_ROOT, "..");
let S, _ = null, k = null;
const L = /* @__PURE__ */ new Set(), B = /* @__PURE__ */ new Set(), ce = 2, le = 8, ue = 1200, de = 20;
let v = null, x = null, R = !1;
function q() {
  if (process.env.PRIVACY_DATASET_PYTHON) return process.env.PRIVACY_DATASET_PYTHON;
  const n = process.env.CONDA_PREFIX;
  if (n) {
    const e = i.join(n, "bin", "python");
    if (l.existsSync(e)) return e;
  }
  return "python";
}
function X(n = {}) {
  const e = { ...process.env, PYTHONUNBUFFERED: "1", ...n }, t = [], r = process.env.CONDA_PREFIX;
  if (r) {
    const a = r.lastIndexOf("/envs/");
    a !== -1 && t.push(i.join(r.slice(0, a), "bin"));
  }
  const s = process.env.MAMBA_ROOT_PREFIX || process.env.CONDA_ROOT;
  if (s && t.push(i.join(s, "bin")), t.length > 0) {
    const a = e.PATH || "", o = new Set(a.split(":")), c = t.filter((u) => !o.has(u));
    c.length > 0 && (e.PATH = a + ":" + c.join(":"));
  }
  return e;
}
function y(n, e) {
  S && !S.isDestroyed() && S.webContents.send(n, e);
}
function h(n) {
  const e = n ? i.resolve(m, n) : i.join(m, "outputs");
  return {
    outDir: e,
    resultsJsonl: i.join(e, "results.jsonl"),
    summaryJson: i.join(e, "results.summary.json"),
    stateJson: i.join(e, "run_state.json"),
    explorerJsonl: i.join(e, "explorer.jsonl"),
    artifactsDir: i.join(e, "artifacts"),
    artifactsOkDir: i.join(e, "artifacts_ok"),
    // Shared across all runs so CrUX lookups are reused between separate outputs.
    cruxCacheJson: i.join(m, "results.crux_cache.json")
  };
}
function fe(n, e) {
  const t = n.split(/\r?\n/), r = [];
  for (const s of t) {
    const a = s.trim();
    if (a)
      try {
        r.push(JSON.parse(a)), e && r.length >= e;
      } catch {
        r.push({ _error: "invalid_json", raw: a });
      }
  }
  return r;
}
const U = /* @__PURE__ */ new Map(), $ = /* @__PURE__ */ new Map(), H = /* @__PURE__ */ new Map();
async function T(n) {
  const e = await l.promises.stat(n), t = U.get(n);
  if (t && t.mtimeMs === e.mtimeMs)
    return t.data;
  const r = await l.promises.readFile(n, "utf-8"), s = JSON.parse(r);
  return U.set(n, { mtimeMs: e.mtimeMs, data: s }), s;
}
async function G(n) {
  const e = await l.promises.stat(n), t = $.get(n);
  if (t && t.mtimeMs === e.mtimeMs)
    return t.data;
  const r = await l.promises.readFile(n, "utf-8"), s = fe(r);
  return $.set(n, { mtimeMs: e.mtimeMs, data: s }), s;
}
async function Q(n, e, t) {
  const r = Date.now(), s = H.get(n);
  if (s && s.expiresAt > r)
    return s.value;
  const a = await t();
  return H.set(n, { expiresAt: r + e, value: a }), a;
}
function O(n) {
  return n.trim().toLowerCase();
}
function Z(n) {
  const e = String(n || "").trim().toLowerCase();
  return e ? e.includes("/") && e.split("/").pop() || e : "";
}
function w(n, e) {
  if (!n.startsWith(`${e}-`)) return !1;
  const t = n.slice(e.length + 1);
  return /^\d/.test(t);
}
function me(n) {
  return n === "gpt-4o" || w(n, "gpt-4o") || n === "gpt-4.1" || w(n, "gpt-4.1");
}
function ee(n) {
  const e = Z(n);
  return e === "local" ? ["--llm-max-output-tokens", "2048", "--disable-exhaustion-check"] : e === "gpt-4o" || w(e, "gpt-4o") ? [
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
  ] : e === "gpt-4.1" || w(e, "gpt-4.1") ? [
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
  ] : e === "gpt-4o-mini" || w(e, "gpt-4o-mini") ? [
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
  ] : e === "gpt-4.1-mini" || w(e, "gpt-4.1-mini") ? [
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
  ] : e === "gpt-4.1-nano" || w(e, "gpt-4.1-nano") ? [
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
function te(n) {
  return i.join(h(n).outDir, "audit_state.json");
}
function J(n) {
  return i.join(h(n).outDir, "dashboard_run_manifest.json");
}
async function W(n, e) {
  await l.promises.mkdir(i.dirname(n), { recursive: !0 }), await l.promises.writeFile(n, JSON.stringify(e, null, 2), "utf-8");
}
async function pe(n) {
  if (!l.existsSync(n))
    return { verifiedSites: [], urlOverrides: {} };
  try {
    const e = await l.promises.readFile(n, "utf-8"), t = JSON.parse(e), s = (Array.isArray(t == null ? void 0 : t.verifiedSites) ? t.verifiedSites : []).filter((c) => typeof c == "string" && c.trim().length > 0).map((c) => O(c)), a = t != null && t.urlOverrides && typeof t.urlOverrides == "object" ? t.urlOverrides : {}, o = {};
    for (const [c, u] of Object.entries(a))
      typeof u == "string" && u.trim().length > 0 && (o[O(c)] = u.trim());
    return { verifiedSites: s, urlOverrides: o, updatedAt: t == null ? void 0 : t.updatedAt };
  } catch {
    return { verifiedSites: [], urlOverrides: {} };
  }
}
async function re(n, e = {}, t) {
  const r = q();
  try {
    _ = z(r, n, {
      cwd: m,
      env: X(e)
    });
  } catch (a) {
    return _ = null, { ok: !1, error: String(a) };
  }
  if (R = !1, v = (t == null ? void 0 : t.path) || null, x = (t == null ? void 0 : t.data) || null, v && x)
    try {
      await W(v, x);
    } catch (a) {
      y("scraper:error", { message: "run_manifest_write_failed", error: String(a) });
    }
  let s = "";
  return _.stdout.on("data", (a) => {
    s += a.toString();
    const o = s.split(/\r?\n/);
    s = o.pop() || "";
    for (const c of o) {
      const u = c.trim();
      if (u)
        try {
          const d = JSON.parse(u);
          (d == null ? void 0 : d.type) === "run_completed" && (R = !0), y("scraper:event", d);
        } catch {
          y("scraper:log", { message: u });
        }
    }
  }), _.stderr.on("data", (a) => {
    y("scraper:error", { message: a.toString() });
  }), _.on("error", (a) => {
    y("scraper:error", { message: String(a) });
  }), _.on("close", (a, o) => {
    if (y("scraper:exit", { code: a, signal: o }), v && x) {
      const c = {
        ...x,
        status: R ? "completed" : "interrupted",
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      R && (c.completedAt = c.updatedAt), W(v, c).catch((u) => {
        y("scraper:error", { message: "run_manifest_update_failed", error: String(u) });
      });
    }
    v = null, x = null, R = !1, _ = null;
  }), { ok: !0 };
}
async function ne(n, e = {}) {
  const t = q();
  try {
    k = z(t, n, {
      cwd: m,
      env: X(e)
    });
  } catch (s) {
    return k = null, { ok: !1, error: String(s) };
  }
  let r = "";
  return k.stdout.on("data", (s) => {
    r += s.toString();
    const a = r.split(/\r?\n/);
    r = a.pop() || "";
    for (const o of a)
      if (o.trim())
        if (o.startsWith("[STREAM] "))
          try {
            const c = JSON.parse(o.slice(9));
            y("annotator:stream", c);
          } catch {
            y("annotator:log", { message: o });
          }
        else
          y("annotator:log", { message: o });
  }), k.stderr.on("data", (s) => {
    y("annotator:log", { message: s.toString().trimEnd() });
  }), k.on("error", (s) => {
    y("annotator:log", { message: `Error: ${String(s)}` });
  }), k.on("close", (s, a) => {
    y("annotator:exit", { code: s, signal: a }), k = null;
  }), { ok: !0 };
}
async function se(n) {
  let e = 0;
  const t = await l.promises.readdir(n, { withFileTypes: !0 });
  for (const r of t) {
    const s = i.join(n, r.name);
    if (r.isDirectory())
      e += await se(s);
    else if (r.isFile())
      try {
        const a = await l.promises.stat(s);
        e += a.size;
      } catch {
        continue;
      }
  }
  return e;
}
function ae() {
  S = new P({
    icon: i.join(process.env.VITE_PUBLIC, "electron-vite.svg"),
    webPreferences: {
      preload: i.join(Y, "preload.mjs")
    }
  }), S.webContents.on("did-finish-load", () => {
    S == null || S.webContents.send("main-process-message", (/* @__PURE__ */ new Date()).toLocaleString());
  }), I ? S.loadURL(I) : S.loadFile(i.join(K, "index.html"));
}
function he(n) {
  const e = new P({
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
  return e.setMenuBarVisibility(!1), e.loadURL(n), L.add(e), e.on("closed", () => {
    L.delete(e);
  }), e;
}
function V(n) {
  return n.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function ge(n, e) {
  const t = new P({
    width: 1100,
    height: 800,
    title: e || "Run logs",
    backgroundColor: "#0B0E14",
    webPreferences: {
      contextIsolation: !0,
      nodeIntegration: !1,
      sandbox: !0
    }
  });
  t.setMenuBarVisibility(!1);
  const r = V(n || ""), s = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${V(e || "Run logs")}</title>
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
  return t.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(s)}`), B.add(t), t.on("closed", () => {
    B.delete(t);
  }), t;
}
f.handle("scraper:get-paths", (n, e) => h(e));
f.handle("scraper:read-summary", async (n, e) => {
  try {
    const t = e ? i.resolve(m, e) : h().summaryJson;
    return l.existsSync(t) ? { ok: !0, data: await T(t), path: t } : { ok: !1, error: "not_found", path: t };
  } catch (t) {
    return { ok: !1, error: String(t) };
  }
});
f.handle("scraper:read-state", async (n, e) => {
  try {
    const t = e ? i.resolve(m, e) : h().stateJson;
    return l.existsSync(t) ? { ok: !0, data: await T(t), path: t } : { ok: !1, error: "not_found", path: t };
  } catch (t) {
    return { ok: !1, error: String(t) };
  }
});
f.handle("scraper:read-explorer", async (n, e, t) => {
  try {
    const r = e ? i.resolve(m, e) : h().explorerJsonl;
    return l.existsSync(r) ? { ok: !0, data: r.endsWith(".jsonl") ? (await G(r)).slice(0, t || void 0) : await T(r), path: r } : { ok: !1, error: "not_found", path: r };
  } catch (r) {
    return { ok: !1, error: String(r) };
  }
});
f.handle("scraper:read-results", async (n, e, t) => {
  try {
    const r = e ? i.resolve(m, e) : h().resultsJsonl;
    return l.existsSync(r) ? { ok: !0, data: (await G(r)).slice(0, t || void 0), path: r } : { ok: !1, error: "not_found", path: r };
  } catch (r) {
    return { ok: !1, error: String(r) };
  }
});
f.handle("scraper:read-audit-state", async (n, e) => {
  try {
    const t = te(e);
    return { ok: !0, data: await pe(t), path: t };
  } catch (t) {
    return { ok: !1, error: String(t) };
  }
});
f.handle("scraper:read-run-manifest", async (n, e) => {
  try {
    const t = J(e);
    if (!l.existsSync(t))
      return { ok: !1, error: "not_found", path: t };
    const r = await l.promises.readFile(t, "utf-8");
    return { ok: !0, data: JSON.parse(r), path: t };
  } catch (t) {
    return { ok: !1, error: String(t) };
  }
});
f.handle(
  "scraper:write-audit-state",
  async (n, e) => {
    try {
      const t = te(e == null ? void 0 : e.outDir), r = i.dirname(t);
      await l.promises.mkdir(r, { recursive: !0 });
      const s = Array.isArray(e == null ? void 0 : e.verifiedSites) ? e.verifiedSites.filter((u) => typeof u == "string" && u.trim().length > 0).map((u) => O(u)) : [], a = (e == null ? void 0 : e.urlOverrides) || {}, o = {};
      for (const [u, d] of Object.entries(a))
        typeof d == "string" && d.trim().length > 0 && (o[O(u)] = d.trim());
      const c = {
        verifiedSites: Array.from(new Set(s)),
        urlOverrides: o,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      return await l.promises.writeFile(t, JSON.stringify(c, null, 2), "utf-8"), { ok: !0, data: c, path: t };
    } catch (t) {
      return { ok: !1, error: String(t) };
    }
  }
);
f.handle("scraper:read-artifact-text", async (n, e) => {
  try {
    const t = e == null ? void 0 : e.relativePath;
    if (!t)
      return { ok: !1, error: "missing_relative_path" };
    const r = e != null && e.outDir ? i.resolve(m, e.outDir) : h().outDir, s = i.resolve(r, t), a = r.endsWith(i.sep) ? r : `${r}${i.sep}`;
    return s !== r && !s.startsWith(a) ? { ok: !1, error: "path_outside_root" } : l.existsSync(s) ? { ok: !0, data: await l.promises.readFile(s, "utf-8"), path: s } : { ok: !1, error: "not_found", path: s };
  } catch (t) {
    return { ok: !1, error: String(t) };
  }
});
f.handle("scraper:folder-size", async (n, e) => {
  try {
    const t = e ? i.resolve(m, e) : h().outDir;
    return l.existsSync(t) ? { ok: !0, bytes: await Q(`folder-size:${t}`, 1e4, () => se(t)), path: t } : { ok: !1, error: "not_found", path: t };
  } catch (t) {
    return { ok: !1, error: String(t) };
  }
});
f.handle("scraper:list-runs", async (n, e) => {
  try {
    const t = e ? i.resolve(m, e) : h().outDir;
    if (!l.existsSync(t))
      return { ok: !1, error: "not_found", path: t };
    const r = await l.promises.readdir(t, { withFileTypes: !0 }), s = [];
    for (const a of r) {
      if (!a.isDirectory()) continue;
      const o = i.join(t, a.name), c = i.join(o, "results.summary.json"), u = i.join(o, "run_state.json");
      let d = null, p = null;
      if (l.existsSync(c))
        try {
          d = JSON.parse(await l.promises.readFile(c, "utf-8"));
        } catch {
          d = null;
        }
      if (l.existsSync(u))
        try {
          p = JSON.parse(await l.promises.readFile(u, "utf-8"));
        } catch {
          p = null;
        }
      if (!d && !p && !a.name.startsWith("output_"))
        continue;
      let g = "";
      try {
        g = (await l.promises.stat(o)).mtime.toISOString();
      } catch {
        g = "";
      }
      const D = (d == null ? void 0 : d.run_id) || (p == null ? void 0 : p.run_id) || a.name.replace(/^output_/, "");
      s.push({
        runId: D,
        folder: a.name,
        outDir: i.relative(m, o),
        summary: d,
        state: p,
        updated_at: (d == null ? void 0 : d.updated_at) || (p == null ? void 0 : p.updated_at) || g,
        started_at: (d == null ? void 0 : d.started_at) || (p == null ? void 0 : p.started_at) || null
      });
    }
    return s.sort((a, o) => String(o.updated_at || "").localeCompare(String(a.updated_at || ""))), { ok: !0, root: t, runs: s };
  } catch (t) {
    return { ok: !1, error: String(t) };
  }
});
f.handle("scraper:start", async (n, e = {}) => {
  if (_)
    return { ok: !1, error: "scraper_already_running" };
  const t = h(e.outDir), r = [
    "-m",
    "privacy_research_dataset.cli",
    "--out",
    t.resultsJsonl,
    "--artifacts-dir",
    e.artifactsDir ? i.resolve(m, e.artifactsDir) : t.artifactsDir,
    "--artifacts-ok-dir",
    t.artifactsOkDir,
    "--emit-events",
    "--state-file",
    t.stateJson,
    "--summary-out",
    t.summaryJson,
    "--explorer-out",
    t.explorerJsonl,
    "--concurrency",
    String(ce),
    "--crux-concurrency",
    String(le),
    "--policy-cache-max-entries",
    String(ue),
    "--tp-cache-flush-entries",
    String(de)
  ];
  if (Array.isArray(e.sites) && e.sites.length > 0)
    for (const c of e.sites) {
      const u = String(c || "").trim();
      u && r.push("--site", u);
    }
  else e.topN && r.push("--tranco-top", String(e.topN));
  if (e.trancoDate && r.push("--tranco-date", e.trancoDate), e.resumeAfterRank && Number.isFinite(e.resumeAfterRank) && r.push("--resume-after-rank", String(e.resumeAfterRank)), e.expectedTotalSites && Number.isFinite(e.expectedTotalSites) && r.push("--expected-total-sites", String(e.expectedTotalSites)), e.trackerRadarIndex) {
    const c = i.resolve(m, e.trackerRadarIndex);
    l.existsSync(c) ? r.push("--tracker-radar-index", c) : y("scraper:error", { message: "tracker_radar_index_not_found", path: c });
  }
  if (e.trackerDbIndex) {
    const c = i.resolve(m, e.trackerDbIndex);
    l.existsSync(c) ? r.push("--trackerdb-index", c) : y("scraper:error", { message: "trackerdb_index_not_found", path: c });
  }
  e.runId && r.push("--run-id", e.runId), e.upsertBySite && r.push("--upsert-by-site"), r.push("--crux-cache-file", t.cruxCacheJson), e.cruxFilter && (r.push("--crux-filter"), e.cruxApiKey && r.push("--crux-api-key", e.cruxApiKey)), e.skipHomeFailed && r.push("--skip-home-fetch-failed"), e.excludeSameEntity && r.push("--exclude-same-entity");
  const s = (/* @__PURE__ */ new Date()).toISOString(), a = {
    version: 1,
    status: "running",
    mode: Array.isArray(e.sites) && e.sites.length > 0 ? "append_sites" : "tranco",
    runId: e.runId,
    topN: e.topN,
    trancoDate: e.trancoDate,
    resumeAfterRank: e.resumeAfterRank,
    expectedTotalSites: e.expectedTotalSites,
    requestedSites: Array.isArray(e.sites) ? e.sites.map((c) => String(c).trim()).filter(Boolean) : [],
    cruxFilter: !!e.cruxFilter,
    startedAt: s,
    updatedAt: s
  }, o = await re(r, {}, {
    path: J(e.outDir),
    data: a
  });
  return o.ok ? { ok: !0, paths: t } : { ok: !1, error: o.error || "failed_to_start" };
});
f.handle("scraper:rerun-site", async (n, e = {}) => {
  if (_)
    return { ok: !1, error: "scraper_already_running" };
  if (k)
    return { ok: !1, error: "annotator_running" };
  const t = String(e.site || "").trim();
  if (!t)
    return { ok: !1, error: "missing_site" };
  const r = h(e.outDir), s = [
    "-m",
    "privacy_research_dataset.cli",
    "--site",
    t,
    "--out",
    r.resultsJsonl,
    "--artifacts-dir",
    e.artifactsDir ? i.resolve(m, e.artifactsDir) : r.artifactsDir,
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
  if (e.trackerRadarIndex) {
    const o = i.resolve(m, e.trackerRadarIndex);
    l.existsSync(o) ? s.push("--tracker-radar-index", o) : y("scraper:error", { message: "tracker_radar_index_not_found", path: o });
  }
  if (e.trackerDbIndex) {
    const o = i.resolve(m, e.trackerDbIndex);
    l.existsSync(o) ? s.push("--trackerdb-index", o) : y("scraper:error", { message: "trackerdb_index_not_found", path: o });
  }
  e.runId && s.push("--run-id", e.runId), e.excludeSameEntity && s.push("--exclude-same-entity"), e.policyUrlOverride && e.policyUrlOverride.trim() && s.push("--policy-url-override", e.policyUrlOverride.trim()), e.llmModel && e.llmModel.trim() && s.push("--llm-model", e.llmModel.trim());
  const a = await re(s);
  return a.ok ? { ok: !0, paths: r, site: t } : { ok: !1, error: a.error || "failed_to_start" };
});
f.handle("scraper:stop", async () => _ ? (_.kill(), { ok: !0 }) : { ok: !1, error: "not_running" });
f.handle("scraper:open-log-window", async (n, e) => {
  try {
    const t = (e == null ? void 0 : e.content) ?? "", r = e == null ? void 0 : e.title;
    return ge(t, r), { ok: !0 };
  } catch (t) {
    return { ok: !1, error: String(t) };
  }
});
f.handle("scraper:open-policy-window", async (n, e) => {
  if (!e || typeof e != "string")
    return { ok: !1, error: "invalid_url" };
  try {
    const t = new URL(e);
    return ["http:", "https:"].includes(t.protocol) ? (he(e), { ok: !0 }) : { ok: !1, error: "unsupported_protocol" };
  } catch (t) {
    return { ok: !1, error: String(t) };
  }
});
f.handle("scraper:clear-results", async (n, e) => {
  if (_)
    return { ok: !1, error: "scraper_running" };
  const t = h(e == null ? void 0 : e.outDir), r = [
    t.resultsJsonl,
    t.summaryJson,
    t.stateJson,
    t.explorerJsonl,
    i.join(t.outDir, "audit_state.json"),
    J(e == null ? void 0 : e.outDir)
  ], s = [], a = [], o = [];
  for (const c of r)
    try {
      l.existsSync(c) ? (await l.promises.rm(c, { force: !0 }), s.push(c)) : a.push(c);
    } catch (u) {
      o.push(`${c}: ${String(u)}`);
    }
  if (e != null && e.includeArtifacts)
    try {
      l.existsSync(t.artifactsDir) && (await l.promises.rm(t.artifactsDir, { recursive: !0, force: !0 }), s.push(t.artifactsDir));
    } catch (c) {
      o.push(`${t.artifactsDir}: ${String(c)}`);
    }
  return { ok: o.length === 0, removed: s, missing: a, errors: o, paths: t };
});
f.handle("scraper:delete-output", async (n, e) => {
  try {
    const t = e ? i.resolve(m, e) : h().outDir;
    return l.existsSync(t) ? (await l.promises.rm(t, { recursive: !0, force: !0 }), { ok: !0, path: t }) : { ok: !1, error: "not_found", path: t };
  } catch (t) {
    return { ok: !1, error: String(t) };
  }
});
f.handle("scraper:start-annotate", async (n, e = {}) => {
  if (k)
    return { ok: !1, error: "annotator_already_running" };
  const t = e.artifactsDir ? i.resolve(m, e.artifactsDir) : i.join(h().outDir, "artifacts"), r = [
    "-m",
    "privacy_research_dataset.annotate_cli",
    "--artifacts-dir",
    t
  ];
  e.llmModel && r.push("--llm-model", e.llmModel), e.tokenLimit && r.push("--token-limit", String(e.tokenLimit));
  const s = Z(e.llmModel), a = me(s) ? 1 : void 0;
  let o = e.concurrency || a;
  a && o && o > a && (o = a, y("annotator:log", {
    message: `[info] ${e.llmModel || s}: forcing concurrency ${a} for TPM stability.`
  })), o && r.push("--concurrency", String(o)), r.push(...ee(e.llmModel)), e.force && r.push("--force");
  const c = await ne(r);
  return c.ok ? { ok: !0, artifactsDir: t } : { ok: !1, error: c.error || "failed_to_start" };
});
f.handle("scraper:annotate-site", async (n, e = {}) => {
  if (k)
    return { ok: !1, error: "annotator_already_running" };
  if (_)
    return { ok: !1, error: "scraper_running" };
  const t = String(e.site || "").trim();
  if (!t)
    return { ok: !1, error: "missing_site" };
  const r = h(e.outDir), s = [
    "-m",
    "privacy_research_dataset.annotate_cli",
    "--artifacts-dir",
    r.artifactsDir,
    "--target-dir",
    t,
    "--concurrency",
    "1"
  ];
  e.llmModel && e.llmModel.trim() && s.push("--llm-model", e.llmModel.trim()), s.push(...ee(e.llmModel)), typeof e.tokenLimit == "number" && Number.isFinite(e.tokenLimit) && s.push("--token-limit", String(e.tokenLimit)), e.force !== !1 && s.push("--force");
  const a = await ne(s);
  return a.ok ? { ok: !0, artifactsDir: r.artifactsDir, site: t } : { ok: !1, error: a.error || "failed_to_start" };
});
f.handle("scraper:stop-annotate", async () => k ? (k.kill(), { ok: !0 }) : { ok: !1, error: "not_running" });
f.handle("scraper:check-tunnel", async () => {
  const n = await import("node:http");
  return new Promise((e) => {
    const t = n.default.get(
      { hostname: "::1", port: 8901, path: "/health", timeout: 3e3 },
      (r) => {
        r.resume();
        const s = typeof r.statusCode == "number" && r.statusCode < 400;
        e({ ok: s, status: r.statusCode });
      }
    );
    t.on("timeout", () => {
      t.destroy(), e({ ok: !1, error: "timeout" });
    }), t.on("error", (r) => e({ ok: !1, error: r.message }));
  });
});
f.handle("scraper:annotation-stats", async (n, e) => {
  try {
    const t = e ? i.resolve(m, e) : i.join(h().outDir, "artifacts");
    return l.existsSync(t) ? await Q(`annotation-stats:${t}`, 5e3, async () => {
      const r = async (g) => {
        try {
          return (await l.promises.readFile(g, "utf-8")).split(`
`).filter((A) => A.trim()).length;
        } catch {
          return 0;
        }
      }, s = await l.promises.readdir(t, { withFileTypes: !0 }), a = [], o = [];
      let c = 0, u = 0;
      for (const g of s) {
        if (!g.isDirectory()) continue;
        const D = i.join(t, g.name, "policy_statements.jsonl"), A = l.existsSync(D);
        let j = 0;
        A && (j = await r(D), c += j), a.push({ site: g.name, count: j, has_statements: A });
        const C = i.join(t, g.name, "third_party");
        if (l.existsSync(C)) {
          const oe = await l.promises.readdir(C, { withFileTypes: !0 });
          for (const F of oe) {
            if (!F.isDirectory()) continue;
            const M = i.join(C, F.name, "policy_statements.jsonl"), N = l.existsSync(M);
            let E = 0;
            N && (E = await r(M), u += E), o.push({ site: g.name, tp: F.name, count: E, has_statements: N });
          }
        }
      }
      const d = a.filter((g) => g.has_statements).length, p = o.filter((g) => g.has_statements).length;
      return {
        ok: !0,
        total_sites: a.length,
        annotated_sites: d,
        total_statements: c,
        per_site: a,
        tp_total: o.length,
        tp_annotated: p,
        tp_total_statements: u,
        per_tp: o
      };
    }) : { ok: !0, total_sites: 0, annotated_sites: 0, total_statements: 0, per_site: [] };
  } catch (t) {
    return { ok: !1, error: String(t) };
  }
});
f.handle("scraper:count-ok-artifacts", async (n, e) => {
  try {
    const r = h(e).artifactsOkDir;
    if (!l.existsSync(r))
      return { ok: !0, count: 0, sites: [], path: r };
    const a = (await l.promises.readdir(r, { withFileTypes: !0 })).filter((o) => o.isDirectory() || o.isSymbolicLink()).map((o) => o.name);
    return { ok: !0, count: a.length, sites: a, path: r };
  } catch (t) {
    return { ok: !1, error: String(t), count: 0, sites: [] };
  }
});
f.handle("scraper:read-tp-cache", async (n, e) => {
  try {
    const t = e ? i.resolve(m, e) : h().outDir, r = i.join(t, "results.tp_cache.json");
    if (!l.existsSync(r))
      return { ok: !1, error: "not_found", path: r };
    const s = await l.promises.readFile(r, "utf-8"), a = JSON.parse(s);
    let o = 0, c = 0, u = 0;
    const d = {};
    for (const p of Object.values(a)) {
      o++, p.text !== null && p.text !== void 0 ? c++ : p.error_message && u++;
      const g = String(p.status_code ?? "unknown");
      d[g] = (d[g] || 0) + 1;
    }
    return { ok: !0, total: o, fetched: c, failed: u, by_status: d };
  } catch (t) {
    return { ok: !1, error: String(t) };
  }
});
f.handle("scraper:crux-cache-stats", async (n, e) => {
  try {
    const r = h(e).cruxCacheJson;
    if (!l.existsSync(r))
      return { ok: !0, count: 0, present: 0, absent: 0, path: r };
    const s = await l.promises.readFile(r, "utf-8"), a = JSON.parse(s), o = Object.values(a), c = o.filter(Boolean).length, u = o.length - c;
    return { ok: !0, count: o.length, present: c, absent: u, path: r };
  } catch (t) {
    return { ok: !1, error: String(t), count: 0, present: 0, absent: 0 };
  }
});
b.on("window-all-closed", () => {
  process.platform !== "darwin" && (b.quit(), S = null);
});
b.on("activate", () => {
  P.getAllWindows().length === 0 && ae();
});
b.whenReady().then(ae);
export {
  ve as MAIN_DIST,
  K as RENDERER_DIST,
  I as VITE_DEV_SERVER_URL
};
