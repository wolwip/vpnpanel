/**
 * recon-routes.js — маршруты разведки для vpnpanel (голый node:http, node:sqlite, ESM).
 *
 * Интеграция в server.js:
 *   import { handleRecon } from "./recon-routes.js";
 *   // ...внутри createServer((req,res)=>{...}), сразу после обработки OPTIONS:
 *   if (p === "/recon" && method === "GET") { <отдать recon-dashboard.html>; return; }
 *   if (p.startsWith("/api/recon")) {
 *     await handleRecon({ req, res, p, method, db, isAuth, send, sendTelegram });
 *     return;
 *   }
 *
 * ctx: { req, res, p, method, db, isAuth, send, sendTelegram, resolveTarget?, assetsTable? }
 *   - db: DatabaseSync (node:sqlite), db.prepare().{get,all,run}, db.exec
 *   - isAuth(req) -> bool
 *   - send(res, code, obj) -> JSON-ответ (хелпер vpnpanel)
 *   - sendTelegram(text) -> void  (опционально; алерты по новым CRIT/HIGH)
 *   - resolveTarget(asset) -> ip|домен для скана (по умолч. a.ip || a.domain)
 */

import { reconHost, PORTS_STACK } from "./recon.js";

// ── схема (ленивая миграция, asset_id — TEXT, т.к. assets.id это uuid-строка) ──
let schemaReady = false;
function ensureSchema(db) {
  if (schemaReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS recon_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id TEXT NOT NULL,
      scanned_at TEXT NOT NULL,
      worst_sev TEXT,
      crit INTEGER DEFAULT 0, high INTEGER DEFAULT 0,
      warn INTEGER DEFAULT 0, info INTEGER DEFAULT 0,
      open_count INTEGER DEFAULT 0,
      findings_json TEXT NOT NULL,
      model_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recon_asset ON recon_snapshots(asset_id, id DESC);
  `);
  schemaReady = true;
}

function readJson(req) {
  return new Promise((resolve) => {
    try {
      let d = "";
      req.on("data", (c) => { if (d.length < 1e6) d += c; });
      req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
      req.on("error", () => resolve({}));
    } catch { resolve({}); }
  });
}

const countSev = (findings) => {
  const c = { CRIT: 0, HIGH: 0, WARN: 0, INFO: 0 };
  for (const f of findings || []) if (c[f.sev] != null) c[f.sev]++;
  return c;
};
const openCount = (m) => (m.live?.open?.length) || (m.censys?.services?.length) || 0;

// ─────────────────────────────────────────────────────────────────────────────
export async function handleRecon(ctx) {
  const {
    req, res, p, method, db, isAuth, send,
    sendTelegram = null,
    resolveTarget = (a) => a.ip || a.domain,
    assetsTable = "assets",
    tokenEnv = "CENSYS_PLATFORM_TOKEN",
    orgEnv = "CENSYS_PLATFORM_ORGID",
  } = ctx;

  ensureSchema(db);
  if (!isAuth(req)) { send(res, 401, { error: "Не авторизован" }); return true; }

  const getAsset = (id) => db.prepare(`SELECT * FROM ${assetsTable} WHERE id = ?`).get(id);

  // ── overview ──────────────────────────────────────────────────────────────
  if (p === "/api/recon/overview" && method === "GET") {
    const rows = db.prepare(`
      SELECT s.* FROM recon_snapshots s
      JOIN (SELECT asset_id, MAX(id) AS mx FROM recon_snapshots GROUP BY asset_id) t
        ON s.asset_id = t.asset_id AND s.id = t.mx
    `).all();
    const byAsset = new Map(rows.map((r) => [String(r.asset_id), r]));
    const assets = db.prepare(
      `SELECT * FROM ${assetsTable} WHERE inactive = 0 AND (ip != '' OR domain != '')`
    ).all();
    const out = assets.map((a) => {
      const s = byAsset.get(String(a.id));
      return {
        asset_id: a.id, name: a.name || resolveTarget(a), target: resolveTarget(a),
        scanned_at: s?.scanned_at || null, worst_sev: s?.worst_sev || null,
        counts: s ? { CRIT: s.crit, HIGH: s.high, WARN: s.warn, INFO: s.info } : null,
        open_count: s?.open_count ?? null, has_scan: !!s,
      };
    });
    send(res, 200, out); return true;
  }

  let m;
  // ── таймлайн ────────────────────────────────────────────────────────────────
  if ((m = p.match(/^\/api\/recon\/([^/]+)\/timeline$/)) && method === "GET") {
    const rows = db.prepare(
      `SELECT id, scanned_at, model_json FROM recon_snapshots WHERE asset_id = ? ORDER BY id ASC LIMIT 300`
    ).all(m[1]);
    if (!rows.length) { send(res, 200, []); return true; }
    const models = rows.map((r) => ({ id: r.id, at: r.scanned_at, m: JSON.parse(r.model_json) }));
    const tl = [{ at: models[0].at, from_snap: null, to_snap: models[0].id,
      changes: [{ type: "baseline", sev: "INFO", text: "Первый снимок — базовая точка отсчёта" }] }];
    for (let i = 1; i < models.length; i++) {
      const ch = diffSnapshots(models[i - 1].m, models[i].m);
      if (ch.length) tl.push({ at: models[i].at, from_snap: models[i - 1].id, to_snap: models[i].id, changes: ch });
    }
    tl.reverse();
    send(res, 200, tl); return true;
  }

  // ── конкретный снимок ─────────────────────────────────────────────────────
  if ((m = p.match(/^\/api\/recon\/([^/]+)\/snapshot\/([^/]+)$/)) && method === "GET") {
    const row = db.prepare(`SELECT * FROM recon_snapshots WHERE id = ? AND asset_id = ?`)
      .get(Number(m[2]), m[1]);
    if (!row) { send(res, 404, { error: "снимок не найден" }); return true; }
    send(res, 200, { id: row.id, scanned_at: row.scanned_at, worst_sev: row.worst_sev,
      model: JSON.parse(row.model_json) }); return true;
  }

  // ── запустить скан ──────────────────────────────────────────────────────────
  if ((m = p.match(/^\/api\/recon\/([^/]+)\/scan$/)) && method === "POST") {
    const a = getAsset(m[1]);
    if (!a) { send(res, 404, { error: "актив не найден" }); return true; }
    const target = resolveTarget(a);
    if (!target) { send(res, 400, { error: "у актива нет IP/домена" }); return true; }
    const body = await readJson(req);
    try {
      const model = await reconHost(target, {
        token: process.env[tokenEnv], orgId: process.env[orgEnv],
        ports: PORTS_STACK, timeout: Number(body.timeout) || 3000,
      });
      const { card, ...clean } = model;
      if (clean.censys) delete clean.censys._raw;
      const c = countSev(model.findings);

      const prev = db.prepare(
        `SELECT model_json FROM recon_snapshots WHERE asset_id = ? ORDER BY id DESC LIMIT 1`
      ).get(a.id);

      db.prepare(`INSERT INTO recon_snapshots
        (asset_id, scanned_at, worst_sev, crit, high, warn, info, open_count, findings_json, model_json)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        String(a.id), model.live?.scannedAt || new Date().toISOString(), model.worstSev,
        c.CRIT, c.HIGH, c.WARN, c.INFO, openCount(model),
        JSON.stringify(model.findings), JSON.stringify(clean));

      if (sendTelegram) {
        if (prev) {
          const ch = diffSnapshots(JSON.parse(prev.model_json), clean)
            .filter((x) => x.sev === "CRIT" || x.sev === "HIGH");
          if (ch.length) sendTelegram(`🛰 recon ${a.name || target}\n` +
            ch.map((x) => `${x.sev === "CRIT" ? "🔴" : "🟠"} ${x.text}`).join("\n"));
        } else if (model.worstSev === "CRIT") {
          sendTelegram(`🛰 recon ${a.name || target}\n🔴 ` +
            model.findings.filter((f) => f.sev === "CRIT").map((f) => f.msg).join("\n🔴 "));
        }
      }
      send(res, 200, { worstSev: model.worstSev, counts: c, findings: model.findings, model: clean });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
    return true;
  }

  // ── детали актива ───────────────────────────────────────────────────────────
  if ((m = p.match(/^\/api\/recon\/([^/]+)$/)) && method === "GET") {
    const a = getAsset(m[1]);
    if (!a) { send(res, 404, { error: "актив не найден" }); return true; }
    const snaps = db.prepare(
      `SELECT id, scanned_at, worst_sev, crit, high, warn, info, open_count
       FROM recon_snapshots WHERE asset_id = ? ORDER BY id DESC LIMIT 200`
    ).all(a.id);
    const latest = snaps[0]
      ? JSON.parse(db.prepare(`SELECT model_json FROM recon_snapshots WHERE id = ?`).get(snaps[0].id).model_json)
      : null;
    send(res, 200, {
      asset: { id: a.id, name: a.name || resolveTarget(a), target: resolveTarget(a) },
      latest,
      snapshots: snaps.map((s) => ({
        id: s.id, scanned_at: s.scanned_at, worst_sev: s.worst_sev,
        counts: { CRIT: s.crit, HIGH: s.high, WARN: s.warn, INFO: s.info }, open_count: s.open_count,
      })),
    });
    return true;
  }

  send(res, 404, { error: "recon: неизвестный маршрут" });
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Чистый diff между снимками (та же логика, что в mock-режиме дашборда)
// ─────────────────────────────────────────────────────────────────────────────
function openPortSet(m) {
  const s = new Set();
  for (const o of m.live?.open || []) s.add(o.port);
  if (!s.size) for (const svc of m.censys?.services || []) s.add(svc.port);
  return s;
}
function tlsFpMap(m) {
  const x = new Map();
  for (const o of m.live?.open || []) if (o.tls?.ok && o.tls.fp256) x.set(o.port, o.tls.fp256);
  return x;
}
function findingKeySet(m) {
  const x = new Map();
  for (const f of m.findings || []) x.set(f.sev + "|" + f.msg, f);
  return x;
}
export function diffSnapshots(prev, cur) {
  const ch = [];
  const pP = openPortSet(prev), cP = openPortSet(cur);
  for (const p of cP) if (!pP.has(p)) ch.push({ type: "port_open", sev: "WARN", text: `Открылся порт :${p}` });
  for (const p of pP) if (!cP.has(p)) ch.push({ type: "port_close", sev: "OK", text: `Закрылся порт :${p}` });
  const pFp = tlsFpMap(prev), cFp = tlsFpMap(cur);
  for (const [port, fp] of cFp) { const o = pFp.get(port); if (o && o !== fp)
    ch.push({ type: "cert_change", sev: "WARN", text: `Сменился TLS-сертификат на :${port}` }); }
  const pF = findingKeySet(prev), cF = findingKeySet(cur);
  for (const [k, f] of cF) if (!pF.has(k)) ch.push({ type: "finding_new", sev: f.sev, text: `Новая находка: ${f.msg}` });
  for (const [k, f] of pF) if (!cF.has(k)) ch.push({ type: "finding_gone", sev: "OK", text: `Устранено: ${f.msg}` });
  const pL = new Set(prev.censys?.labels || []), cL = new Set(cur.censys?.labels || []);
  for (const l of cL) if (!pL.has(l)) ch.push({ type: "label_add", sev: "WARN", text: `Censys добавил лейбл "${l}"` });
  for (const l of pL) if (!cL.has(l)) ch.push({ type: "label_del", sev: "OK", text: `Censys снял лейбл "${l}"` });
  const order = { CRIT: 0, HIGH: 1, WARN: 2, INFO: 3, OK: 4 };
  ch.sort((a, b) => (order[a.sev] ?? 9) - (order[b.sev] ?? 9));
  return ch;
}
