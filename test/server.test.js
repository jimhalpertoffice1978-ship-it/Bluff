import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager, normalizeMeetLink } from '../src/rooms.js';
import { startServer } from '../src/server.js';

const HAS_WS = typeof globalThis.WebSocket === 'function';

// ---------- RoomManager unit tests (no network, fake clock)

function manager(extra = {}) {
  const clock = { t: 1_000_000 };
  const m = new RoomManager({ now: () => clock.t, graceMs: 30_000, ...extra });
  return { m, clock };
}

function lobbyOf(m, n) {
  const c = m.createRoom('Host');
  const tokens = [c.token];
  for (let i = 1; i < n; i++) tokens.push(m.joinRoom(c.code, `Player${i}`).token);
  tokens.forEach((t) => m.markConnected(t, true));
  return { code: c.code, tokens };
}

test('names are cleaned, required and unique per room', () => {
  const { m } = manager();
  assert.equal(m.createRoom('   ').ok, false);
  const c = m.createRoom('  Anna\n  ');
  assert.equal(c.ok, true);
  assert.equal(m.snapshot(c.token).snapshot.players[0].name, 'Anna');
  assert.equal(m.joinRoom(c.code, 'anna').ok, false);
  assert.equal(m.joinRoom('ZZZZZ', 'Bob').ok, false);
  assert.equal(m.joinRoom(c.code.toLowerCase(), 'Bob').ok, true);
});

test('room holds at most 10 players', () => {
  const { m } = manager();
  const c = m.createRoom('P0');
  for (let i = 1; i < 10; i++) assert.equal(m.joinRoom(c.code, `P${i}`).ok, true);
  assert.equal(m.joinRoom(c.code, 'P10').ok, false);
});

test('only the host can start, and only with 3 or more players', () => {
  const { m } = manager();
  const { tokens } = lobbyOf(m, 2);
  assert.equal(m.act(tokens[0], { type: 'start' }).ok, false);
  const c = m.createRoom('H');
  const b = m.joinRoom(c.code, 'B');
  const d = m.joinRoom(c.code, 'D');
  assert.equal(m.act(b.token, { type: 'start' }).ok, false);
  assert.equal(m.act(c.token, { type: 'start' }).ok, true);
  assert.equal(m.joinRoom(c.code, 'Late').ok, false); // started
  assert.ok(d.ok);
});

test('settings are validated and host-only', () => {
  const { m } = manager();
  const c = m.createRoom('H');
  const b = m.joinRoom(c.code, 'B');
  assert.equal(m.act(b.token, { type: 'setOptions', deckCount: 2 }).ok, false);
  assert.equal(m.act(c.token, { type: 'setOptions', deckCount: 9 }).ok, false);
  assert.equal(m.act(c.token, { type: 'setOptions', turnTimerSec: 3 }).ok, false);
  assert.equal(m.act(c.token, { type: 'setOptions', deckCount: 2, turnTimerSec: 30 }).ok, true);
  assert.deepEqual(m.snapshot(c.token).snapshot.options, { deckCount: 2, turnTimerSec: 30 });
});

test('turn timer auto-plays for a player who stalls', () => {
  const { m, clock } = manager();
  const { code, tokens } = lobbyOf(m, 3);
  m.act(tokens[0], { type: 'setOptions', turnTimerSec: 10 });
  m.act(tokens[0], { type: 'start' });
  const before = m.snapshot(tokens[0]).snapshot;
  assert.equal(before.turnDeadline, clock.t + 10_000);
  const turnId = before.game.turn;
  clock.t += 9_000;
  m.tick();
  assert.equal(m.snapshot(tokens[0]).snapshot.game.turn, turnId); // not yet
  clock.t += 2_000;
  m.tick();
  const after = m.snapshot(tokens[0]).snapshot;
  assert.notEqual(after.game.turn, turnId);
  assert.equal(after.game.stackSize, 1); // auto-played one card
  assert.ok(code);
});

test('a disconnected player is auto-skipped after the grace period', () => {
  const { m, clock } = manager();
  const { tokens } = lobbyOf(m, 3);
  m.act(tokens[0], { type: 'start' });
  const snap = (i) => m.snapshot(tokens[i]).snapshot;
  const turnId = snap(0).game.turn;
  const idx = [0, 1, 2].find((i) => snap(i).youId === turnId);
  m.markConnected(tokens[idx], false);
  clock.t += 20_000;
  m.tick();
  assert.equal(snap((idx + 1) % 3).game.turn, turnId); // still waiting
  clock.t += 15_000;
  m.tick();
  assert.notEqual(snap((idx + 1) % 3).game.turn, turnId);
});

test('leaving mid-game removes you from the game; host passes on; last one out deletes the room', () => {
  const { m } = manager();
  const { code, tokens } = lobbyOf(m, 4);
  m.act(tokens[0], { type: 'start' });
  assert.equal(m.act(tokens[0], { type: 'leave' }).ok, true);
  const s = m.snapshot(tokens[1]).snapshot;
  assert.notEqual(s.hostId, undefined);
  assert.equal(s.game.players.filter((p) => p.status === 'removed').length, 1);
  assert.equal(m.snapshot(tokens[0]).ok, false); // old token is dead
  m.act(tokens[1], { type: 'leave' });
  m.act(tokens[2], { type: 'leave' }); // game ends when one remains
  assert.equal(m.snapshot(tokens[3]).snapshot.phase, 'ended');
  m.act(tokens[3], { type: 'leave' });
  assert.equal(m.rooms.has(code), false);
});

test('host can remove a player in the lobby and the seat frees up', () => {
  const { m } = manager();
  const c = m.createRoom('H');
  const b = m.joinRoom(c.code, 'B');
  const id = m.snapshot(b.token).snapshot.youId;
  assert.equal(m.act(c.token, { type: 'remove', targetId: id }).ok, true);
  assert.equal(m.snapshot(c.token).snapshot.players.length, 1);
  assert.equal(m.snapshot(b.token).ok, false);
});

test('empty, idle rooms are cleaned up', () => {
  const { m, clock } = manager({ idleMs: 1000 });
  const c = m.createRoom('H');
  clock.t += 5000;
  m.tick();
  assert.equal(m.rooms.has(c.code), false);
});

test('snapshots never contain another player\'s hand', () => {
  const { m } = manager();
  const { tokens } = lobbyOf(m, 3);
  m.act(tokens[0], { type: 'start' });
  for (const t of tokens) {
    const text = JSON.stringify(m.snapshot(t).snapshot);
    assert.equal((text.match(/"hand"/g) || []).length, 1);
  }
});

test('only genuine Google Meet links are accepted, and they are normalised', () => {
  assert.deepEqual(normalizeMeetLink('https://meet.google.com/abc-defg-hij'), { ok: true, link: 'https://meet.google.com/abc-defg-hij' });
  assert.equal(normalizeMeetLink('  meet.google.com/ABC-DEFG-HIJ?authuser=1 ').link, 'https://meet.google.com/abc-defg-hij');
  assert.equal(normalizeMeetLink('http://meet.google.com/abc-defg-hij/').link, 'https://meet.google.com/abc-defg-hij');
  assert.equal(normalizeMeetLink('https://meet.google.com/lookup/abcd1234').link, 'https://meet.google.com/lookup/abcd1234');
  assert.deepEqual(normalizeMeetLink(''), { ok: true, link: null });
  for (const bad of ['https://evil.com/abc-defg-hij', 'https://meet.google.com.evil.com/abc-defg-hij', 'javascript:alert(1)', 'https://meet.google.com/', 'https://meet.google.com/abc-defg', 'hello', 42]) {
    assert.equal(normalizeMeetLink(bad).ok, false, String(bad));
  }
});

test('host sets the Meet link and every player sees it; others cannot change it', () => {
  const { m } = manager();
  const c = m.createRoom('H');
  const b = m.joinRoom(c.code, 'B');
  assert.equal(m.act(b.token, { type: 'setMeet', link: 'https://meet.google.com/abc-defg-hij' }).ok, false);
  assert.equal(m.act(c.token, { type: 'setMeet', link: 'https://example.com' }).ok, false);
  assert.equal(m.act(c.token, { type: 'setMeet', link: 'meet.google.com/abc-defg-hij' }).ok, true);
  assert.equal(m.snapshot(b.token).snapshot.meetLink, 'https://meet.google.com/abc-defg-hij');
  assert.equal(m.act(c.token, { type: 'setMeet', link: '' }).ok, true);
  assert.equal(m.snapshot(b.token).snapshot.meetLink, null);
});

// ---------- end to end over real HTTP + WebSocket

function wsClient(base, token) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}`);
  let latest = null;
  const msgs = [];
  const waiters = [];
  const opened = new Promise((res) => { ws.onopen = res; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    msgs.push(m);
    if (m.t === 'snapshot') {
      latest = m.snapshot;
      for (const w of [...waiters]) {
        if (w.pred(latest)) {
          clearTimeout(w.timer);
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(latest);
        }
      }
    }
  };
  return {
    msgs,
    get latest() { return latest; },
    opened,
    send: (o) => ws.send(JSON.stringify(o)),
    close: () => ws.close(),
    waitFor(pred, ms = 3000) {
      if (latest && pred(latest)) return Promise.resolve(latest);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        w.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error('timed out waiting for a snapshot'));
        }, ms);
        waiters.push(w);
      });
    },
  };
}

async function postJson(base, path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

test('serves the website', { skip: !HAS_WS }, async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1' });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Bluff/);
    const h = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
    assert.equal(h.status, 200);
    assert.equal(await h.text(), 'ok');
    const bad = await fetch(`http://127.0.0.1:${srv.port}/..%2fsrc%2fengine.js`);
    assert.notEqual(bad.status, 200);
  } finally {
    await srv.close();
  }
});

test('an invalid token is rejected', { skip: !HAS_WS }, async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1' });
  const c = wsClient(`http://127.0.0.1:${srv.port}`, 'nope');
  try {
    await c.opened;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(c.msgs[0].t, 'kicked');
  } finally {
    c.close();
    await srv.close();
  }
});

test('full game: 4 players over WebSockets, from lobby to results', { skip: !HAS_WS, timeout: 60_000 }, async () => {
  // The bots play far faster than any human, so lift the anti-spam limit for this test.
  const srv = await startServer({ port: 0, host: '127.0.0.1', actsPerSecond: 1_000_000 });
  const base = `http://127.0.0.1:${srv.port}`;
  const clients = [];
  try {
    const created = await postJson(base, '/api/create', { name: 'Host' });
    assert.equal(created.ok, true);
    assert.match(created.code, /^[A-Z]{5}$/);
    const tokens = [created.token];
    for (const name of ['Ana', 'Ben', 'Cy']) {
      const j = await postJson(base, '/api/join', { code: created.code, name });
      assert.equal(j.ok, true, j.error);
      tokens.push(j.token);
    }
    for (const t of tokens) {
      const c = wsClient(base, t);
      clients.push(c);
      await c.opened;
    }
    await Promise.all(clients.map((c) => c.waitFor((s) => s.players.length === 4 && s.players.every((p) => p.connected))));

    // out-of-turn / non-host attempts are refused with an error message
    clients[1].send({ t: 'act', action: { type: 'start' } });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(clients[1].msgs.at(-1).t, 'error');

    clients[0].send({ t: 'act', action: { type: 'setOptions', deckCount: 1 } });
    await clients[3].waitFor((s) => s.options.deckCount === 1);
    clients[0].send({ t: 'act', action: { type: 'start' } });
    await Promise.all(clients.map((c) => c.waitFor((s) => s.phase === 'playing')));

    for (const c of clients) {
      const text = JSON.stringify(c.latest);
      assert.equal((text.match(/"hand"/g) || []).length, 1, 'only your own hand is sent');
    }

    let seed = 12345;
    const rand = (n) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
    let steps = 0;
    while (clients[0].latest.game.phase !== 'ended') {
      assert.ok(++steps < 5000, 'game should finish');
      const view = clients[0].latest;
      const actor = clients.find((c) => c.latest.youId === view.game.turn);
      const you = actor.latest.game.you;
      const prev = view.rev;
      let action;
      if (you.canCheck && rand(100) < 25) action = { type: 'check' };
      else if (you.canSkip && rand(100) < 30) action = { type: 'skip' };
      else {
        const hand = [...you.hand];
        const k = 1 + rand(Math.min(3, hand.length));
        const picked = [];
        for (let i = 0; i < k; i++) picked.push(hand.splice(rand(hand.length), 1)[0]);
        const first = picked.find((c) => c.rank !== 'JOKER');
        action = { type: 'play', cardIds: picked.map((c) => c.id), rank: view.game.stackRank || (first ? first.rank : 'A') };
      }
      actor.send({ t: 'act', action });
      await Promise.all(clients.map((c) => c.waitFor((s) => s.rev > prev)));
    }

    const end = clients[0].latest;
    assert.equal(end.phase, 'ended');
    assert.equal(end.game.finishedOrder.length, 3);
    assert.ok(end.game.loserId);

    clients[0].send({ t: 'act', action: { type: 'backToLobby' } });
    await Promise.all(clients.map((c) => c.waitFor((s) => s.phase === 'lobby')));
  } finally {
    clients.forEach((c) => c.close());
    await srv.close();
  }
});

test('reconnecting with the same token restores your seat', { skip: !HAS_WS }, async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${srv.port}`;
  const created = await postJson(base, '/api/create', { name: 'Host' });
  const a = wsClient(base, created.token);
  const open = [a];
  try {
    await a.opened;
    await a.waitFor((s) => s.players[0].connected);
    a.close();
    await new Promise((r) => setTimeout(r, 200));
    const b = wsClient(base, created.token);
    open.push(b);
    await b.opened;
    const s = await b.waitFor((x) => x.players[0].connected);
    assert.equal(s.youId, created.playerId);
    assert.equal(s.code, created.code);
  } finally {
    open.forEach((c) => c.close());
    await srv.close();
  }
});
