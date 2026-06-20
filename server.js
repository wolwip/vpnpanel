import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import net from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = Number(process.env.PORT || 3000);
const DATA_DIR  = process.env.DATA_DIR  || path.join(__dirname, "data");
const DB_FILE   = path.join(DATA_DIR, "vpnpanel.sqlite");
const TG_TOKEN  = process.env.TG_TOKEN  || "";
const TG_CHAT   = process.env.TG_CHAT   || "";
const MONITOR_INTERVAL = Number(process.env.MONITOR_INTERVAL || 5) * 60 * 1000;
const MONITOR_TIMEOUT  = Number(process.env.MONITOR_TIMEOUT  || 3000);
const PASS_FILE = path.join(DATA_DIR, "password.txt");
const DEFAULT_PASS = process.env.ADMIN_PASSWORD || "changeme";

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ─── Пароль ────────────────────────────────────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(":");
    return crypto.timingSafeEqual(
      Buffer.from(crypto.scryptSync(password, salt, 64).toString("hex")),
      Buffer.from(hash)
    );
  } catch { return false; }
}
function getPasswordHash() {
  try { return readFileSync(PASS_FILE, "utf8").trim(); } catch { return ""; }
}
if (!existsSync(PASS_FILE)) {
  writeFileSync(PASS_FILE, hashPassword(DEFAULT_PASS));
  console.log(`[init] Password file created. Default password: ${DEFAULT_PASS}`);
}

// ─── БД ────────────────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS providers (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    url        TEXT NOT NULL DEFAULT '',
    login_url  TEXT NOT NULL DEFAULT '',
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS assets (
    id               TEXT PRIMARY KEY,
    type             TEXT NOT NULL,
    name             TEXT NOT NULL,
    provider_id      TEXT NOT NULL DEFAULT '',
    ip               TEXT NOT NULL DEFAULT '',
    domain           TEXT NOT NULL DEFAULT '',
    country          TEXT NOT NULL DEFAULT '',
    expires_at       TEXT NOT NULL DEFAULT '',
    note             TEXT NOT NULL DEFAULT '',
    monitor_port     INTEGER NOT NULL DEFAULT 22,
    monitor_enabled  INTEGER NOT NULL DEFAULT 1,
    sort_order       INTEGER NOT NULL DEFAULT 0,
    inactive         INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS payments (
    id         TEXT PRIMARY KEY,
    asset_id   TEXT NOT NULL,
    amount     REAL NOT NULL DEFAULT 0,
    currency   TEXT NOT NULL DEFAULT 'USDT',
    paid_at    TEXT NOT NULL DEFAULT '',
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS monitor_results (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id   TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    status     TEXT NOT NULL,
    latency_ms INTEGER,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_monitor ON monitor_results(asset_id, checked_at DESC);
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );
`);

// ─── Утилиты ───────────────────────────────────────────────────────────────────
const uuid = () => crypto.randomUUID();
const now  = () => new Date().toISOString();

function isAuth(req) {
  const cookie = req.headers.cookie || "";
  const token  = cookie.split(";").map(s => s.trim()).find(s => s.startsWith("token="))?.slice(6);
  if (!token) return false;
  return !!db.prepare("SELECT 1 FROM sessions WHERE token=?").get(token);
}

async function readBody(req) {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", c => buf += c);
    req.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

function send(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ─── Мониторинг ────────────────────────────────────────────────────────────────
function tcpCheck(host, port, timeout) {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock  = new net.Socket();
    sock.setTimeout(timeout);
    sock.on("connect", () => { sock.destroy(); resolve({ status: "up",      latency: Date.now() - start }); });
    sock.on("timeout", () => { sock.destroy(); resolve({ status: "timeout", latency: null }); });
    sock.on("error",   () => {                resolve({ status: "down",    latency: null }); });
    sock.connect(port, host);
  });
}

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML" }),
    });
  } catch (e) { console.warn("[telegram]", e.message); }
}

async function runMonitor() {
  const servers = db.prepare(`
    SELECT id, name, ip, monitor_port AS port
    FROM assets
    WHERE type='server' AND inactive=0 AND monitor_enabled=1 AND ip!='' AND ip IS NOT NULL
  `).all();

  for (const srv of servers) {
    let result;
    try { result = await tcpCheck(srv.ip, srv.port || 22, MONITOR_TIMEOUT); }
    catch { result = { status: "down", latency: null }; }

    const prev = db.prepare(
      "SELECT status FROM monitor_results WHERE asset_id=? ORDER BY checked_at DESC LIMIT 1"
    ).get(srv.id);

    db.prepare(
      "INSERT INTO monitor_results (asset_id, checked_at, status, latency_ms) VALUES (?,?,?,?)"
    ).run(srv.id, now(), result.status, result.latency);

    // Чистим историю старше 48 ч
    db.prepare(
      "DELETE FROM monitor_results WHERE asset_id=? AND checked_at < datetime('now','-48 hours')"
    ).run(srv.id);

    // Telegram только при смене статуса
    if (prev && prev.status !== result.status) {
      const emoji = result.status === "up" ? "✅" : "🔴";
      const latStr = result.latency ? `\nЗадержка: ${result.latency} мс` : "";
      sendTelegram(
        `${emoji} <b>${srv.name}</b> (${srv.ip}:${srv.port})\n` +
        `Статус: <b>${result.status.toUpperCase()}</b>${latStr}`
      );
    }
  }
}

// Первая проверка через 10 сек после старта, затем по интервалу
setTimeout(() => { runMonitor(); setInterval(runMonitor, MONITOR_INTERVAL); }, 10_000);

// ─── Уведомления об истечении ──────────────────────────────────────────────────
async function runExpiryNotifications() {
  const items = db.prepare(`
    SELECT id, name, type, expires_at FROM assets
    WHERE inactive=0 AND expires_at!='' AND expires_at IS NOT NULL
    AND expires_at <= datetime('now', '+30 days')
    AND expires_at > datetime('now')
    ORDER BY expires_at ASC
  `).all();

  for (const item of items) {
    const diff = Math.ceil((new Date(item.expires_at) - new Date()) / 86400000);
    const eventId = "expiry_" + item.id + "_" + diff;
    const already = db.prepare("SELECT 1 FROM sessions WHERE token=?").get(eventId);
    if (already) continue;

    const types = { server:"Сервер", domain:"Домен", cert:"Сертификат", vpn:"VPN", other:"Прочее" };
    const emoji = diff <= 3 ? "🔴" : diff <= 7 ? "🟠" : "🟡";
    await sendTelegram(
      `${emoji} <b>Истекает через ${diff} дн.</b>
` +
      `${types[item.type]||item.type}: <b>${item.name}</b>
` +
      `Дата: ${new Date(item.expires_at).toLocaleDateString("ru")}`
    );
    // Помечаем что уведомление отправлено (храним в sessions как event-маркер)
    db.prepare("INSERT OR IGNORE INTO sessions (token, created_at) VALUES (?,?)").run(eventId, now());
  }
}
// Проверка истечений раз в 12 часов
setTimeout(() => { runExpiryNotifications(); setInterval(runExpiryNotifications, 12 * 60 * 60 * 1000); }, 15_000);

// ─── HTTP сервер ───────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url    = new URL(req.url, "http://localhost");
  const method = req.method;
  const p      = url.pathname;

  if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Статика
  if (p === "/" || p === "/index.html") {
    try {
      const html = readFileSync(path.join(__dirname, "index.html"));
      const len = html.length;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": len });
      res.end(html);
    } catch { res.writeHead(404); res.end("Not found"); }
    return;
  }

  // ── Публичные API ──────────────────────────────────────────────────────────
  if (p === "/api/auth/check" && method === "GET") {
    send(res, 200, { ok: isAuth(req) }); return;
  }

  if (p === "/api/login" && method === "POST") {
    const { password } = await readBody(req);
    const hash = getPasswordHash();
    if (hash && verifyPassword(password, hash)) {
      const token = crypto.randomBytes(32).toString("hex");
      db.prepare("INSERT INTO sessions (token, created_at) VALUES (?,?)").run(token, now());
      res.writeHead(200, {
        "Set-Cookie":   `token=${token}; HttpOnly; Path=/; Max-Age=2592000`,
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ ok: true }));
    } else {
      send(res, 401, { error: "Неверный пароль" });
    }
    return;
  }

  if (p === "/api/logout" && method === "POST") {
    const cookie = req.headers.cookie || "";
    const token  = cookie.split(";").map(s => s.trim()).find(s => s.startsWith("token="))?.slice(6);
    if (token) db.prepare("DELETE FROM sessions WHERE token=?").run(token);
    res.writeHead(200, { "Set-Cookie": "token=; HttpOnly; Path=/; Max-Age=0", "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Защищённые API ─────────────────────────────────────────────────────────
  if (!isAuth(req)) { send(res, 401, { error: "Не авторизован" }); return; }

  // Смена пароля
  if (p === "/api/password" && method === "POST") {
    const { current, newPassword } = await readBody(req);
    if (!verifyPassword(current, getPasswordHash())) {
      send(res, 400, { error: "Неверный текущий пароль" }); return;
    }
    if (!newPassword || newPassword.length < 6) {
      send(res, 400, { error: "Минимум 6 символов" }); return;
    }
    writeFileSync(PASS_FILE, hashPassword(newPassword));
    send(res, 200, { ok: true }); return;
  }

  // ── Провайдеры ─────────────────────────────────────────────────────────────
  if (p === "/api/providers") {
    if (method === "GET") {
      send(res, 200, db.prepare("SELECT * FROM providers ORDER BY name ASC").all()); return;
    }
    if (method === "POST") {
      const b = await readBody(req);
      if (!b.name) { send(res, 400, { error: "name required" }); return; }
      const id = uuid();
      db.prepare("INSERT INTO providers (id,name,url,login_url,note,created_at) VALUES (?,?,?,?,?,?)")
        .run(id, b.name.trim(), b.url||"", b.login_url||"", b.note||"", now());
      send(res, 201, db.prepare("SELECT * FROM providers WHERE id=?").get(id)); return;
    }
  }

  const provM = p.match(/^\/api\/providers\/([^/]+)$/);
  if (provM) {
    const id = provM[1];
    if (method === "PUT") {
      const b = await readBody(req);
      db.prepare("UPDATE providers SET name=?,url=?,login_url=?,note=? WHERE id=?")
        .run(b.name||"", b.url||"", b.login_url||"", b.note||"", id);
      send(res, 200, db.prepare("SELECT * FROM providers WHERE id=?").get(id)); return;
    }
    if (method === "DELETE") {
      db.prepare("DELETE FROM providers WHERE id=?").run(id);
      send(res, 200, { ok: true }); return;
    }
  }

  // ── Активы ─────────────────────────────────────────────────────────────────
  if (p === "/api/assets" && method === "GET") {
    const list = db.prepare(
      "SELECT * FROM assets ORDER BY type ASC, sort_order ASC, created_at DESC"
    ).all();
    const pays = db.prepare("SELECT * FROM payments ORDER BY paid_at DESC").all();
    const monRows = db.prepare(`
      SELECT m.asset_id, m.status, m.latency_ms, m.checked_at
      FROM monitor_results m
      INNER JOIN (
        SELECT asset_id, MAX(checked_at) AS mc
        FROM monitor_results GROUP BY asset_id
      ) t ON m.asset_id=t.asset_id AND m.checked_at=t.mc
    `).all();

    const payMap = {};
    for (const py of pays) {
      if (!payMap[py.asset_id]) payMap[py.asset_id] = [];
      payMap[py.asset_id].push(py);
    }
    const monMap = Object.fromEntries(monRows.map(r => [r.asset_id, r]));

    send(res, 200, list.map(a => ({
      ...a,
      inactive:        Boolean(a.inactive),
      monitor_enabled: Boolean(a.monitor_enabled),
      payments:        payMap[a.id] || [],
      monitor:         monMap[a.id] || null,
    })));
    return;
  }

  if (p === "/api/assets" && method === "POST") {
    const b = await readBody(req);
    if (!b.name || !b.type) { send(res, 400, { error: "name and type required" }); return; }
    const id = uuid(); const ts = now();
    db.prepare(`INSERT INTO assets
      (id,type,name,provider_id,ip,domain,country,expires_at,note,monitor_port,monitor_enabled,sort_order,inactive,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, b.type, b.name.trim(), b.provider_id||"", b.ip||"", b.domain||"",
           b.country||"", b.expires_at||"", b.note||"",
           b.monitor_port||22, b.monitor_enabled!==false?1:0, b.sort_order||0, 0, ts, ts);
    send(res, 201, db.prepare("SELECT * FROM assets WHERE id=?").get(id)); return;
  }

  const assetM = p.match(/^\/api\/assets\/([^/]+)$/);
  if (assetM) {
    const id = assetM[1];
    if (method === "PUT") {
      const b = await readBody(req);
      db.prepare(`UPDATE assets SET
        type=?,name=?,provider_id=?,ip=?,domain=?,country=?,expires_at=?,note=?,
        monitor_port=?,monitor_enabled=?,sort_order=?,inactive=?,updated_at=?
        WHERE id=?`)
        .run(b.type, b.name||"", b.provider_id||"", b.ip||"", b.domain||"",
             b.country||"", b.expires_at||"", b.note||"",
             b.monitor_port||22, b.monitor_enabled!==false?1:0,
             b.sort_order||0, b.inactive?1:0, now(), id);
      send(res, 200, db.prepare("SELECT * FROM assets WHERE id=?").get(id)); return;
    }
    if (method === "DELETE") {
      db.prepare("DELETE FROM assets WHERE id=?").run(id);
      send(res, 200, { ok: true }); return;
    }
  }

  // ── Платежи ────────────────────────────────────────────────────────────────
  if (p === "/api/payments" && method === "POST") {
    const b = await readBody(req);
    if (!b.asset_id || !b.amount) { send(res, 400, { error: "asset_id and amount required" }); return; }
    const id = uuid();
    db.prepare("INSERT INTO payments (id,asset_id,amount,currency,paid_at,note,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, b.asset_id, Number(b.amount), b.currency||"USDT", b.paid_at||now(), b.note||"", now());
    // Автосдвиг expires_at если передан период
    if (b.shift_months || b.shift_years) {
      const asset = db.prepare("SELECT expires_at FROM assets WHERE id=?").get(b.asset_id);
      const base = asset?.expires_at ? new Date(asset.expires_at) : new Date();
      if (b.shift_months) base.setMonth(base.getMonth() + Number(b.shift_months));
      if (b.shift_years)  base.setFullYear(base.getFullYear() + Number(b.shift_years));
      db.prepare("UPDATE assets SET expires_at=?, updated_at=? WHERE id=?")
        .run(base.toISOString(), now(), b.asset_id);
    }
    send(res, 201, db.prepare("SELECT * FROM payments WHERE id=?").get(id)); return;
  }

  const payM = p.match(/^\/api\/payments\/([^/]+)$/);
  if (payM && method === "DELETE") {
    db.prepare("DELETE FROM payments WHERE id=?").run(payM[1]);
    send(res, 200, { ok: true }); return;
  }

  // ── Мониторинг API ─────────────────────────────────────────────────────────
  if (p === "/api/monitor/run" && method === "POST") {
    runMonitor().catch(e => console.warn("[monitor]", e.message));
    send(res, 200, { ok: true }); return;
  }

  const monHistM = p.match(/^\/api\/monitor\/([^/]+)$/);
  if (monHistM && method === "GET") {
    const rows = db.prepare(`
      SELECT checked_at, status, latency_ms
      FROM monitor_results WHERE asset_id=?
      ORDER BY checked_at DESC LIMIT 48
    `).all(monHistM[1]);
    send(res, 200, rows); return;
  }

  // ── Статистика ─────────────────────────────────────────────────────────────
  if (p === "/api/stats" && method === "GET") {
    const totalAssets  = db.prepare("SELECT COUNT(*) AS c FROM assets WHERE inactive=0").get().c;
    const byType       = db.prepare("SELECT type, COUNT(*) AS c FROM assets WHERE inactive=0 GROUP BY type").all();
    const byCurrency   = db.prepare("SELECT currency, SUM(amount) AS total, COUNT(*) AS cnt FROM payments GROUP BY currency ORDER BY total DESC").all();
    const expiringSoon = db.prepare(`
      SELECT id, name, type, expires_at FROM assets
      WHERE inactive=0 AND expires_at!='' AND expires_at <= datetime('now','+30 days')
      ORDER BY expires_at ASC LIMIT 20
    `).all();
    const monitorDown  = db.prepare(`
      SELECT a.id, a.name, a.ip, m.status, m.latency_ms, m.checked_at
      FROM assets a
      JOIN monitor_results m ON m.id = (
        SELECT id FROM monitor_results WHERE asset_id=a.id ORDER BY checked_at DESC LIMIT 1
      )
      WHERE a.type='server' AND a.inactive=0 AND m.status != 'up'
    `).all();
    send(res, 200, { totalAssets, byType, byCurrency, expiringSoon, monitorDown }); return;
  }

  // ── Экспорт CSV ───────────────────────────────────────────────────────────
  if (p === "/api/export/assets" && method === "GET") {
    const list = db.prepare("SELECT * FROM assets WHERE inactive=0 ORDER BY type,name").all();
    const provs = db.prepare("SELECT * FROM providers").all();
    const provMap = Object.fromEntries(provs.map(p => [p.id, p.name]));
    const rows = [["Тип","Название","IP","Домен","Страна","Провайдер","Истекает","Заметка"]];
    for (const a of list) {
      rows.push([a.type, a.name, a.ip, a.domain, a.country, provMap[a.provider_id]||"", a.expires_at, a.note]);
    }
    const csv = rows.map(r => r.map(v => '"'+(v||"").replace(/"/g,'""')+'"').join(",")).join("\n");
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=assets.csv" });
    res.end("\uFEFF" + csv); return;
  }

  if (p === "/api/export/payments" && method === "GET") {
    const assets2 = db.prepare("SELECT id,name,type FROM assets").all();
    const aMap = Object.fromEntries(assets2.map(a => [a.id, a]));
    const pays = db.prepare("SELECT * FROM payments ORDER BY paid_at DESC").all();
    const rows = [["Актив","Тип","Сумма","Валюта","Дата","Заметка"]];
    for (const p of pays) {
      const a = aMap[p.asset_id] || {};
      rows.push([a.name||"", a.type||"", p.amount, p.currency, p.paid_at, p.note]);
    }
    const csv = rows.map(r => r.map(v => '"'+(v||"").replace(/"/g,'""')+'"').join(",")).join("\n");
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=payments.csv" });
    res.end("\uFEFF" + csv); return;
  }

  send(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[vpnpanel] http://0.0.0.0:${PORT}`);
  console.log(`[vpnpanel] data: ${DATA_DIR}`);
  console.log(`[vpnpanel] monitor interval: ${MONITOR_INTERVAL/60000} min`);
  if (TG_TOKEN) console.log("[vpnpanel] Telegram: enabled");
});
