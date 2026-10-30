// Cloudflare Worker «wp» – Messwerte der Buderus-Wärmepumpe für dom.dombuzz.ch/wp und klima.dombuzz.ch
//
// Holt alle 5 Minuten Temperaturen und Energiezähler aus der Buderus-Cloud (PointT-API, inoffiziell)
// und speichert sie in einer D1-Datenbank.
//
// Einrichtung im Cloudflare-Dashboard:
// 1. Storage & Databases → D1 → Create → Datenbank «wp» anlegen (Tabellen legt der Worker selbst an)
// 2. Workers & Pages → Create → Worker «wp» → diesen Code einfügen → Deploy
// 3. Worker → Settings → Bindings → D1 Database: Variable «DB», Datenbank «wp»
// 4. Worker → Settings → Variables and Secrets → Secret «ADMIN» (frei gewähltes Passwort für die Einrichtung)
// 5. Worker → Settings → Trigger Events → Cron Trigger «*/5 * * * *»
// 6. https://wp.<konto>.workers.dev/setup öffnen und die Anmeldung bei SingleKey ID einmalig durchführen
//
// Endpunkte (lesend, ohne Passwort):
//   /data?range=24h|7d|30d|365d   Verlauf und aktuelle Werte für das Dashboard
//   /klima?range=…                Aussentemperatur im Format des Klima-Dashboards
//   /status                       letzter Abruf, Fehler

const ORIGINS = ['https://dom.dombuzz.ch', 'https://klima.dombuzz.ch'];
const API = 'https://pointt-api.bosch-thermotechnology.com/pointt-api/api/v1';
const AUTH = 'https://singlekey-id.com/auth/connect/authorize';
const TOKEN = 'https://singlekey-id.com/auth/connect/token';
const CLIENT_ID = '762162C0-FA2D-4540-AE66-6489F189FADC';
const REDIRECT = 'com.buderus.tt.dashtt://app/login';
const SCOPES = 'openid email profile offline_access pointt.gateway.claiming pointt.gateway.removal pointt.gateway.list ' +
  'pointt.gateway.users pointt.gateway.resource.dashapp pointt.castt.flow.token-exchange bacon hcc.tariff.read';
const UA = 'DashApp/3.7.0 (iOS-Release)';
const TZ = 'Europe/Zurich';

// Ressource → Spalte. Temperaturen als Einzelwert, Energie als Sammelwert (kWh, kumuliert).
const PATHS = {
  '/system/sensors/temperatures/outdoor_t1': 'out',
  '/heatSources/actualSupplyTemperature': 'sup',
  '/heatSources/returnTemperature': 'ret',
  '/dhwCircuits/dhw1/actualTemp': 'dhw',
  '/heatSources/systemPressure': 'pres',
  '/heatSources/actualModulation': 'modu',
  '/heatSources/compressor/status': 'cmp',
  '/heatSources/emon/totalConsumption': 'tot',
  '/heatSources/emon/chConsumption': 'ch',
  '/heatSources/emon/dhwConsumption': 'dhwe',
};
const COLS = ['out', 'sup', 'ret', 'dhw', 'pres', 'modu', 'cmp',
  'el', 'comp', 'eh', 'heat', 'ch_el', 'ch_heat', 'dhw_el', 'dhw_heat'];
const BIN = { '24h': 300, '7d': 1800, '30d': 10800, '365d': 86400 };
const SPAN = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400, '365d': 365 * 86400 };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin',
    };
    const json = (body, status = 200, cache = 'no-store') => new Response(JSON.stringify(body),
      { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': cache } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      await schema(env);
      if (url.pathname === '/setup') return await setup(req, env, url);
      if (url.pathname === '/status') return json(await status(env));
      if (url.pathname === '/data') return json(await data(env, range(url)), 200, 'max-age=60');
      if (url.pathname === '/klima') return json(await klima(env, range(url)), 200, 'max-age=60');
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(poll(env).catch(e => kvSet(env, 'last_error', JSON.stringify({ ts: now(), msg: String(e.message || e) }))));
  },
};

/* ---------- Datenbank ---------- */
let ready = false;
async function schema(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS r (ts INTEGER PRIMARY KEY, ${COLS.map(c => c + (c === 'cmp' ? ' TEXT' : ' REAL')).join(', ')})`),
  ]);
  ready = true;
}
const now = () => Math.floor(Date.now() / 1000);
const kvGet = async (env, k) => (await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first())?.v ?? null;
const kvSet = (env, k, v) => env.DB.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, v).run();
const kvDel = (env, k) => env.DB.prepare('DELETE FROM kv WHERE k = ?').bind(k).run();

/* ---------- Anmeldung (OAuth mit PKCE, SingleKey ID) ---------- */
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = n => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function tokenRequest(env, body) {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'User-Agent': UA },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token ${res.status}: ${text.slice(0, 200)}`);
  const t = JSON.parse(text);
  if (!t.access_token) throw new Error('Token-Antwort ohne access_token');
  await kvSet(env, 'access', JSON.stringify({ token: t.access_token, exp: now() + (t.expires_in || 3600) }));
  if (t.refresh_token) await kvSet(env, 'refresh', t.refresh_token);   // Refresh-Token rotiert bei jeder Erneuerung
  return t.access_token;
}

async function accessToken(env) {
  const a = JSON.parse(await kvGet(env, 'access') || 'null');
  if (a && a.exp > now() + 120) return a.token;
  const refresh = await kvGet(env, 'refresh');
  if (!refresh) throw new Error('Nicht angemeldet: /setup öffnen');
  return tokenRequest(env, { grant_type: 'refresh_token', refresh_token: refresh });
}

async function api(env, method, path, body) {
  const res = await fetch(`${API}/${path}`, {
    method,
    headers: { 'Authorization': 'Bearer ' + await accessToken(env), 'Accept': 'application/json', 'User-Agent': UA,
      ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) await kvDel(env, 'access');
  if (!res.ok) throw new Error(`PointT ${path} ${res.status}`);
  return res.json();
}

async function setup(req, env, url) {
  const page = (body, status = 200) => new Response(`<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>WP einrichten</title>
<style>body{margin:0;background:#07090f;color:#b8c8e0;font:16px/1.5 system-ui,sans-serif}main{max-width:620px;margin:0 auto;padding:48px 16px}
h1 span{color:#f0952a}a{color:#ffd166}input,textarea,button{width:100%;font:inherit;padding:12px;margin:6px 0 14px;border-radius:10px;
border:1px solid #1c2a40;background:#131b2e;color:#b8c8e0;box-sizing:border-box}button{background:#f0952a;color:#07090f;font-weight:700;cursor:pointer}
ol li{margin-bottom:8px}.ok{color:#5fd39a}.bad{color:#ff4d64}code{color:#ffd166}</style></head><body><main><h1><span>WP</span> einrichten</h1>${body}</main></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  if (!env.ADMIN) return page('<p class="bad">Secret «ADMIN» fehlt im Worker.</p>', 500);
  const form = req.method === 'POST' ? await req.formData() : null;
  const key = form?.get('key') || url.searchParams.get('key') || '';
  if (key !== env.ADMIN) {
    return page(`<form method="get"><label>Passwort (Secret ADMIN)<input type="password" name="key" autofocus></label><button>Weiter</button></form>`,
      key ? 403 : 200);
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  if (form?.get('redirect')) {
    const flow = JSON.parse(await kvGet(env, 'flow') || 'null');
    if (!flow || now() - flow.ts > 900) return page('<p class="bad">Der Anmeldelink ist abgelaufen. Bitte neu starten.</p><p><a href="?key=' + encodeURIComponent(key) + '">Neu starten</a></p>');
    let r;
    // Chrome schreibt z. B.: Failed to launch 'com.buderus.tt.dashtt://app/login?code=…&state=…' because …
    const raw = String(form.get('redirect')).replace(/^[\s\S]*?(com\.buderus\.tt\.dashtt:\/\/)/, '$1').split(/['"\s]/)[0];
    try { r = new URL(raw); }
    catch { return page('<p class="bad">Das ist keine gültige Rückgabe-Adresse.</p>'); }
    const code = r.searchParams.get('code'), state = r.searchParams.get('state');
    if (!code) return page('<p class="bad">In der Adresse fehlt der Code.</p>');
    if (state !== flow.state) return page('<p class="bad">Die Adresse gehört nicht zu diesem Anmeldelink. Bitte neu starten.</p>');
    await kvDel(env, 'flow');
    await tokenRequest(env, { grant_type: 'authorization_code', code, code_verifier: flow.verifier, redirect_uri: REDIRECT });
    const gws = await api(env, 'GET', 'gateways/');
    const list = Array.isArray(gws) ? gws : gws.gateways || [gws];
    const ids = list.map(g => g.deviceId || g.id || g.gatewayId).filter(Boolean);
    if (!ids.length) return page('<p class="bad">Angemeldet, aber kein Gateway gefunden.</p>');
    await kvSet(env, 'gateway', String(ids[0]));
    await kvDel(env, 'last_error');
    let msg = '';
    try { const row = await poll(env); msg = `<p>Erster Abruf: Aussen ${row.out ?? '–'} °C, Strom gesamt ${row.el ?? '–'} kWh, Wärme gesamt ${row.heat ?? '–'} kWh.</p>`; }
    catch (e) { msg = `<p class="bad">Erster Abruf fehlgeschlagen: ${esc(e.message)}</p>`; }
    return page(`<p class="ok"><b>Verbunden.</b> Ab jetzt holt der Worker alle 5 Minuten die Werte.</p>${msg}
      <p>${ids.length > 1 ? `Mehrere Gateways gefunden, verwendet wird das erste.` : ''}</p><p><a href="https://dom.dombuzz.ch/wp">→ Dashboard</a></p>`);
  }

  // Neuen Anmeldelink mit PKCE erzeugen
  const verifier = rand(64), state = rand(24), nonce = rand(24);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  await kvSet(env, 'flow', JSON.stringify({ verifier, state, ts: now() }));
  const link = `${AUTH}?` + new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPES,
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'login', style_id: 'tt_bud' });
  const st = await status(env);
  return page(`${st.connected ? `<p class="ok">Bereits verbunden (letzter Abruf ${st.last ? new Date(st.last * 1000).toLocaleString('de-CH', { timeZone: TZ }) : '–'}). Neu anmelden nur bei Problemen.</p>` : ''}
<p>Am Computer mit Google Chrome:</p>
<ol>
<li>Rechtsklick auf den Link unten → «Link in neuem Tab öffnen».</li>
<li>Im neuen Tab <b>F12</b> drücken, Reiter <b>Console</b> wählen, beim Zahnrad <b>Protokoll beibehalten</b> (Preserve log) einschalten.</li>
<li>Mit dem gleichen SingleKey-ID-Konto wie in der MyBuderus-App anmelden.</li>
<li>Danach meldet die Seite einen Fehler, das ist normal. In der Console steht eine rote Zeile mit einer Adresse, die mit <code>com.buderus.tt.dashtt://app/login?code=…</code> beginnt. Diese ganze Adresse kopieren.</li>
<li>Hier einfügen und absenden. Der Link gilt 15 Minuten und nur einmal.</li>
</ol>
<p><a href="${esc(link)}" target="_blank" rel="noopener">SingleKey ID: Anmelden →</a></p>
<form method="post"><input type="hidden" name="key" value="${esc(key)}">
<label>Rückgabe-Adresse<textarea name="redirect" rows="4" placeholder="com.buderus.tt.dashtt://app/login?code=…&amp;state=…"></textarea></label>
<button>Verbinden</button></form>`);
}

/* ---------- Abruf ---------- */
function num(p) {
  const v = typeof p?.value === 'number' ? p.value : Number(p?.value);
  return Number.isFinite(v) ? v : null;
}
function energy(p) {
  const unit = String(p?.unitOfMeasure || 'kWh').toLowerCase();
  const scale = unit === 'wh' ? 0.001 : 1;
  const out = {};
  const items = Array.isArray(p?.values) ? p.values : p?.values ? [p.values] : [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const pairs = typeof it.type === 'string' ? [[it.type, it.value]] : Object.entries(it);
    for (const [k, v] of pairs) if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = Math.round(v * scale * 1000) / 1000;
  }
  if (out.electricity == null && out.compressor != null) out.electricity = out.compressor + (out.eheater || 0);
  return out;
}

async function poll(env) {
  const gw = await kvGet(env, 'gateway');
  if (!gw) throw new Error('Nicht eingerichtet: /setup öffnen');
  const res = await api(env, 'POST', 'bulk', [{ gatewayId: gw, resourcePaths: Object.keys(PATHS) }]);
  const env0 = (Array.isArray(res) ? res : [res]).find(e => !e.gatewayId || String(e.gatewayId) === gw) || {};
  const got = {};
  for (const item of env0.resourcePaths || []) {
    const path = String(item.resourcePath || '').replace(/^\/resource(?=\/)/, '');
    const g = item.gatewayResponse;
    if (item.serverStatus === 200 && g && g.status === 200 && PATHS[path]) got[PATHS[path]] = g.payload;
  }
  const t = energy(got.tot), ch = energy(got.ch), dh = energy(got.dhwe);
  const row = {
    out: num(got.out), sup: num(got.sup), ret: num(got.ret), dhw: num(got.dhw), pres: num(got.pres), modu: num(got.modu),
    cmp: got.cmp?.value != null ? String(got.cmp.value) : null,
    el: t.electricity ?? null, comp: t.compressor ?? null, eh: t.eheater ?? null, heat: t.outputProduced ?? null,
    ch_el: ch.electricity ?? null, ch_heat: ch.outputProduced ?? null, dhw_el: dh.electricity ?? null, dhw_heat: dh.outputProduced ?? null,
  };
  if (COLS.every(c => row[c] == null)) throw new Error('Abruf ohne verwertbare Werte');
  const ts = now();
  await env.DB.prepare(`INSERT OR REPLACE INTO r (ts, ${COLS.join(', ')}) VALUES (?${', ?'.repeat(COLS.length)})`)
    .bind(ts, ...COLS.map(c => row[c])).run();
  await kvSet(env, 'last', String(ts));
  await kvDel(env, 'last_error');
  return row;
}

/* ---------- Auslieferung ---------- */
const range = url => (BIN[url.searchParams.get('range')] ? url.searchParams.get('range') : '24h');

async function status(env) {
  return {
    connected: !!(await kvGet(env, 'refresh')),
    last: Number(await kvGet(env, 'last')) || null,
    error: JSON.parse(await kvGet(env, 'last_error') || 'null'),
  };
}

// Offset von Zürich zu UTC in Sekunden (für Tagesgrenzen)
function tzOffset(ts) {
  const d = new Date(ts * 1000);
  const loc = new Date(d.toLocaleString('en-US', { timeZone: TZ }));
  const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((loc - utc) / 1000);
}

async function data(env, rng) {
  const t = now(), from = t - SPAN[rng], bin = BIN[rng];
  const latest = await env.DB.prepare(`SELECT * FROM r ORDER BY ts DESC LIMIT 1`).first();
  const { results } = await env.DB.prepare(
    `SELECT CAST(ts / ?1 AS INTEGER) * ?1 AS b, AVG(out) out, AVG(sup) sup, AVG(ret) ret, AVG(dhw) dhw, MAX(el) el, MAX(heat) heat
     FROM r WHERE ts >= ?2 GROUP BY b ORDER BY b`).bind(bin, from).all();
  const r1 = v => v == null ? null : Math.round(v * 10) / 10;
  const series = results.map(x => [x.b, r1(x.out), r1(x.sup), r1(x.ret), r1(x.dhw), x.el, x.heat]);

  // Energie je Tag (Zürcher Zeit): Zählerstand am Tagesende minus Vortag
  const off = tzOffset(t), days = rng === '24h' ? 7 : rng === '7d' ? 14 : rng === '30d' ? 31 : 366;
  const { results: dr } = await env.DB.prepare(
    `SELECT CAST((ts + ?1) / 86400 AS INTEGER) AS d, MIN(el) el0, MAX(el) el1, MIN(heat) h0, MAX(heat) h1
     FROM r WHERE ts >= ?2 GROUP BY d ORDER BY d`).bind(off, t - (days + 1) * 86400).all();
  const daily = [];
  for (let i = 0; i < dr.length; i++) {
    const p = dr[i - 1], c = dr[i];
    const el = c.el1 == null ? null : c.el1 - (p && p.el1 != null && p.d === c.d - 1 ? p.el1 : c.el0);
    const heat = c.h1 == null ? null : c.h1 - (p && p.h1 != null && p.d === c.d - 1 ? p.h1 : c.h0);
    daily.push([c.d * 86400 - off, el == null ? null : Math.round(el * 100) / 100, heat == null ? null : Math.round(heat * 100) / 100]);
  }
  const first = await env.DB.prepare(`SELECT MIN(ts) ts FROM r`).first();
  return { now: t, range: rng, bin, latest, first: first?.ts || null, series, daily: daily.slice(-days), status: await status(env) };
}

async function klima(env, rng) {
  const t = now(), bin = rng === '24h' ? 600 : BIN[rng];
  const last = await env.DB.prepare(`SELECT ts, out FROM r WHERE out IS NOT NULL ORDER BY ts DESC LIMIT 1`).first();
  const { results } = await env.DB.prepare(
    `SELECT CAST(ts / ?1 AS INTEGER) * ?1 AS b, AVG(out) t FROM r WHERE ts >= ?2 AND out IS NOT NULL GROUP BY b ORDER BY b`)
    .bind(bin, t - SPAN[rng]).all();
  const mm = await env.DB.prepare(`SELECT MIN(out) tmin, MAX(out) tmax FROM r WHERE ts >= ?1 AND out IS NOT NULL`).bind(t - 86400).first();
  return {
    now: t,
    sensor: { id: 'wp', name: 'Aussen · Wärmepumpe', outdoor: true, source: 'wp',
      last: last ? { ts: last.ts, temp: last.out, hum: null } : null, stale: !last || t - last.ts > 1800 },
    series: results.map(x => [x.b, Math.round(x.t * 10) / 10, null]),
    minmax: mm && mm.tmin != null ? { tmin: mm.tmin, tmax: mm.tmax } : null,
  };
}
