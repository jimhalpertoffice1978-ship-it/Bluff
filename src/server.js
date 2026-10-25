// Bluff server: serves the website and runs the real-time game.
// Start with:  npm start     (then open http://localhost:3000)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RoomManager } from './rooms.js';
import { upgrade } from './ws.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
};

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = 20_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  const fwd = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

export function startServer({ port = 3000, host = '0.0.0.0', managerOptions = {}, actsPerSecond = 30 } = {}) {
  const conns = new Map(); // room code -> Set of { ws, token }
  const online = new Map(); // token -> number of open connections
  const buckets = new Map(); // rate limiting

  const allow = (key, limit, windowMs) => {
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || now > b.reset) {
      buckets.set(key, { n: 1, reset: now + windowMs });
      return true;
    }
    b.n += 1;
    return b.n <= limit;
  };

  const sendJson = (ws, obj) => ws.send(JSON.stringify(obj));

  const dropConn = (conn) => {
    const set = conns.get(conn.code);
    if (set) {
      set.delete(conn);
      if (set.size === 0) conns.delete(conn.code);
    }
  };

  const broadcast = (code) => {
    const set = conns.get(code);
    if (!set) return;
    for (const conn of [...set]) {
      const s = manager.snapshot(conn.token);
      if (!s.ok) {
        sendJson(conn.ws, { t: 'kicked', reason: 'You are no longer in this room.' });
        dropConn(conn);
        conn.ws.close(4001);
      } else {
        sendJson(conn.ws, { t: 'snapshot', snapshot: s.snapshot });
      }
    }
  };

  const closeRoom = (code) => {
    const set = conns.get(code);
    if (!set) return;
    for (const conn of [...set]) {
      sendJson(conn.ws, { t: 'kicked', reason: 'The room was closed.' });
      conn.ws.close(4001);
    }
    conns.delete(code);
  };

  const manager = new RoomManager({ ...managerOptions, onChange: broadcast, onRoomDeleted: closeRoom });

  async function serveStatic(pathname, res) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { ok: false, error: 'Forbidden' });
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-cache',
      });
      return res.end(data);
    } catch {
      return json(res, 404, { ok: false, error: 'Not found' });
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://localhost');
      if (req.method === 'POST' && (u.pathname === '/api/create' || u.pathname === '/api/join')) {
        if (!allow(`c:${clientIp(req)}`, 40, 60_000)) {
          return json(res, 429, { ok: false, error: 'Too many requests. Try again in a minute.' });
        }
        const body = await readJson(req);
        const r = u.pathname === '/api/create' ? manager.createRoom(body.name) : manager.joinRoom(body.code, body.name);
        return json(res, r.ok ? 200 : 400, r);
      }
      if (u.pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        return res.end('ok');
      }
      if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(u.pathname, res);
      return json(res, 404, { ok: false, error: 'Not found' });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message === 'too large' ? 'Request too large.' : 'Bad request.' });
    }
  });

  server.on('upgrade', (req, socket) => {
    let u;
    try {
      u = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (u.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const ws = upgrade(req, socket);
    if (!ws) return;
    const token = u.searchParams.get('token') || '';
    const first = manager.snapshot(token);
    if (!first.ok) {
      sendJson(ws, { t: 'kicked', reason: first.error });
      ws.close(4001);
      return;
    }
    const conn = { ws, token, code: first.snapshot.code };
    if (!conns.has(conn.code)) conns.set(conn.code, new Set());
    conns.get(conn.code).add(conn);
    const count = (online.get(token) || 0) + 1;
    online.set(token, count);
    if (count === 1) manager.markConnected(token, true); // broadcasts to everyone, including this connection
    else sendJson(ws, { t: 'snapshot', snapshot: manager.snapshot(token).snapshot });

    ws.onmessage = (text) => {
      if (!allow(`a:${token}`, actsPerSecond, 1000)) {
        sendJson(ws, { t: 'error', error: 'Slow down a little.' });
        return;
      }
      let m;
      try {
        m = JSON.parse(text);
      } catch {
        return;
      }
      if (m && m.t === 'act') {
        const r = manager.act(token, m.action);
        if (!r.ok) sendJson(ws, { t: 'error', error: r.error });
      }
    };

    ws.onclose = () => {
      dropConn(conn);
      const left = (online.get(token) || 1) - 1;
      if (left <= 0) {
        online.delete(token);
        manager.markConnected(token, false);
      } else online.set(token, left);
    };
  });

  const tickTimer = setInterval(() => {
    manager.tick();
    const now = Date.now();
    for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
  }, 1000);

  // Keep connections alive through proxies and drop dead ones.
  const pingTimer = setInterval(() => {
    for (const set of conns.values()) {
      for (const conn of set) {
        if (!conn.ws.alive) conn.ws.terminate();
        else {
          conn.ws.alive = false;
          conn.ws.ping();
        }
      }
    }
  }, 20_000);
  tickTimer.unref();
  pingTimer.unref();

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({
        port: server.address().port,
        manager,
        close: () =>
          new Promise((done) => {
            clearInterval(tickTimer);
            clearInterval(pingTimer);
            for (const set of conns.values()) for (const c of set) c.ws.terminate();
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const port = Number(process.env.PORT) || 3000;
  startServer({ port }).then(({ port: p }) => {
    console.log('');
    console.log('  Bluff is running.');
    console.log(`  Open:  http://localhost:${p}`);
    console.log('  Press Ctrl+C to stop.');
    console.log('');
  });
}
