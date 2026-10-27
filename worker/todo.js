// Cloudflare Worker «todo» – speichert die Todo-Liste von dom.dombuzz.ch/todo
//
// Einrichtung im Cloudflare-Dashboard:
// 1. Workers & Pages → KV → Namespace «todo» anlegen
// 2. Workers & Pages → Create → Worker «todo» → diesen Code einfügen → Deploy
// 3. Worker → Settings → Bindings → KV Namespace: Variable «TODO», Namespace «todo»
// 4. Worker → Settings → Variables and Secrets → Secret «TOKEN» mit dem Wert aus dem Chat
//
// Die Seite schickt den aus dem Passwort abgeleiteten Schlüssel mit. Ohne passenden
// Schlüssel liefert der Worker nichts aus und speichert nichts.

const ORIGINS = ['https://dom.dombuzz.ch'];

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    if (url.pathname !== '/todos') return json({ error: 'not found' }, 404);

    const auth = req.headers.get('Authorization') || '';
    if (!env.TOKEN || auth !== 'Bearer ' + env.TOKEN) return json({ error: 'unauthorized' }, 401);

    if (req.method === 'GET') {
      const data = await env.TODO.get('list', 'json');
      return json(data || { items: [], updated: 0 });
    }

    if (req.method === 'PUT') {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!body || !Array.isArray(body.items) || body.items.length > 2000) return json({ error: 'bad data' }, 400);
      const items = body.items.map(i => ({
        id: String(i.id || '').slice(0, 40),
        text: String(i.text || '').slice(0, 2000),
        done: !!i.done
      })).filter(i => i.id && i.text);
      const data = { items, updated: Date.now() };
      await env.TODO.put('list', JSON.stringify(data));
      return json(data);
    }

    return json({ error: 'method not allowed' }, 405);
  }
};
