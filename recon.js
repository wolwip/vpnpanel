#!/usr/bin/env node
/**
 * recon.js — гибридная разведка хоста: Censys Platform API + активный локальный доскан.
 * (полное описание опций — в конце файла у main / в README проекта)
 * ESM-модуль. Node >= 20 (нужен глобальный fetch). Одновременно CLI и модуль.
 */

import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import http from 'node:http';
import { promises as dns } from 'node:dns';
import { pathToFileURL } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────────
// Наборы портов
// ─────────────────────────────────────────────────────────────────────────────
const PORTS_DEFAULT = [22, 80, 443, 8080, 8443];
// Порты, релевантные твоему стеку: панели 3x-ui, cf-порты, gost, метрики telemt, ss.
const PORTS_STACK = [
  21, 22, 25, 53, 80, 110, 143, 443, 465, 587, 993, 995,
  1080,   // gost SOCKS5 — НЕ должен торчать наружу
  2053, 2083, 2087, 2096, 8880, // Cloudflare-совместимые порты
  3128,   // http-proxy
  3306, 5432, 6379, 27017,      // БД — тревога, если открыты
  8080, 8443, 8888,
  9090, 9091,                    // 9091 — метрики telemt, НЕ наружу
  10085, 10086,                  // xray api / stats (по умолч. локально)
  54321,                         // дефолтный порт панели 3x-ui
  8388,                          // shadowsocks
];

// Порты, где по умолчанию говорим по TLS
const TLS_PORTS = new Set([443, 465, 636, 853, 993, 995, 2053, 2083, 2087, 2096, 8443, 8880, 54321]);
// Порты, где пробуем HTTP(S)
const HTTP_PORTS = new Set([80, 443, 2053, 2083, 2087, 2096, 8080, 8443, 8880, 8888, 9090, 9091, 54321]);

// ─────────────────────────────────────────────────────────────────────────────
// ANSI / рендер-утилиты
// ─────────────────────────────────────────────────────────────────────────────
function makeStyler(enabled) {
  const c = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return {
    bold: c('1'), dim: c('2'), red: c('31'), green: c('32'), yellow: c('33'),
    blue: c('34'), magenta: c('35'), cyan: c('36'), grey: c('90'),
    bgRed: c('41;97'), bgYel: c('43;30'), bgGrn: c('42;30'),
  };
}
// длина строки без ANSI и с грубым учётом ширины (кириллица = 1 колонка в моно-терминале)
function visLen(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, '').length; }
function pad(s, n) { const l = visLen(s); return l >= n ? s : s + ' '.repeat(n - l); }
function trunc(s, n) {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…';
}
// ANSI-безопасная обрезка до n видимых колонок (не рвёт escape-последовательности)
function ansiTrunc(s, n) {
  s = String(s ?? '');
  if (visLen(s) <= n) return s;
  let out = '', vis = 0, i = 0;
  while (i < s.length && vis < n - 1) {
    if (s[i] === '\x1b') {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    out += s[i]; vis++; i++;
  }
  return out + '…' + (/\x1b\[/.test(out) ? '\x1b[0m' : '');
}
function box(title, lines, S, width = 78) {
  const top = `┌─ ${S.bold(title)} ` + '─'.repeat(Math.max(0, width - visLen(title) - 4)) + '┐';
  const bot = '└' + '─'.repeat(width) + '┘';
  const body = lines.map((l) => '│ ' + pad(ansiTrunc(l, width - 3), width - 3) + '│');
  return [top, ...body, bot].join('\n');
}
function kv(k, v, S, kw = 16) {
  return S.grey(pad(k, kw)) + (v ?? S.dim('—'));
}
function ago(ts) {
  if (!ts) return null;
  const d = new Date(ts); if (isNaN(d)) return null;
  const sec = (Date.now() - d.getTime()) / 1000;
  if (sec < 3600) return `${Math.round(sec / 60)} мин назад`;
  if (sec < 86400) return `${Math.round(sec / 3600)} ч назад`;
  return `${Math.round(sec / 86400)} дн назад`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Censys Platform API
// ─────────────────────────────────────────────────────────────────────────────
async function fetchCensysHost(ip, { token, orgId, timeout = 8000 } = {}) {
  if (!token) throw new Error('нет CENSYS_PLATFORM_TOKEN');
  const q = orgId ? `?organization_id=${encodeURIComponent(orgId)}` : '';
  const url = `https://api.platform.censys.io/v3/global/asset/host/${encodeURIComponent(ip)}${q}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.censys.api.v3.host.v1+json',
        'User-Agent': 'recon.js/1.0',
      },
      signal: ctrl.signal,
    });
    if (res.status === 404) return { notFound: true };
    if (res.status === 401) throw new Error('Censys 401 — неверный/просроченный токен');
    if (res.status === 403) throw new Error('Censys 403 — нет прав (или эндпоинт вне тарифа)');
    if (res.status === 429) throw new Error('Censys 429 — превышен лимит запросов');
    if (!res.ok) throw new Error(`Censys HTTP ${res.status}: ${trunc(await res.text(), 200)}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Приводим ответ Censys к нашей модели. Envelope у Platform может отличаться —
// разбираем защитно (result.resource | result | корень).
function normalizeCensys(json) {
  if (!json || json.notFound) return { present: false, services: [] };
  const r = json.result ?? json;
  const h = r.resource ?? r.host ?? r;
  const services = (h.services || []).map((s) => {
    const sw = (s.software || s.softwares || [])
      .map((x) => [x.product, x.version].filter(Boolean).join(' '))
      .filter(Boolean);
    const certSha =
      s.tls?.certificates?.leaf_data?.fingerprint ||
      s.tls?.certificate ||
      s.certificate || null;
    return {
      port: s.port,
      transport: (s.transport_protocol || s.transport || 'TCP').toUpperCase(),
      name: s.extended_service_name || s.service_name || s.protocol || s._service || '?',
      software: sw,
      banner: s.banner || s.banner_hex || null,
      cert: certSha,
      labels: s.labels || [],
      httpTitle: s.http?.response?.html_title || s.endpoints?.[0]?.http?.html_title || null,
      httpServer:
        s.http?.response?.headers?.Server?.[0] ||
        s.http?.response?.headers?.server?.[0] || null,
    };
  }).sort((a, b) => a.port - b.port);

  const loc = h.location || {};
  const as = h.autonomous_system || h.autonomous_system_v2 || {};
  const rdns =
    h.dns?.reverse_dns?.names?.[0] ||
    h.dns?.names?.[0] ||
    (Array.isArray(h.dns?.reverse_dns) ? h.dns.reverse_dns[0] : null) || null;

  return {
    present: true,
    ip: h.ip,
    lastUpdated: h.last_updated_at || h.last_observed_at || r.last_updated_at || null,
    location: {
      country: loc.country || loc.country_code || null,
      city: loc.city || null,
      coords: loc.coordinates || loc.coordinate || null,
    },
    as: {
      asn: as.asn || null,
      name: as.name || as.description || null,
      prefix: as.bgp_prefix || as.routed_prefix || null,
      cc: as.country_code || as.country || null,
    },
    os: h.operating_system
      ? [h.operating_system.vendor, h.operating_system.product].filter(Boolean).join(' ')
      : null,
    rdns,
    labels: h.labels || [],
    services,
    _raw: json,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Активные пробы (zero-dep)
// ─────────────────────────────────────────────────────────────────────────────
function tcpConnect(host, port, timeout) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (state) => {
      if (done) return; done = true;
      try { sock.destroy(); } catch {}
      resolve({ port, state, latency: Date.now() - started });
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish('open'));
    sock.once('timeout', () => finish('filtered'));
    sock.once('error', (e) => finish(e.code === 'ECONNREFUSED' ? 'closed' : 'filtered'));
    sock.connect(port, host);
  });
}

function tlsProbe(host, port, servername, timeout) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const opts = {
      host, port, servername: servername || undefined,
      rejectUnauthorized: false, ALPNProtocols: ['h2', 'http/1.1'],
      timeout,
    };
    const sock = tls.connect(opts, () => {
      const cert = sock.getPeerCertificate(true) || {};
      const info = {
        ok: true,
        protocol: sock.getProtocol?.() || null,
        alpn: sock.alpnProtocol || null,
        cipher: sock.getCipher?.()?.name || null,
        subject: cert.subject?.CN || null,
        issuer: cert.issuer?.CN || cert.issuer?.O || null,
        san: cert.subjectaltname || null,
        validFrom: cert.valid_from || null,
        validTo: cert.valid_to || null,
        fp256: cert.fingerprint256 ? cert.fingerprint256.replace(/:/g, '').toLowerCase() : null,
        selfSigned: !!cert.subject && !!cert.issuer &&
          JSON.stringify(cert.subject) === JSON.stringify(cert.issuer),
      };
      try { sock.end(); } catch {}
      finish(info);
    });
    sock.setTimeout(timeout);
    sock.once('timeout', () => { try { sock.destroy(); } catch {}; finish({ ok: false, err: 'timeout' }); });
    sock.once('error', (e) => finish({ ok: false, err: e.code || e.message }));
  });
}

function httpProbe(host, port, useTls, servername, timeout) {
  return new Promise((resolve) => {
    const lib = useTls ? https : http;
    const opts = {
      host, port, method: 'GET', path: '/', timeout,
      servername: servername || undefined,
      headers: { 'User-Agent': 'Mozilla/5.0 recon.js', 'Accept': '*/*', 'Connection': 'close' },
      rejectUnauthorized: false,
    };
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = lib.request(opts, (res) => {
      let body = ''; let len = 0;
      res.on('data', (ch) => { if (len < 8192) { body += ch; len += ch.length; } });
      res.on('end', () => {
        const title = (body.match(/<title[^>]*>([^<]{0,120})<\/title>/i) || [])[1] || null;
        finish({
          ok: true,
          status: res.statusCode,
          server: res.headers.server || null,
          location: res.headers.location || null,
          setCookie: (res.headers['set-cookie'] || []).join('; ') || null,
          title: title ? title.trim() : null,
          powered: res.headers['x-powered-by'] || null,
        });
      });
    });
    req.on('timeout', () => { req.destroy(); finish({ ok: false, err: 'timeout' }); });
    req.on('error', (e) => finish({ ok: false, err: e.code || e.message }));
    req.end();
  });
}

// Минимальный SOCKS5-хендшейк: шлём 05 01 00, ждём 05 00 → это открытый SOCKS5.
function socks5Probe(host, port, timeout) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch {}; resolve(v); } };
    sock.setTimeout(timeout);
    sock.once('connect', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
    sock.once('data', (d) => finish(d.length >= 2 && d[0] === 0x05));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

// Прометей-метрики на порту (для detection торчащих метрик telemt на :9091)
function looksLikePrometheus(httpRes) {
  return !!httpRes?.ok && httpRes.status === 200 &&
    (/(^|\n)#\s*(HELP|TYPE)\s/.test(httpRes.title || '') || false);
}

async function scanHostLive(ip, opts) {
  const { ports, timeout = 3000, concurrency = 64, sni = null } = opts;
  // 1) TCP-скан всех портов пулом
  const tcp = await pool(ports, concurrency, (p) => tcpConnect(ip, p, timeout));
  const open = tcp.filter((r) => r.state === 'open');

  // 2) Для открытых — TLS / HTTP / спец-пробы
  const enriched = await pool(open, Math.min(concurrency, 24), async (r) => {
    const p = r.port;
    const out = { ...r };
    const useTls = TLS_PORTS.has(p);
    if (useTls) out.tls = await tlsProbe(ip, p, sni, timeout);
    if (HTTP_PORTS.has(p)) {
      const overTls = useTls || (out.tls && out.tls.ok);
      out.http = await httpProbe(ip, p, overTls, sni, timeout);
      // метрики prometheus по /metrics
      if (p === 9091 || p === 9090 || p === 8080) {
        const m = await httpProbe(ip, p, overTls, sni, timeout, '/metrics').catch(() => null);
        out.metrics = m;
      }
    }
    if (p === 1080 || p === 3128) out.socks5 = await socks5Probe(ip, p, timeout);
    // grab баннера для «говорящих первыми» сервисов (ssh/smtp/ftp)
    if (!useTls && !HTTP_PORTS.has(p)) out.banner = await bannerGrab(ip, p, timeout);
    return out;
  });

  return {
    ip,
    scannedAt: new Date().toISOString(),
    ports: tcp,
    open: enriched.sort((a, b) => a.port - b.port),
  };
}

function bannerGrab(host, port, timeout) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false; let buf = '';
    const finish = () => { if (!done) { done = true; try { sock.destroy(); } catch {}; resolve(buf.trim().slice(0, 120) || null); } };
    sock.setTimeout(timeout);
    sock.once('connect', () => {}); // ждём, вдруг сервис заговорит сам
    sock.on('data', (d) => { buf += d.toString('latin1'); if (buf.length > 200) finish(); });
    sock.once('timeout', finish);
    sock.once('error', finish);
    sock.once('close', finish);
    sock.connect(port, host);
  });
}

// простой пул с ограничением параллелизма
async function pool(items, limit, fn) {
  const res = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      res[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// Слияние + движок находок
// ─────────────────────────────────────────────────────────────────────────────
const KNOWN_DONORS = /(microsoft|windowsupdate|google|gstatic|cloudflare|amazon|akamai|apple|fastly|yahoo|bing)\b/i;

function analyze(model) {
  const f = [];
  const add = (sev, msg, hint) => f.push({ sev, msg, hint });
  const live = model.live;
  const cen = model.censys;

  const openPorts = new Set((live?.open || []).map((o) => o.port));

  for (const o of live?.open || []) {
    const p = o.port;
    // gost / открытый прокси
    if ((p === 1080 || p === 3128) && o.socks5) {
      add('CRIT', `SOCKS5-прокси открыт наружу на :${p}`,
        'gost/SOCKS должен слушать 127.0.0.1 или быть закрыт фаером — иначе открытый релей');
    }
    // метрики prometheus (telemt :9091 и пр.)
    if ((p === 9091 || p === 9090) && o.http?.ok) {
      add('CRIT', `Метрики/статус доступны снаружи на :${p} (HTTP ${o.http.status})`,
        'telemt/xray-метрики наружу не выставляют: bind 127.0.0.1 или ufw deny');
    }
    // БД наружу
    if ([3306, 5432, 6379, 27017].includes(p)) {
      add('CRIT', `СУБД слушает публично на :${p}`, 'закрой фаером, оставь доступ только с доверенных IP');
    }
    // панель 3x-ui
    const t = (o.http?.title || '') + ' ' + (o.http?.setCookie || '');
    if (o.http?.ok && /x-?ui|3x-ui|marz|remnawave|hui/i.test(t)) {
      add('HIGH', `Панель управления открыта на :${p} (${trunc(o.http.title || '?', 40)})`,
        'вынеси панель на localhost + доступ по VLESS/SSH-туннелю или спрячь за нестандартный путь + basic-auth');
    } else if (o.http?.ok && [54321, 2053, 2083, 8443, 8888].includes(p) && o.http.status && o.http.status < 500) {
      add('WARN', `HTTP-сервис отвечает на :${p} (status ${o.http.status}, "${trunc(o.http.title || '', 30)}")`,
        'проверь, не панель ли это и нужен ли порт снаружи');
    }
    // TLS-серт раскрывает реальный домен (важно для REALITY)
    if (o.tls?.ok && o.tls.subject) {
      const onDonor = KNOWN_DONORS.test(o.tls.subject) || KNOWN_DONORS.test(o.tls.san || '');
      const asName = model.censys?.as?.name || '';
      if (p === 443 && onDonor && asName && !KNOWN_DONORS.test(asName)) {
        add('INFO', `:443 отдаёт сертификат "${o.tls.subject}" на хостинге "${trunc(asName, 30)}" — похоже на REALITY-маскировку`,
          'ожидаемо для REALITY: DPI видит валидный TLS донора');
      } else if (p === 443 && o.tls.subject && !onDonor && !o.tls.selfSigned) {
        add('WARN', `:443 отдаёт реальный сертификат CN="${o.tls.subject}" (issuer ${o.tls.issuer || '?'})`,
          'если это REALITY-сервер — он палит реальный домен вместо донора; проверь конфиг dest/serverNames');
      }
    }
    // истёкший серт
    if (o.tls?.ok && o.tls.validTo) {
      const dLeft = (new Date(o.tls.validTo) - Date.now()) / 86400000;
      if (dLeft < 0) add('HIGH', `Сертификат на :${p} истёк (${o.tls.validTo})`, 'обнови до ротации');
      else if (dLeft < 14) add('WARN', `Сертификат на :${p} истекает через ${Math.round(dLeft)} дн`, null);
    }
    // SSH info
    if (p === 22 && o.banner) add('INFO', `SSH: ${trunc(o.banner, 50)}`, null);
  }

  // Диф Censys ↔ live
  if (cen?.present) {
    const cenPorts = new Set(cen.services.map((s) => s.port));
    for (const cp of cenPorts) {
      if (!openPorts.has(cp)) {
        add('INFO', `Censys помнит :${cp} открытым, но сейчас закрыт/фильтруется`,
          'данные Censys устарели, либо порт с тех пор закрыт — это хорошо, если там была панель');
      }
    }
    for (const op of openPorts) {
      if (!cenPorts.has(op)) {
        add('INFO', `:${op} открыт сейчас, но Censys его ещё не индексировал`, null);
      }
    }
    // засветка лейблами Censys
    for (const l of cen.labels || []) {
      if (/login|remote|panel|proxy|vpn|admin/i.test(String(l))) {
        add('WARN', `Censys повесил лейбл "${l}" — хост уже классифицирован как чувствительный`, null);
      }
    }
  }

  const order = { CRIT: 0, HIGH: 1, WARN: 2, INFO: 3 };
  f.sort((a, b) => order[a.sev] - order[b.sev]);
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────
// Рендер карточки
// ─────────────────────────────────────────────────────────────────────────────
function renderCard(model, S) {
  const W = 78;
  const out = [];
  const cen = model.censys;
  const live = model.live;

  // Заголовок
  const head = [];
  head.push(kv('IP', S.bold(model.ip), S));
  if (model.target !== model.ip) head.push(kv('Цель', model.target, S));
  const rdns = cen?.rdns;
  if (rdns) head.push(kv('rDNS', rdns, S));
  if (cen?.present) {
    const loc = [cen.location.city, cen.location.country].filter(Boolean).join(', ');
    if (loc) head.push(kv('Локация', loc, S));
    if (cen.as.asn) head.push(kv('ASN', `AS${cen.as.asn} ${cen.as.name || ''} ${S.grey(cen.as.prefix || '')}`, S));
    if (cen.os) head.push(kv('OS', cen.os, S));
    if (cen.labels?.length) head.push(kv('Лейблы', cen.labels.map((l) => S.yellow(l)).join(' '), S));
    const upd = ago(cen.lastUpdated);
    if (upd) head.push(kv('Censys скан', `${cen.lastUpdated} ${S.grey('(' + upd + ')')}`, S));
  } else if (model.censysError) {
    head.push(kv('Censys', S.red(model.censysError), S));
  } else if (cen && !cen.present) {
    head.push(kv('Censys', S.dim('хост не найден в базе'), S));
  }
  out.push(box(`ХОСТ ${model.ip}`, head, S, W));

  // Таблица сервисов (объединённая: censys ∪ live)
  const rows = mergeServiceRows(model);
  const svcLines = [];
  svcLines.push(
    S.grey(pad('ПОРТ', 7)) + S.grey(pad('СЕРВИС', 20)) +
    S.grey(pad('ПО / TITLE', 30)) + S.grey('ИСТОЧНИК')
  );
  for (const r of rows) {
    const stCol =
      r.live === 'open' ? S.green('●') :
      r.live === 'closed' ? S.red('○') :
      r.live === 'filtered' ? S.yellow('◐') : S.grey('·');
    const portStr = `${stCol} ${r.port}/${(r.transport || 'tcp').toLowerCase()}`;
    const src =
      (r.inCensys ? S.cyan('censys') : '') +
      (r.inCensys && r.inLive ? '+' : '') +
      (r.inLive ? S.green('live') : '');
    svcLines.push(
      pad(portStr, 7 + 10) + pad(trunc(r.name, 18), 20) +
      pad(trunc(r.detail || '', 28), 30) + src
    );
  }
  if (!rows.length) svcLines.push(S.dim('нет открытых портов / данных'));
  out.push(box('СЕРВИСЫ  (● открыт  ○ закрыт  ◐ фильтр)', svcLines, S, W));

  // TLS-детали по живым TLS-портам
  const tlsSvc = (live?.open || []).filter((o) => o.tls?.ok);
  if (tlsSvc.length) {
    const tl = [];
    for (const o of tlsSvc) {
      tl.push(S.bold(`:${o.port}`) + '  ' +
        [o.tls.protocol, o.tls.alpn && `ALPN ${o.tls.alpn}`, o.tls.cipher].filter(Boolean).join('  '));
      tl.push(kv('  CN', o.tls.subject || S.dim('—'), S));
      tl.push(kv('  Issuer', o.tls.issuer || S.dim('—'), S));
      if (o.tls.san) tl.push(kv('  SAN', trunc(o.tls.san, W - 20), S));
      tl.push(kv('  Годен до', o.tls.validTo || S.dim('—'), S));
      tl.push(kv('  FP256', o.tls.fp256 ? S.grey(trunc(o.tls.fp256, 48)) : S.dim('—'), S));
    }
    out.push(box('TLS (живой скан)', tl, S, W));
  }

  // Находки
  if (model.findings.length) {
    const fl = [];
    const badge = { CRIT: S.bgRed(' CRIT '), HIGH: S.red('HIGH'), WARN: S.yellow('WARN'), INFO: S.cyan('INFO') };
    for (const x of model.findings) {
      fl.push(`${pad(badge[x.sev], x.sev === 'CRIT' ? 6 : 4)}  ${x.msg}`);
      if (x.hint) fl.push(S.grey('        ↳ ' + trunc(x.hint, W - 12)));
    }
    out.push(box(`НАХОДКИ (${model.findings.length})`, fl, S, W));
  } else {
    out.push(box('НАХОДКИ', [S.green('✓ ничего критичного не обнаружено')], S, W));
  }

  return out.join('\n');
}

// объединяем сервисы Censys и live в единый список строк
function mergeServiceRows(model) {
  const map = new Map();
  for (const s of model.censys?.services || []) {
    map.set(s.port, {
      port: s.port, transport: s.transport, name: s.name,
      detail: s.software.join(', ') || s.httpTitle || '',
      inCensys: true, inLive: false, live: null,
    });
  }
  for (const r of model.live?.ports || []) {
    const cur = map.get(r.port) || { port: r.port, transport: 'TCP', name: '', detail: '', inCensys: false };
    cur.live = r.state;
    if (r.state === 'open') cur.inLive = true;
    map.set(r.port, cur);
  }
  for (const o of model.live?.open || []) {
    const cur = map.get(o.port);
    if (!cur) continue;
    if (!cur.name || cur.name === '?') {
      cur.name = o.http?.ok ? 'HTTP' : (o.tls?.ok ? 'TLS' : (o.banner ? 'BANNER' : 'open'));
    }
    if (!cur.detail) {
      cur.detail = o.http?.title || o.http?.server || o.tls?.subject || o.banner || '';
    }
  }
  return [...map.values()].sort((a, b) => a.port - b.port);
}

// ─────────────────────────────────────────────────────────────────────────────
// Оркестратор (экспортируемая функция)
// ─────────────────────────────────────────────────────────────────────────────
async function resolveTargets(target) {
  if (net.isIP(target)) return { ip: target, domain: null };
  const clean = target.replace(/^https?:\/\//, '').replace(/\/.*$/, '').split(':')[0];
  const a = await dns.resolve4(clean).catch(() => []);
  const aaaa = a.length ? [] : await dns.resolve6(clean).catch(() => []);
  const ip = a[0] || aaaa[0];
  if (!ip) throw new Error(`не резолвится: ${target}`);
  return { ip, domain: clean };
}

async function reconHost(target, cfg = {}) {
  const {
    token = process.env.CENSYS_PLATFORM_TOKEN,
    orgId = process.env.CENSYS_PLATFORM_ORGID,
    ports = PORTS_STACK,
    timeout = 3000,
    concurrency = 64,
    doCensys = true,
    doActive = true,
    sni = null,
    color = false,
  } = cfg;

  const { ip, domain } = await resolveTargets(target);
  const model = { target, ip, domain, censys: null, censysError: null, live: null, findings: [] };

  // параллельно: Censys API + активный скан
  const jobs = [];
  if (doCensys && token) {
    jobs.push(
      fetchCensysHost(ip, { token, orgId })
        .then((j) => { model.censys = normalizeCensys(j); })
        .catch((e) => { model.censysError = e.message; model.censys = { present: false, services: [] }; })
    );
  } else if (doCensys && !token) {
    model.censysError = 'нет токена (CENSYS_PLATFORM_TOKEN)';
    model.censys = { present: false, services: [] };
  }
  if (doActive) {
    jobs.push(
      scanHostLive(ip, { ports, timeout, concurrency, sni: sni || domain })
        .then((l) => { model.live = l; })
    );
  }
  await Promise.all(jobs);

  model.findings = analyze(model);
  model.worstSev = model.findings[0]?.sev || null;
  model.card = (colorOn = color) => renderCard(model, makeStyler(colorOn));
  return model;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────
function parseArgv(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--ports') a.ports = argv[++i].split(',').map(Number).filter(Boolean);
    else if (t === '--top') a.top = true;
    else if (t === '--sni') a.sni = argv[++i];
    else if (t === '--timeout') a.timeout = Number(argv[++i]);
    else if (t === '--concurrency') a.concurrency = Number(argv[++i]);
    else if (t === '--no-censys') a.noCensys = true;
    else if (t === '--no-active') a.noActive = true;
    else if (t === '--json') a.json = true;
    else if (t === '--no-color') a.noColor = true;
    else a._.push(t);
  }
  return a;
}

async function main() {
  const a = parseArgv(process.argv.slice(2));
  const target = a._[0];
  if (!target) {
    console.error('Использование: CENSYS_PLATFORM_TOKEN=... node recon.js <ip|домен> [--top] [--json] [--ports 22,443] [--no-censys] [--no-active]');
    process.exit(64);
  }
  const color = process.stdout.isTTY && !a.noColor;
  let model;
  try {
    model = await reconHost(target, {
      ports: a.ports || (a.top ? PORTS_STACK : PORTS_DEFAULT),
      timeout: a.timeout || 3000,
      concurrency: a.concurrency || 64,
      doCensys: !a.noCensys,
      doActive: !a.noActive,
      sni: a.sni,
      color,
    });
  } catch (e) {
    console.error('Ошибка:', e.message);
    process.exit(70);
  }

  if (a.json) {
    // для vpnpanel: чистый JSON без функций
    const { card, ...clean } = model;
    if (clean.censys) delete clean.censys._raw;
    console.log(JSON.stringify(clean, null, 2));
  } else {
    console.log(model.card(color));
  }

  const code = model.worstSev === 'CRIT' ? 2 : (model.worstSev === 'HIGH' || model.worstSev === 'WARN') ? 1 : 0;
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export { reconHost, scanHostLive, fetchCensysHost, normalizeCensys, analyze, PORTS_STACK, PORTS_DEFAULT };
