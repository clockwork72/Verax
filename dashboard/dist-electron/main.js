import { ipcMain as p, app as D, BrowserWindow as P } from "electron";
import { fileURLToPath as G } from "node:url";
import o from "node:path";
import c from "node:fs";
import { spawn as C } from "node:child_process";
const N = o.dirname(G(import.meta.url));
process.env.APP_ROOT = o.join(N, "..");
const E = process.env.VITE_DEV_SERVER_URL, ie = o.join(process.env.APP_ROOT, "dist-electron"), L = o.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = E ? o.join(process.env.APP_ROOT, "public") : L;
const d = o.resolve(process.env.APP_ROOT, "..");
let v, y = null, k = null;
const J = /* @__PURE__ */ new Set(), F = /* @__PURE__ */ new Set();
function K() {
  if (process.env.PRIVACY_DATASET_PYTHON) return process.env.PRIVACY_DATASET_PYTHON;
  const s = process.env.CONDA_PREFIX;
  if (s) {
    const e = o.join(s, "bin", "python");
    if (c.existsSync(e)) return e;
  }
  return "python";
}
function U(s = {}) {
  const e = { ...process.env, PYTHONUNBUFFERED: "1", ...s }, t = [], r = process.env.CONDA_PREFIX;
  if (r) {
    const a = r.lastIndexOf("/envs/");
    a !== -1 && t.push(o.join(r.slice(0, a), "bin"));
  }
  const n = process.env.MAMBA_ROOT_PREFIX || process.env.CONDA_ROOT;
  if (n && t.push(o.join(n, "bin")), t.length > 0) {
    const a = e.PATH || "", l = new Set(a.split(":")), i = t.filter((u) => !l.has(u));
    i.length > 0 && (e.PATH = a + ":" + i.join(":"));
  }
  return e;
}
function _(s, e) {
  v && !v.isDestroyed() && v.webContents.send(s, e);
}
function g(s) {
  const e = s ? o.resolve(d, s) : o.join(d, "outputs");
  return {
    outDir: e,
    resultsJsonl: o.join(e, "results.jsonl"),
    summaryJson: o.join(e, "results.summary.json"),
    stateJson: o.join(e, "run_state.json"),
    explorerJsonl: o.join(e, "explorer.jsonl"),
    artifactsDir: o.join(e, "artifacts")
  };
}
function V(s, e) {
  const t = s.split(/\r?\n/), r = [];
  for (const n of t) {
    const a = n.trim();
    if (a)
      try {
        if (r.push(JSON.parse(a)), e && r.length >= e) break;
      } catch {
        r.push({ _error: "invalid_json", raw: a });
      }
  }
  return r;
}
function b(s) {
  return s.trim().toLowerCase();
}
function W(s) {
  const e = String(s || "").trim().toLowerCase();
  return e ? e.includes("/") && e.split("/").pop() || e : "";
}
function S(s, e) {
  if (!s.startsWith(`${e}-`)) return !1;
  const t = s.slice(e.length + 1);
  return /^\d/.test(t);
}
function Q(s) {
  return s === "gpt-4o" || S(s, "gpt-4o") || s === "gpt-4.1" || S(s, "gpt-4.1");
}
function $(s) {
  const e = W(s);
  return e === "gpt-4o" || S(e, "gpt-4o") ? [
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
  ] : e === "gpt-4.1" || S(e, "gpt-4.1") ? [
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
  ] : e === "gpt-4o-mini" || S(e, "gpt-4o-mini") ? [
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
  ] : e === "gpt-4.1-mini" || S(e, "gpt-4.1-mini") ? [
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
  ] : e === "gpt-4.1-nano" || S(e, "gpt-4.1-nano") ? [
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
function B(s) {
  return o.join(g(s).outDir, "audit_state.json");
}
async function Z(s) {
  if (!c.existsSync(s))
    return { verifiedSites: [], urlOverrides: {} };
  try {
    const e = await c.promises.readFile(s, "utf-8"), t = JSON.parse(e), n = (Array.isArray(t == null ? void 0 : t.verifiedSites) ? t.verifiedSites : []).filter((i) => typeof i == "string" && i.trim().length > 0).map((i) => b(i)), a = t != null && t.urlOverrides && typeof t.urlOverrides == "object" ? t.urlOverrides : {}, l = {};
    for (const [i, u] of Object.entries(a))
      typeof u == "string" && u.trim().length > 0 && (l[b(i)] = u.trim());
    return { verifiedSites: n, urlOverrides: l, updatedAt: t == null ? void 0 : t.updatedAt };
  } catch {
    return { verifiedSites: [], urlOverrides: {} };
  }
}
async function z(s, e = {}) {
  const t = K();
  try {
    y = C(t, s, {
      cwd: d,
      env: U(e)
    });
  } catch (n) {
    return y = null, { ok: !1, error: String(n) };
  }
  let r = "";
  return y.stdout.on("data", (n) => {
    r += n.toString();
    const a = r.split(/\r?\n/);
    r = a.pop() || "";
    for (const l of a) {
      const i = l.trim();
      if (i)
        try {
          const u = JSON.parse(i);
          _("scraper:event", u);
        } catch {
          _("scraper:log", { message: i });
        }
    }
  }), y.stderr.on("data", (n) => {
    _("scraper:error", { message: n.toString() });
  }), y.on("error", (n) => {
    _("scraper:error", { message: String(n) });
  }), y.on("close", (n, a) => {
    _("scraper:exit", { code: n, signal: a }), y = null;
  }), { ok: !0 };
}
async function H(s, e = {}) {
  const t = K();
  try {
    k = C(t, s, {
      cwd: d,
      env: U(e)
    });
  } catch (r) {
    return k = null, { ok: !1, error: String(r) };
  }
  return k.stdout.on("data", (r) => {
    _("annotator:log", { message: r.toString().trimEnd() });
  }), k.stderr.on("data", (r) => {
    _("annotator:log", { message: r.toString().trimEnd() });
  }), k.on("error", (r) => {
    _("annotator:log", { message: `Error: ${String(r)}` });
  }), k.on("close", (r, n) => {
    _("annotator:exit", { code: r, signal: n }), k = null;
  }), { ok: !0 };
}
async function Y(s) {
  let e = 0;
  const t = await c.promises.readdir(s, { withFileTypes: !0 });
  for (const r of t) {
    const n = o.join(s, r.name);
    if (r.isDirectory())
      e += await Y(n);
    else if (r.isFile())
      try {
        const a = await c.promises.stat(n);
        e += a.size;
      } catch {
        continue;
      }
  }
  return e;
}
function q() {
  v = new P({
    icon: o.join(process.env.VITE_PUBLIC, "electron-vite.svg"),
    webPreferences: {
      preload: o.join(N, "preload.mjs")
    }
  }), v.webContents.on("did-finish-load", () => {
    v == null || v.webContents.send("main-process-message", (/* @__PURE__ */ new Date()).toLocaleString());
  }), E ? v.loadURL(E) : v.loadFile(o.join(L, "index.html"));
}
function ee(s) {
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
  return e.setMenuBarVisibility(!1), e.loadURL(s), J.add(e), e.on("closed", () => {
    J.delete(e);
  }), e;
}
function M(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function te(s, e) {
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
  const r = M(s || ""), n = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${M(e || "Run logs")}</title>
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
  return t.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(n)}`), F.add(t), t.on("closed", () => {
    F.delete(t);
  }), t;
}
p.handle("scraper:get-paths", (s, e) => g(e));
p.handle("scraper:read-summary", async (s, e) => {
  try {
    const t = e ? o.resolve(d, e) : g().summaryJson;
    if (!c.existsSync(t))
      return { ok: !1, error: "not_found", path: t };
    const r = await c.promises.readFile(t, "utf-8");
    return { ok: !0, data: JSON.parse(r), path: t };
  } catch (t) {
    return { ok: !1, error: String(t) };
  }
});
p.handle("scraper:read-state", async (s, e) => {
  try {
    const t = e ? o.resolve(d, e) : g().stateJson;
    if (!c.existsSync(t))
      return { ok: !1, error: "not_found", path: t };
    const r = await c.promises.readFile(t, "utf-8");
    return { ok: !0, data: JSON.parse(r), path: t };
  } catch (t) {
    return { ok: !1, error: String(t) };
  }
});
p.handle("scraper:read-explorer", async (s, e, t) => {
  try {
    const r = e ? o.resolve(d, e) : g().explorerJsonl;
    if (!c.existsSync(r))
      return { ok: !1, error: "not_found", path: r };
    const n = await c.promises.readFile(r, "utf-8");
    return { ok: !0, data: r.endsWith(".jsonl") ? V(n, t) : JSON.parse(n), path: r };
  } catch (r) {
    return { ok: !1, error: String(r) };
  }
});
p.handle("scraper:read-results", async (s, e, t) => {
  try {
    const r = e ? o.resolve(d, e) : g().resultsJsonl;
    if (!c.existsSync(r))
      return { ok: !1, error: "not_found", path: r };
    const n = await c.promises.readFile(r, "utf-8");
    return { ok: !0, data: V(n, t), path: r };
  } catch (r) {
    return { ok: !1, error: String(r) };
  }
});
p.handle("scraper:read-audit-state", async (s, e) => {
  try {
    const t = B(e);
    return { ok: !0, data: await Z(t), path: t };
  } catch (t) {
    return { ok: !1, error: String(t) };
  }
});
p.handle(
  "scraper:write-audit-state",
  async (s, e) => {
    try {
      const t = B(e == null ? void 0 : e.outDir), r = o.dirname(t);
      await c.promises.mkdir(r, { recursive: !0 });
      const n = Array.isArray(e == null ? void 0 : e.verifiedSites) ? e.verifiedSites.filter((u) => typeof u == "string" && u.trim().length > 0).map((u) => b(u)) : [], a = (e == null ? void 0 : e.urlOverrides) || {}, l = {};
      for (const [u, f] of Object.entries(a))
        typeof f == "string" && f.trim().length > 0 && (l[b(u)] = f.trim());
      const i = {
        verifiedSites: Array.from(new Set(n)),
        urlOverrides: l,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      return await c.promises.writeFile(t, JSON.stringify(i, null, 2), "utf-8"), { ok: !0, data: i, path: t };
    } catch (t) {
      return { ok: !1, error: String(t) };
    }
  }
);
p.handle("scraper:read-artifact-text", async (s, e) => {
  try {
    const t = e == null ? void 0 : e.relativePath;
    if (!t)
      return { ok: !1, error: "missing_relative_path" };
    const r = e != null && e.outDir ? o.resolve(d, e.outDir) : g().outDir, n = o.resolve(r, t), a = r.endsWith(o.sep) ? r : `${r}${o.sep}`;
    return n !== r && !n.startsWith(a) ? { ok: !1, error: "path_outside_root" } : c.existsSync(n) ? { ok: !0, data: await c.promises.readFile(n, "utf-8"), path: n } : { ok: !1, error: "not_found", path: n };
  } catch (t) {
    return { ok: !1, error: String(t) };
  }
});
p.handle("scraper:folder-size", async (s, e) => {
  try {
    const t = e ? o.resolve(d, e) : g().outDir;
    return c.existsSync(t) ? { ok: !0, bytes: await Y(t), path: t } : { ok: !1, error: "not_found", path: t };
  } catch (t) {
    return { ok: !1, error: String(t) };
  }
});
p.handle("scraper:list-runs", async (s, e) => {
  try {
    const t = e ? o.resolve(d, e) : g().outDir;
    if (!c.existsSync(t))
      return { ok: !1, error: "not_found", path: t };
    const r = await c.promises.readdir(t, { withFileTypes: !0 }), n = [];
    for (const a of r) {
      if (!a.isDirectory()) continue;
      const l = o.join(t, a.name), i = o.join(l, "results.summary.json"), u = o.join(l, "run_state.json");
      let f = null, m = null;
      if (c.existsSync(i))
        try {
          f = JSON.parse(await c.promises.readFile(i, "utf-8"));
        } catch {
          f = null;
        }
      if (c.existsSync(u))
        try {
          m = JSON.parse(await c.promises.readFile(u, "utf-8"));
        } catch {
          m = null;
        }
      if (!f && !m && !a.name.startsWith("output_"))
        continue;
      let h = "";
      try {
        h = (await c.promises.stat(l)).mtime.toISOString();
      } catch {
        h = "";
      }
      const w = (f == null ? void 0 : f.run_id) || (m == null ? void 0 : m.run_id) || a.name.replace(/^output_/, "");
      n.push({
        runId: w,
        folder: a.name,
        outDir: o.relative(d, l),
        summary: f,
        state: m,
        updated_at: (f == null ? void 0 : f.updated_at) || (m == null ? void 0 : m.updated_at) || h,
        started_at: (f == null ? void 0 : f.started_at) || (m == null ? void 0 : m.started_at) || null
      });
    }
    return n.sort((a, l) => String(l.updated_at || "").localeCompare(String(a.updated_at || ""))), { ok: !0, root: t, runs: n };
  } catch (t) {
    return { ok: !1, error: String(t) };
  }
});
p.handle("scraper:start", async (s, e = {}) => {
  if (y)
    return { ok: !1, error: "scraper_already_running" };
  const t = g(e.outDir), r = [
    "-m",
    "privacy_research_dataset.cli",
    "--out",
    t.resultsJsonl,
    "--artifacts-dir",
    e.artifactsDir ? o.resolve(d, e.artifactsDir) : t.artifactsDir,
    "--emit-events",
    "--state-file",
    t.stateJson,
    "--summary-out",
    t.summaryJson,
    "--explorer-out",
    t.explorerJsonl
  ];
  if (e.topN && r.push("--tranco-top", String(e.topN)), e.trancoDate && r.push("--tranco-date", e.trancoDate), e.trackerRadarIndex) {
    const a = o.resolve(d, e.trackerRadarIndex);
    c.existsSync(a) ? r.push("--tracker-radar-index", a) : _("scraper:error", { message: "tracker_radar_index_not_found", path: a });
  }
  if (e.trackerDbIndex) {
    const a = o.resolve(d, e.trackerDbIndex);
    c.existsSync(a) ? r.push("--trackerdb-index", a) : _("scraper:error", { message: "trackerdb_index_not_found", path: a });
  }
  e.runId && r.push("--run-id", e.runId), e.cruxFilter && (r.push("--crux-filter"), e.cruxApiKey && r.push("--crux-api-key", e.cruxApiKey)), e.skipHomeFailed && r.push("--skip-home-fetch-failed"), e.excludeSameEntity && r.push("--exclude-same-entity");
  const n = await z(r);
  return n.ok ? { ok: !0, paths: t } : { ok: !1, error: n.error || "failed_to_start" };
});
p.handle("scraper:rerun-site", async (s, e = {}) => {
  if (y)
    return { ok: !1, error: "scraper_already_running" };
  if (k)
    return { ok: !1, error: "annotator_running" };
  const t = String(e.site || "").trim();
  if (!t)
    return { ok: !1, error: "missing_site" };
  const r = g(e.outDir), n = [
    "-m",
    "privacy_research_dataset.cli",
    "--site",
    t,
    "--out",
    r.resultsJsonl,
    "--artifacts-dir",
    e.artifactsDir ? o.resolve(d, e.artifactsDir) : r.artifactsDir,
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
    const i = o.resolve(d, e.trackerRadarIndex);
    c.existsSync(i) ? n.push("--tracker-radar-index", i) : _("scraper:error", { message: "tracker_radar_index_not_found", path: i });
  }
  if (e.trackerDbIndex) {
    const i = o.resolve(d, e.trackerDbIndex);
    c.existsSync(i) ? n.push("--trackerdb-index", i) : _("scraper:error", { message: "trackerdb_index_not_found", path: i });
  }
  e.runId && n.push("--run-id", e.runId), e.excludeSameEntity && n.push("--exclude-same-entity"), e.policyUrlOverride && e.policyUrlOverride.trim() && n.push("--policy-url-override", e.policyUrlOverride.trim()), e.llmModel && e.llmModel.trim() && n.push("--llm-model", e.llmModel.trim());
  const a = {};
  e.openaiApiKey && e.openaiApiKey.trim() && (a.OPENAI_API_KEY = e.openaiApiKey.trim());
  const l = await z(n, a);
  return l.ok ? { ok: !0, paths: r, site: t } : { ok: !1, error: l.error || "failed_to_start" };
});
p.handle("scraper:stop", async () => y ? (y.kill(), { ok: !0 }) : { ok: !1, error: "not_running" });
p.handle("scraper:open-log-window", async (s, e) => {
  try {
    const t = (e == null ? void 0 : e.content) ?? "", r = e == null ? void 0 : e.title;
    return te(t, r), { ok: !0 };
  } catch (t) {
    return { ok: !1, error: String(t) };
  }
});
p.handle("scraper:open-policy-window", async (s, e) => {
  if (!e || typeof e != "string")
    return { ok: !1, error: "invalid_url" };
  try {
    const t = new URL(e);
    return ["http:", "https:"].includes(t.protocol) ? (ee(e), { ok: !0 }) : { ok: !1, error: "unsupported_protocol" };
  } catch (t) {
    return { ok: !1, error: String(t) };
  }
});
p.handle("scraper:clear-results", async (s, e) => {
  if (y)
    return { ok: !1, error: "scraper_running" };
  const t = g(e == null ? void 0 : e.outDir), r = [
    t.resultsJsonl,
    t.summaryJson,
    t.stateJson,
    t.explorerJsonl,
    o.join(t.outDir, "audit_state.json")
  ], n = [], a = [], l = [];
  for (const i of r)
    try {
      c.existsSync(i) ? (await c.promises.rm(i, { force: !0 }), n.push(i)) : a.push(i);
    } catch (u) {
      l.push(`${i}: ${String(u)}`);
    }
  if (e != null && e.includeArtifacts)
    try {
      c.existsSync(t.artifactsDir) && (await c.promises.rm(t.artifactsDir, { recursive: !0, force: !0 }), n.push(t.artifactsDir));
    } catch (i) {
      l.push(`${t.artifactsDir}: ${String(i)}`);
    }
  return { ok: l.length === 0, removed: n, missing: a, errors: l, paths: t };
});
p.handle("scraper:delete-output", async (s, e) => {
  try {
    const t = e ? o.resolve(d, e) : g().outDir;
    return c.existsSync(t) ? (await c.promises.rm(t, { recursive: !0, force: !0 }), { ok: !0, path: t }) : { ok: !1, error: "not_found", path: t };
  } catch (t) {
    return { ok: !1, error: String(t) };
  }
});
p.handle("scraper:start-annotate", async (s, e = {}) => {
  if (k)
    return { ok: !1, error: "annotator_already_running" };
  const t = e.artifactsDir ? o.resolve(d, e.artifactsDir) : o.join(g().outDir, "artifacts"), r = [
    "-m",
    "privacy_research_dataset.annotate_cli",
    "--artifacts-dir",
    t
  ];
  e.llmModel && r.push("--llm-model", e.llmModel), e.tokenLimit && r.push("--token-limit", String(e.tokenLimit));
  const n = W(e.llmModel), a = Q(n) ? 1 : void 0;
  let l = e.concurrency || a;
  a && l && l > a && (l = a, _("annotator:log", {
    message: `[info] ${e.llmModel || n}: forcing concurrency ${a} for TPM stability.`
  })), l && r.push("--concurrency", String(l)), r.push(...$(e.llmModel)), e.force && r.push("--force");
  const i = {};
  e.openaiApiKey && (i.OPENAI_API_KEY = e.openaiApiKey);
  const u = await H(r, i);
  return u.ok ? { ok: !0, artifactsDir: t } : { ok: !1, error: u.error || "failed_to_start" };
});
p.handle("scraper:annotate-site", async (s, e = {}) => {
  if (k)
    return { ok: !1, error: "annotator_already_running" };
  if (y)
    return { ok: !1, error: "scraper_running" };
  const t = String(e.site || "").trim();
  if (!t)
    return { ok: !1, error: "missing_site" };
  const r = g(e.outDir), n = [
    "-m",
    "privacy_research_dataset.annotate_cli",
    "--artifacts-dir",
    r.artifactsDir,
    "--target-dir",
    t,
    "--concurrency",
    "1"
  ];
  e.llmModel && e.llmModel.trim() && n.push("--llm-model", e.llmModel.trim()), n.push(...$(e.llmModel)), typeof e.tokenLimit == "number" && Number.isFinite(e.tokenLimit) && n.push("--token-limit", String(e.tokenLimit)), e.force !== !1 && n.push("--force");
  const a = {};
  e.openaiApiKey && e.openaiApiKey.trim() && (a.OPENAI_API_KEY = e.openaiApiKey.trim());
  const l = await H(n, a);
  return l.ok ? { ok: !0, artifactsDir: r.artifactsDir, site: t } : { ok: !1, error: l.error || "failed_to_start" };
});
p.handle("scraper:stop-annotate", async () => k ? (k.kill(), { ok: !0 }) : { ok: !1, error: "not_running" });
p.handle("scraper:annotation-stats", async (s, e) => {
  try {
    const t = e ? o.resolve(d, e) : o.join(g().outDir, "artifacts");
    if (!c.existsSync(t))
      return { ok: !0, total_sites: 0, annotated_sites: 0, total_statements: 0, per_site: [] };
    const r = async (h) => {
      try {
        return (await c.promises.readFile(h, "utf-8")).split(`
`).filter((x) => x.trim()).length;
      } catch {
        return 0;
      }
    }, n = await c.promises.readdir(t, { withFileTypes: !0 }), a = [], l = [];
    let i = 0, u = 0;
    for (const h of n) {
      if (!h.isDirectory()) continue;
      const w = o.join(t, h.name, "policy_statements.jsonl"), x = c.existsSync(w);
      let O = 0;
      x && (O = await r(w), i += O), a.push({ site: h.name, count: O, has_statements: x });
      const A = o.join(t, h.name, "third_party");
      if (c.existsSync(A)) {
        const X = await c.promises.readdir(A, { withFileTypes: !0 });
        for (const R of X) {
          if (!R.isDirectory()) continue;
          const I = o.join(A, R.name, "policy_statements.jsonl"), T = c.existsSync(I);
          let j = 0;
          T && (j = await r(I), u += j), l.push({ site: h.name, tp: R.name, count: j, has_statements: T });
        }
      }
    }
    const f = a.filter((h) => h.has_statements).length, m = l.filter((h) => h.has_statements).length;
    return {
      ok: !0,
      total_sites: a.length,
      annotated_sites: f,
      total_statements: i,
      per_site: a,
      tp_total: l.length,
      tp_annotated: m,
      tp_total_statements: u,
      per_tp: l
    };
  } catch (t) {
    return { ok: !1, error: String(t) };
  }
});
p.handle("scraper:read-tp-cache", async (s, e) => {
  try {
    const t = e ? o.resolve(d, e) : g().outDir, r = o.join(t, "results.tp_cache.json");
    if (!c.existsSync(r))
      return { ok: !1, error: "not_found", path: r };
    const n = await c.promises.readFile(r, "utf-8"), a = JSON.parse(n);
    let l = 0, i = 0, u = 0;
    const f = {};
    for (const m of Object.values(a)) {
      l++, m.text !== null && m.text !== void 0 ? i++ : m.error_message && u++;
      const h = String(m.status_code ?? "unknown");
      f[h] = (f[h] || 0) + 1;
    }
    return { ok: !0, total: l, fetched: i, failed: u, by_status: f };
  } catch (t) {
    return { ok: !1, error: String(t) };
  }
});
D.on("window-all-closed", () => {
  process.platform !== "darwin" && (D.quit(), v = null);
});
D.on("activate", () => {
  P.getAllWindows().length === 0 && q();
});
D.whenReady().then(q);
export {
  ie as MAIN_DIST,
  L as RENDERER_DIST,
  E as VITE_DEV_SERVER_URL
};
