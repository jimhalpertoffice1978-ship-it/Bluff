'use strict';

// ------------------------------------------------------------------ constants and state

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const RANK_NAME = { A: 'Ace', 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten', J: 'Jack', Q: 'Queen', K: 'King' };
const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_NAME = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };
const HUES = [340, 18, 44, 150, 186, 212, 266, 300];

const root = document.getElementById('app');
const fx = document.getElementById('fx');
const offlineBanner = document.getElementById('offline');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let session = loadSession(); // { code, token }: remembered so a refresh keeps your seat
let snap = null;
let ws = null;
let skew = 0; // server clock minus our clock
let selected = new Set();
let declRank = 'A';
let rankTouched = false;
let homeName = '';
let peek = false;
let mascotTimer = null;
let meetDraft = null; // text typed in the lobby's Meet field, kept across re-renders
let homeCode = (new URLSearchParams(location.search).get('room') || '').toUpperCase().slice(0, 5);
let muted = false;
try { muted = localStorage.getItem('bluff.muted') === '1'; } catch { /* storage unavailable */ }

// game screen state
let gameBuilt = false;
let els = {};
let seatEls = {};
let bulbEls = [];
let lastHandSig = '';
let lastPileCount = -1;
let revealTimers = [];
let resultsDismissed = false;
let timerHandle = null;

// ------------------------------------------------------------------ small helpers

function loadSession() { try { return JSON.parse(localStorage.getItem('bluff.session')); } catch { return null; } }
function saveSession(s) {
  session = s;
  try { if (s) localStorage.setItem('bluff.session', JSON.stringify(s)); else localStorage.removeItem('bluff.session'); } catch { /* ignore */ }
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const $ = (sel, scope = document) => scope.querySelector(sel);

function hueFor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}
function ord(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function rankLabel(rank, count) {
  const base = RANK_NAME[rank];
  if (count === 1) return base;
  return base === 'Six' ? 'Sixes' : `${base}s`;
}
function cardName(c) { return c.rank === 'JOKER' ? 'Joker' : `${RANK_NAME[c.rank]} of ${SUIT_NAME[c.suit]}`; }

function toast(msg) {
  fx.querySelectorAll('.toast').forEach((old) => old.remove());
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  fx.appendChild(t);
  setTimeout(() => t.classList.add('out'), 2800);
  setTimeout(() => t.remove(), 3300);
}

async function post(path, body) {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch { return { ok: false, error: 'Cannot reach the server.' }; }
}

// ------------------------------------------------------------------ sound (synthesised, no files)

let actx = null;
function audio() {
  if (!actx) {
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
function tone(freq, dur = 0.12, type = 'sine', gain = 0.08, delay = 0, slide = 0) {
  if (muted) return;
  const c = audio();
  if (!c) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.03);
}
const sfx = {
  play() { tone(230, 0.08, 'triangle', 0.14, 0, -90); },
  honk() { tone(420, 0.12, 'square', 0.09, 0, -80); tone(340, 0.2, 'square', 0.09, 0.13, -40); },
  thud() { tone(120, 0.22, 'sine', 0.3, 0, -70); tone(1760, 0.09, 'triangle', 0.05, 0.03); tone(2349, 0.12, 'triangle', 0.04, 0.09); },
  skip() { tone(310, 0.07, 'sine', 0.06); },
  turn() { tone(660, 0.14, 'sine', 0.09); tone(880, 0.22, 'sine', 0.09, 0.13); },
  lie() { tone(330, 0.55, 'sawtooth', 0.06, 0, -230); },
  truth() { tone(523, 0.14, 'triangle', 0.09); tone(659, 0.14, 'triangle', 0.09, 0.12); tone(784, 0.28, 'triangle', 0.09, 0.24); },
};
document.addEventListener('pointerdown', () => { audio(); }, { passive: true });

// ------------------------------------------------------------------ connection

function connect() {
  if (ws) { ws.onclose = null; ws.close(); }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(session.token)}`);
  ws.onopen = () => { offlineBanner.hidden = true; };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'snapshot') {
      const prev = snap;
      snap = m.snapshot;
      skew = snap.serverNow - Date.now();
      render(prev);
    } else if (m.t === 'kicked') leaveLocal(m.reason);
    else if (m.t === 'error') toast(m.error);
  };
  ws.onclose = () => {
    if (!session) return;
    offlineBanner.hidden = false;
    setTimeout(() => { if (session) connect(); }, 1500);
  };
}

function leaveLocal(msg) {
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  saveSession(null);
  snap = null;
  selected.clear();
  gameBuilt = false;
  offlineBanner.hidden = true;
  document.title = 'Bluff';
  render(null);
  if (msg) toast(msg);
}

function send(action) {
  if (!ws || ws.readyState !== 1) { toast('Not connected. Trying to reconnect…'); return; }
  ws.send(JSON.stringify({ t: 'act', action }));
}

// ------------------------------------------------------------------ top-level render

function render(prev) {
  if (!session) { gameBuilt = false; renderHome(); return; }
  if (!snap) { gameBuilt = false; root.innerHTML = '<div class="home"><p class="lede">Connecting…</p></div>'; return; }
  if (snap.phase === 'lobby') {
    if (gameBuilt) { gameBuilt = false; selected.clear(); }
    renderLobby();
    return;
  }
  if (!gameBuilt) { buildGame(); resultsDismissed = false; }
  updateGame(prev);
}

// ------------------------------------------------------------------ home

function cardFace(rank, suit) {
  if (rank === 'JOKER') return '<span class="card joker" aria-hidden="true"><span class="jk">★</span><span class="jt">Joker</span></span>';
  const red = suit === 'H' || suit === 'D' ? 'red' : '';
  return `<span class="card ${red}" aria-hidden="true"><span class="idx tl"><b>${rank}</b><i>${SUIT[suit]}</i></span><span class="pip">${SUIT[suit]}</span><span class="idx br"><b>${rank}</b><i>${SUIT[suit]}</i></span></span>`;
}

function renderHome() {
  const invited = homeCode.length === 5;
  root.innerHTML = `
  <div class="home">
    <div class="marquee">
      <img class="logo" src="/logo.png" alt="Joker Bluff">
      <div class="suits" aria-hidden="true">♠<span class="r">♥</span>♣<span class="r">♦</span></div>
      <p class="lede">Play cards face down, say what they are, and let everyone else decide whether you are lying.</p>
    </div>
    <label class="label">Your name
      <input class="field" id="name" maxlength="20" autocomplete="nickname" placeholder="What should we call you?" value="${esc(homeName)}">
    </label>
    ${invited ? `
      <div class="invite">You have been invited to room <b>${esc(homeCode)}</b>.</div>
      <button class="btn primary big" data-a="join">Join the room</button>
      <button class="linkish" data-a="own">Start my own room instead</button>
    ` : `
      <button class="btn primary big" data-a="create">Create a room</button>
      <div class="divider">or join a friend's room</div>
      <div class="joinrow">
        <input class="field" id="code" maxlength="5" autocomplete="off" placeholder="CODE" value="${esc(homeCode)}">
        <button class="btn ghost" data-a="join">Join</button>
      </div>
    `}
  </div>`;
}

// ------------------------------------------------------------------ lobby

function personHtml(p, isHost) {
  const meta = [p.isHost ? 'Host' : '', p.id === snap.youId ? 'You' : '', p.connected ? '' : 'Offline'].filter(Boolean).join(', ');
  return `<div class="person">
    <div class="avatar" style="--h:${hueFor(p.id)}">${esc(p.name.charAt(0).toUpperCase())}</div>
    <div class="name">${esc(p.name)}</div>
    <div class="meta">${meta}</div>
    ${isHost && p.id !== snap.youId ? `<button class="rm" data-a="remove" data-id="${p.id}">Remove</button>` : ''}
  </div>`;
}

function segHtml(key, options, current, enabled) {
  return `<div class="seg">${options.map(([value, label]) =>
    `<button data-a="opt" data-k="${key}" data-v="${value}" class="${current === value ? 'on' : ''}" ${enabled ? '' : 'disabled'}>${label}</button>`).join('')}</div>`;
}

function meetPanelHtml(isHost) {
  const link = snap.meetLink;
  const join = link ? `<a class="btn primary" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Join video call</a>` : '';
  if (isHost) {
    const value = meetDraft !== null ? meetDraft : (link || '');
    return `<div class="meetrow"><input class="field" id="meetInput" autocomplete="off" placeholder="https://meet.google.com/abc-defg-hij" value="${esc(value)}"><button class="btn ghost" data-a="meet-save">Save</button></div>
      <div class="row">${join}<a class="linkish" href="https://meet.new" target="_blank" rel="noopener noreferrer">Create a new Meet</a></div>
      <p class="hint">Create a Meet, copy its link, paste it here, and everyone gets a join button. Meet opens in its own tab. On a phone, use the Meet app.</p>`;
  }
  return link
    ? `<div class="row">${join}</div><p class="hint">Meet opens in its own tab. On a phone, use the Meet app.</p>`
    : '<p class="hint">The host has not added a video link yet.</p>';
}

function renderLobby() {
  const isHost = snap.hostId === snap.youId;
  const o = snap.options;
  const link = `${location.origin}/?room=${snap.code}`;
  const enough = snap.players.length >= 3;
  const deckOpts = [[null, `Automatic (${snap.recommendedDecks})`], [1, '1'], [2, '2'], [3, '3'], [4, '4']];
  const timerOpts = [[0, 'Off'], [15, '15 s'], [30, '30 s'], [60, '1 min'], [120, '2 min']];
  root.innerHTML = `
  <div class="lobby">
    <h2>Waiting room</h2>
    <div class="codetiles" aria-label="Room code ${esc(snap.code)}">${[...snap.code].map((ch) => `<span>${esc(ch)}</span>`).join('')}</div>
    <div class="row"><button class="btn ghost" data-a="copy" data-text="${esc(link)}">Copy invite link</button></div>
    <div class="people">${snap.players.map((p) => personHtml(p, isHost)).join('')}</div>
    ${enough ? '' : `<p class="hint">Bluff needs 3 to 10 players. Share the link to invite friends.</p>`}
    <div class="panel">
      <h3>Video call</h3>
      ${meetPanelHtml(isHost)}
    </div>
    <div class="panel">
      <h3>Decks</h3>${segHtml('deckCount', deckOpts, o.deckCount, isHost)}
      <h3>Turn timer</h3>${segHtml('turnTimerSec', timerOpts, o.turnTimerSec, isHost)}
      <p class="hint">${isHost ? 'Each deck has 52 cards and 3 Jokers.' : 'Only the host can change these.'}</p>
    </div>
    <div class="row">
      ${isHost ? `<button class="btn primary" data-a="start" ${enough ? '' : 'disabled'}>Start game</button>` : '<span class="hint">Waiting for the host to start…</span>'}
      <button class="btn ghost" data-a="leave">Leave</button>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ game: build

function buildGame() {
  gameBuilt = true;
  seatEls = {};
  bulbEls = [];
  lastHandSig = '';
  lastPileCount = -1;
  root.innerHTML = `
  <div class="game">
    <header class="topbar">
      <img class="brand-logo" src="/logo.png" alt="Joker Bluff">
      <button class="code-chip" data-a="copy" id="codeChip" title="Copy invite link"><span>Room</span><b></b></button>
      <div class="grow"></div>
      <span class="info" id="info"></span>
      <span id="meetSlot"></span>
      <button class="icon-btn" data-a="sound" id="soundBtn"></button>
      <button class="icon-btn" data-a="leave">Leave</button>
    </header>
    <main class="stage">
      <div class="table-wrap" id="tableWrap">
        <div class="rim" id="rim"><div class="felt"></div><div class="bulbs" id="bulbs"></div></div>
        <div class="center" id="center"><div class="mascot grin" id="mascot"></div><div class="pile" id="pile"></div><div class="claim" id="claim"></div></div>
        <div id="seats"></div>
        <div class="reveal" id="reveal" hidden></div>
      </div>
    </main>
    <section class="dock" id="dock">
      <div class="status" id="status"></div>
      <button class="peek-btn" data-a="peek" id="peekBtn">Peek at all my cards</button>
      <div class="hand" id="hand"></div>
      <div class="chips" id="chips">${RANKS.map((r) => `<button class="chip" data-a="rank" data-r="${r}" aria-label="Say they are ${RANK_NAME[r]}s">${r}</button>`).join('')}</div>
      <div class="actions">
        <button class="btn primary" id="btnPlay" data-a="play">Play cards</button>
        <button class="btn ghost" id="btnSkip" data-a="skip">Skip</button>
        <button class="btn bluff" id="btnCheck" data-a="check">Call bluff</button>
      </div>
    </section>
    <div class="results" id="results" hidden></div>
  </div>`;
  els = {
    wrap: $('#tableWrap'), rim: $('#rim'), pile: $('#pile'), claim: $('#claim'), seats: $('#seats'),
    reveal: $('#reveal'), status: $('#status'), hand: $('#hand'), chips: $('#chips'), dock: $('#dock'),
    btnPlay: $('#btnPlay'), btnSkip: $('#btnSkip'), btnCheck: $('#btnCheck'), results: $('#results'),
    info: $('#info'), chip: $('#codeChip'), sound: $('#soundBtn'),
  };
  new ResizeObserver(() => { if (gameBuilt) { layoutSeats(); layoutHand(); } }).observe(els.wrap);
}

// ------------------------------------------------------------------ game: update

function updateGame(prev) {
  const g = snap.game;
  const nm = (id) => { const p = snap.players.find((x) => x.id === id); return p ? p.name : '?'; };

  $('b', els.chip).textContent = snap.code;
  els.chip.dataset.text = `${location.origin}/?room=${snap.code}`;
  els.info.textContent = `${g.deckCount} deck${g.deckCount === 1 ? '' : 's'}, ${g.setAsideCount} set aside`;
  els.sound.textContent = muted ? 'Muted' : 'Sound';
  updateMeetSlot();

  updateSeats();
  updatePile(nm);
  updateStatus(nm);
  updateHand();
  updateControls();
  updateResults(nm);
  if (prev && prev.game && snap.rev === prev.rev + 1) detectEvents(prev, nm);

  const myTurn = g.turn === snap.youId && g.phase === 'playing';
  document.title = myTurn ? 'Your turn - Bluff' : 'Bluff';
}

function updateMeetSlot() {
  const isHost = snap.hostId === snap.youId;
  const link = snap.meetLink;
  let html = '';
  if (link) {
    html = `<a class="icon-btn meet" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Join video</a>`;
    if (isHost) html += '<button class="icon-btn" data-a="meet-edit">Edit</button>';
  } else if (isHost) html = '<button class="icon-btn meet" data-a="meet-edit">Add video</button>';
  const slot = $('#meetSlot');
  if (slot.dataset.html !== html) { slot.innerHTML = html; slot.dataset.html = html; }
}

function seatTemplate(id) {
  const el = document.createElement('div');
  el.className = 'seat';
  el.dataset.id = id;
  el.style.setProperty('--h', hueFor(id));
  el.innerHTML = '<div class="tile"><div class="face"><span class="initial"></span></div><span class="badge" hidden></span><span class="count"></span></div><div class="plate"></div>';
  return el;
}

function updateSeats() {
  const g = snap.game;
  const info = Object.fromEntries(snap.players.map((p) => [p.id, p]));
  const seen = new Set();
  let nextId = null;
  const ti = g.players.findIndex((p) => p.id === g.turn);
  for (let k = 1; ti >= 0 && k < g.players.length; k++) {
    const q = g.players[(ti + k) % g.players.length];
    if (q.status === 'active') { nextId = q.id; break; }
  }
  for (const p of g.players) {
    seen.add(p.id);
    let el = seatEls[p.id];
    if (!el) { el = seatEls[p.id] = seatTemplate(p.id); els.seats.appendChild(el); }
    const online = info[p.id] ? info[p.id].connected : true;
    const place = g.finishedOrder.indexOf(p.id);
    let badge = '';
    if (p.status === 'finished') badge = `${ord(place + 1)}`;
    else if (p.status === 'pending') badge = 'Last cards';
    else if (p.status === 'removed') badge = 'Left';
    else if (!online) badge = 'Offline';
    el.classList.toggle('turn', g.turn === p.id && g.phase === 'playing');
    el.classList.toggle('next', p.id === nextId && g.phase === 'playing');
    el.classList.toggle('me', p.id === snap.youId);
    el.classList.toggle('out', p.status === 'finished' || p.status === 'removed');
    el.classList.toggle('offline', !online && p.status !== 'removed');
    $('.initial', el).textContent = p.name.charAt(0).toUpperCase();
    $('.plate', el).textContent = p.name;
    $('.count', el).textContent = p.status === 'finished' || p.status === 'removed' ? '' : p.cardCount;
    $('.count', el).hidden = p.status === 'finished' || p.status === 'removed';
    const b = $('.badge', el);
    b.hidden = !badge;
    b.textContent = badge;
    el.setAttribute('aria-label', `${p.name}, ${p.cardCount} cards${badge ? ', ' + badge : ''}`);
  }
  for (const id of Object.keys(seatEls)) {
    if (!seen.has(id)) { seatEls[id].remove(); delete seatEls[id]; }
  }
  layoutSeats();
}

function layoutSeats() {
  if (!snap || !snap.game || !els.wrap) return;
  const w = els.wrap.clientWidth;
  const h = els.wrap.clientHeight;
  if (!w || !h) return;
  const ps = snap.game.players;
  const n = ps.length;
  const meIdx = Math.max(0, ps.findIndex((p) => p.id === snap.youId));
  const crowd = n > 6;
  let tileW = clamp(Math.floor(Math.min(w * (crowd ? 0.105 : 0.12), h * (crowd ? 0.19 : 0.23))), 40, 96);
  let seatH = tileW * 1.1 + 26;
  let rx = 0;
  let ry = 0;
  // Shrink the seats until neighbours on the steep sides of the oval no longer overlap.
  for (let i = 0; i < 4; i++) {
    rx = Math.max(60, w / 2 - tileW / 2 - 20); // leave room for the wider name plates
    ry = Math.max(50, h / 2 - seatH / 2 - 4);
    const room = 2 * ry * Math.sin(Math.PI / n) * 0.94 - 26;
    const fit = clamp(Math.floor(room / 1.1), 44, tileW);
    if (fit >= tileW) break;
    tileW = fit;
    seatH = tileW * 1.1 + 26;
  }
  rx = Math.min(rx, ry * 2.7); // an oval, but never absurdly wide
  els.wrap.style.setProperty('--tile-w', `${tileW}px`);
  Object.assign(els.rim.style, { left: `${w / 2 - rx}px`, top: `${h / 2 - ry}px`, width: `${rx * 2}px`, height: `${ry * 2}px` });
  layoutBulbs(rx, ry);
  els.wrap.style.setProperty('--pile-w', `${clamp(Math.floor(Math.min(rx * 0.14, ry * 0.26)), 32, 60)}px`);
  for (let k = 0; k < n; k++) {
    const p = ps[(meIdx + k) % n];
    const el = seatEls[p.id];
    if (!el) continue;
    const a = Math.PI / 2 + (k * 2 * Math.PI) / n; // me at the bottom, then clockwise
    el.style.left = `${w / 2 + rx * Math.cos(a)}px`;
    el.style.top = `${h / 2 + ry * Math.sin(a)}px`;
    el.style.zIndex = String(10 + Math.round(Math.sin(a) * 5));
  }
}

// Marquee bulbs around the table rim; they alternate so the ring appears to chase.
function layoutBulbs(rx, ry) {
  const holder = $('#bulbs');
  if (!holder) return;
  const ring = clamp(Math.round(Math.min(rx, ry) * 0.12), 16, 30);
  els.rim.style.setProperty('--ring', `${ring}px`);
  const a = rx - ring / 2;
  const b = ry - ring / 2;
  const perimeter = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  let n = Math.round(perimeter / (ring * 1.1));
  n = clamp(n - (n % 2), 24, 90);
  while (bulbEls.length < n) {
    const d = document.createElement('i');
    d.className = 'bulb';
    holder.appendChild(d);
    bulbEls.push(d);
  }
  while (bulbEls.length > n) bulbEls.pop().remove();
  holder.style.setProperty('--bulb', `${Math.max(6, Math.round(ring * 0.4))}px`);
  bulbEls.forEach((el, i) => {
    const t = (i / n) * 2 * Math.PI;
    el.style.left = `${rx + a * Math.cos(t)}px`;
    el.style.top = `${ry + b * Math.sin(t)}px`;
    el.classList.toggle('b', i % 2 === 1);
  });
}

function updatePile(nm) {
  const g = snap.game;
  const k = Math.min(g.stackSize, 8);
  if (k !== lastPileCount || g.stackSize !== els.pile.dataset.size) {
    let html = '';
    if (g.stackSize === 0) html = '<div class="empty"></div>';
    for (let i = 0; i < k; i++) {
      html += `<div class="pc back" style="--x:${((i * 37) % 9) - 4};--y:${((i * 53) % 7) - 3};--r:${((i * 29) % 21) - 10}"></div>`;
    }
    if (g.stackSize > 0) html += `<div class="count">${g.stackSize}</div>`;
    els.pile.innerHTML = html;
    els.pile.dataset.size = String(g.stackSize);
    lastPileCount = k;
  }
  if (g.phase === 'ended') els.claim.innerHTML = '';
  else if (g.lastPlay) {
    els.claim.innerHTML = `<span class="who">${esc(nm(g.lastPlay.playerId))} says</span>${g.lastPlay.count} ${rankLabel(g.lastPlay.rank, g.lastPlay.count)}`;
  } else els.claim.innerHTML = `<span class="quiet">${esc(nm(g.turn))} starts a new stack</span>`;
}

function updateStatus(nm) {
  const g = snap.game;
  const you = g.you;
  const me = g.players.find((p) => p.id === snap.youId);
  let text;
  if (g.phase === 'ended') text = 'Game over';
  else if (you && you.canPlay && g.stackSize && !you.canCheck) text = `Everyone skipped. Play more ${rankLabel(g.stackRank, 2)} or skip to clear the stack.`;
  else if (you && you.canPlay) text = g.stackSize ? `Your turn. Play ${rankLabel(g.stackRank, 2)}, skip, or call bluff.` : 'Your turn. Start a new stack and pick its rank.';
  else if (me && me.status === 'pending') text = 'That was your last card. Waiting to see if anyone calls bluff.';
  else if (me && me.status === 'finished') text = `You finished ${ord(g.finishedOrder.indexOf(snap.youId) + 1)}. Watching the rest.`;
  else if (me && me.status === 'removed') text = 'You are no longer in this game.';
  else text = `${nm(g.turn)} is thinking…`;
  els.status.innerHTML = `${esc(text)}<span class="timer" id="timerText"></span>`;
  startTimer();
}

function startTimer() {
  clearInterval(timerHandle);
  const el = $('#timerText');
  if (!el || !snap.turnDeadline || snap.phase !== 'playing') return;
  const tick = () => {
    const left = Math.max(0, Math.ceil((snap.turnDeadline - (Date.now() + skew)) / 1000));
    el.textContent = `${left}s left`;
  };
  tick();
  timerHandle = setInterval(tick, 500);
}

function updateHand() {
  const g = snap.game;
  const you = g.you;
  const active = you && g.phase === 'playing' && g.players.find((p) => p.id === snap.youId).status === 'active';
  els.hand.hidden = !active;
  els.hand.classList.toggle('peek', peek);
  $('#peekBtn').hidden = !active;
  $('#mascot').dataset.ready || setMascot('grin');
  els.chips.hidden = !active || !!g.stackRank; // the rank is fixed once a stack has started
  els.btnPlay.parentElement.hidden = !active;
  if (!active) return;
  const hand = [...you.hand].sort((a, b) => (a.rank === 'JOKER' ? 99 : RANKS.indexOf(a.rank)) - (b.rank === 'JOKER' ? 99 : RANKS.indexOf(b.rank)));
  const ids = new Set(hand.map((c) => c.id));
  for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
  const sig = `${hand.map((c) => c.id).join(',')}|${[...selected].sort().join(',')}`;
  if (sig === lastHandSig) return;
  lastHandSig = sig;
  const n = hand.length;
  els.hand.innerHTML = hand.map((c, i) => {
    const t = n > 1 ? (i - (n - 1) / 2) / ((n - 1) / 2) : 0;
    const rot = (t * Math.min(7, n * 0.7)).toFixed(1);
    const dy = (t * t * 8).toFixed(1);
    const sel = selected.has(c.id) ? 'sel' : '';
    const style = `--rot:${rot}deg;--dy:${dy}`;
    if (c.rank === 'JOKER') {
      return `<button class="card joker ${sel}" data-a="card" data-id="${c.id}" style="${style}" aria-label="Joker" aria-pressed="${!!sel}"><span class="jk">★</span><span class="jt">Joker</span></button>`;
    }
    const red = c.suit === 'H' || c.suit === 'D' ? 'red' : '';
    return `<button class="card ${red} ${sel}" data-a="card" data-id="${c.id}" style="${style}" aria-label="${cardName(c)}" aria-pressed="${!!sel}">` +
      `<span class="idx tl"><b>${c.rank}</b><i>${SUIT[c.suit]}</i></span><span class="pip">${SUIT[c.suit]}</span>` +
      `<span class="idx br"><b>${c.rank}</b><i>${SUIT[c.suit]}</i></span></button>`;
  }).join('');
  layoutHand();
}

function layoutHand() {
  if (!els.hand || els.hand.hidden) return;
  const cards = els.hand.querySelectorAll('.card');
  if (!cards.length) return;
  const cw = cards[0].offsetWidth;
  const avail = els.hand.clientWidth - 20;
  const n = cards.length;
  let step = n > 1 ? Math.min(cw + 8, (avail - cw) / (n - 1)) : cw;
  step = Math.max(step, 24);
  els.hand.style.setProperty('--step', step.toFixed(1));
}

function updateControls() {
  const g = snap.game;
  const you = g.you;
  if (!you) return;
  const n = selected.size;
  const locked = g.stackRank;
  if (locked) declRank = locked; // the stack's rank is fixed until it is cleared
  els.btnPlay.textContent = n ? `Play ${n} card${n === 1 ? '' : 's'} as ${rankLabel(declRank, n)}` : 'Pick cards to play';
  els.btnPlay.disabled = !(you.canPlay && n > 0);
  els.btnSkip.disabled = !you.canSkip;
  els.btnCheck.disabled = !you.canCheck;
  for (const chip of els.chips.children) {
    chip.classList.toggle('on', chip.dataset.r === declRank);
    chip.disabled = !!locked && chip.dataset.r !== locked;
  }
}

function updateResults(nm) {
  const g = snap.game;
  if (g.phase !== 'ended' || resultsDismissed) { els.results.hidden = true; return; }
  const isHost = snap.hostId === snap.youId;
  const rows = g.finishedOrder.map((id, i) =>
    `<div class="rank-row ${i === 0 ? 'first' : ''}"><span class="place">${ord(i + 1)}</span>${esc(nm(id))}</div>`).join('');
  const last = g.loserId
    ? `<div class="rank-row last"><span class="place">${ord(g.finishedOrder.length + 1)}</span>${esc(nm(g.loserId))}<small>stuck with cards</small></div>` : '';
  els.results.innerHTML = `<div class="box"><h2>Game over</h2>${rows}${last}
    <div class="row">
      ${isHost ? '<button class="btn primary" data-a="back">Play again</button>' : '<span class="hint">Waiting for the host to play again…</span>'}
      <button class="btn ghost" data-a="dismiss">Look at the table</button>
      <button class="btn ghost" data-a="leave">Leave</button>
    </div></div>`;
  els.results.hidden = false;
}

// ------------------------------------------------------------------ game: events and animation

function centerOf(el) { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

function sparkle(x, y) {
  if (reduceMotion) return;
  for (let i = 0; i < 9; i++) {
    const s = document.createElement('div');
    s.className = 'spark';
    fx.appendChild(s);
    const ang = (i / 9) * 6.283 + Math.random() * 0.5;
    const d = 26 + Math.random() * 26;
    s.animate([{ transform: `translate(${x}px,${y}px) scale(.4)`, opacity: 1 }, { transform: `translate(${x + Math.cos(ang) * d}px,${y + Math.sin(ang) * d}px) scale(1.1)`, opacity: 0 }], { duration: 520 + Math.random() * 200, easing: 'ease-out' }).onfinish = () => s.remove();
  }
}

function landFx() {
  const c = centerOf(els.pile);
  els.pile.classList.remove('thud');
  void els.pile.offsetWidth;
  els.pile.classList.add('thud');
  sparkle(c.x, c.y);
  sfx.thud();
}

function jokerSvg(e) {
  const eyes = {
    grin: '<ellipse cx="46" cy="62" rx="5" ry="6" fill="#2a1a3a"/><path d="M66 63q7-8 14 0" stroke="#2a1a3a" stroke-width="3.5" fill="none" stroke-linecap="round"/>',
    shock: '<circle cx="46" cy="61" r="8" fill="#fff" stroke="#2a1a3a" stroke-width="2.5"/><circle cx="74" cy="61" r="8" fill="#fff" stroke="#2a1a3a" stroke-width="2.5"/><circle cx="46" cy="62" r="3" fill="#2a1a3a"/><circle cx="74" cy="62" r="3" fill="#2a1a3a"/>',
    happy: '<path d="M39 64q7-9 14 0M67 64q7-9 14 0" stroke="#2a1a3a" stroke-width="3.5" fill="none" stroke-linecap="round"/>',
  };
  const mouth = {
    grin: '<path d="M40 80q20 22 40 0z" fill="#c4202f" stroke="#2a1a3a" stroke-width="2.5"/>',
    shock: '<ellipse cx="60" cy="88" rx="7" ry="9" fill="#5a0f1a" stroke="#2a1a3a" stroke-width="2.5"/>',
    happy: '<path d="M42 80q18 18 36 0" fill="none" stroke="#c4202f" stroke-width="5" stroke-linecap="round"/>',
  };
  return `<svg viewBox="0 0 120 120" aria-hidden="true"><path d="M28 50C8 40 6 12 22 6c3 14 12 22 24 26z" fill="#7b3fd1"/><path d="M92 50c20-10 22-38 6-44-3 14-12 22-24 26z" fill="#2fbf5f"/><path d="M40 34C46 14 56 8 60 6c4 2 14 8 20 28z" fill="#4b1f86"/><circle cx="22" cy="8" r="6" fill="#f2c14e"/><circle cx="98" cy="8" r="6" fill="#f2c14e"/><circle cx="60" cy="7" r="6" fill="#f2c14e"/><path d="M26 44h68v10H26z" fill="#f2c14e"/><ellipse cx="26" cy="72" rx="12" ry="20" fill="#2fbf5f"/><ellipse cx="94" cy="72" rx="12" ry="20" fill="#2fbf5f"/><ellipse cx="60" cy="72" rx="32" ry="34" fill="#fff" stroke="#2a1a3a" stroke-width="3"/>${eyes[e] || eyes.grin}<circle cx="60" cy="72" r="5" fill="#d4202f"/>${mouth[e] || mouth.grin}<path d="M30 108q30 14 60 0l-6-12H36z" fill="#f4e3b0" stroke="#b9791c" stroke-width="2"/></svg>`;
}

function setMascot(e, hold = 3500) {
  const m = $('#mascot');
  if (!m) return;
  m.dataset.ready = '1';
  m.className = `mascot ${e}`;
  m.innerHTML = jokerSvg(e);
  clearTimeout(mascotTimer);
  if (e !== 'grin') mascotTimer = setTimeout(() => setMascot('grin'), hold);
}

function fly(fromEl, toEl, count, delay = 0, land = false) {
  if (reduceMotion || !fromEl || !toEl) return;
  const a = centerOf(fromEl);
  const b = centerOf(toEl);
  for (let i = 0; i < Math.min(count, 6); i++) {
    const c = document.createElement('div');
    c.className = 'flycard back';
    fx.appendChild(c);
    const spread = (i - (Math.min(count, 6) - 1) / 2) * 6;
    const anim = c.animate([
      { transform: `translate(${a.x - 17 + spread}px, ${a.y - 24}px) rotate(-12deg) scale(0.75)`, opacity: 0.2 },
      { opacity: 1, offset: 0.25 },
      { transform: `translate(${b.x - 17}px, ${b.y - 24}px) rotate(${(i % 3) * 7 - 7}deg) scale(1)`, opacity: 1 },
    ], { duration: 460 + i * 70, delay: delay + i * 70, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' });
    anim.onfinish = () => { c.remove(); if (land && i === Math.min(count, 6) - 1) landFx(); };
  }
}

function detectEvents(prev, nm) {
  const pg = prev.game;
  const g = snap.game;
  if (g.stackSize > pg.stackSize && g.lastPlay) {
    fly(seatEls[g.lastPlay.playerId], els.pile, g.lastPlay.count, 0, true);
    setMascot('grin');
  } else if (pg.lastPlay && !g.lastPlay && g.lastCheck) {
    showReveal(g.lastCheck, nm);
  } else if (pg.lastPlay && !g.lastPlay && !g.lastCheck && pg.phase === 'playing') {
    toast('Everyone skipped. The pile is set aside, unseen.');
  } else if (g.lastPlay && pg.turn !== g.turn && g.stackSize === pg.stackSize) {
    sfx.skip();
  }
  if (g.finishedOrder.length > pg.finishedOrder.length || (g.phase === 'ended' && pg.phase !== 'ended')) setMascot('happy', 6000);
  if (g.turn === snap.youId && pg.turn !== snap.youId && g.phase === 'playing') sfx.turn();
}

function showReveal(lc, nm) {
  revealTimers.forEach(clearTimeout);
  revealTimers = [];
  const el = els.reveal;
  const claim = `${lc.declaredCount} ${rankLabel(lc.declaredRank, lc.declaredCount)}`;
  el.innerHTML = `<div class="rv-top">${esc(nm(lc.checkerId))} calls bluff on ${esc(nm(lc.accusedId))}</div>
    <div class="rv-claim">${esc(nm(lc.accusedId))} said ${claim}</div><div class="rv-top">Turning the cards over…</div>`;
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  const mine = lc.revealedCards;
  const wait = reduceMotion ? 200 : 1100;
  revealTimers.push(setTimeout(() => {
    const word = rankLabel(lc.declaredRank, 2);
    el.innerHTML = `<div class="rv-verdict ${lc.truthful ? 'truth' : 'lie'}">${lc.truthful ? 'Truth!' : 'Bluff!'}</div>
      <div>${lc.truthful ? `Every card was a ${esc(RANK_NAME[lc.declaredRank])} or a Joker.` : `Not all of those were ${esc(word)}.`}</div>
      <div class="rv-claim">${esc(nm(lc.loserId))} picks up ${lc.pickedUp} card${lc.pickedUp === 1 ? '' : 's'}</div>
      ${mine ? `<div class="rv-cards">${mine.map((c) => c.rank === 'JOKER' ? '<span class="mini joker pop">★</span>' : `<span class="mini ${c.suit === 'H' || c.suit === 'D' ? 'red' : ''}">${c.rank}${SUIT[c.suit]}</span>`).join('')}<small>Only you can see these cards.</small></div>`
        : `<small>Only ${esc(nm(lc.loserId))} sees the cards.</small>`}`;
    (lc.truthful ? sfx.truth : sfx.lie)();
    setMascot(lc.truthful ? 'grin' : 'shock');
    if (mine && mine.some((c) => c.rank === 'JOKER')) setTimeout(sfx.honk, 350); // only the loser sees the cards, so only they get the Joker gag
    fly(els.pile, seatEls[lc.loserId], lc.pickedUp);
  }, wait));
  revealTimers.push(setTimeout(() => { el.hidden = true; }, wait + (mine ? 6500 : 3800)));
}

// ------------------------------------------------------------------ events

document.addEventListener('input', (e) => {
  if (e.target.id === 'name') homeName = e.target.value;
  if (e.target.id === 'meetInput') meetDraft = e.target.value;
  if (e.target.id === 'code') { homeCode = e.target.value.toUpperCase(); e.target.value = homeCode; }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'meetInput') {
    send({ type: 'setMeet', link: e.target.value });
    meetDraft = null;
    return;
  }
  if (e.target.id === 'name' || e.target.id === 'code') {
    const btn = document.querySelector('[data-a="join"], [data-a="create"]');
    if (btn) btn.click();
  }
});

async function enterRoom(r) {
  if (!r.ok) { toast(r.error); return; }
  saveSession({ code: r.code, token: r.token });
  history.replaceState(null, '', location.pathname);
  homeCode = '';
  connect();
  render(null);
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-a]');
  if (!b) { if (e.target.closest('#reveal')) els.reveal.hidden = true; return; }
  const a = b.dataset.a;
  switch (a) {
    case 'create':
    case 'join': {
      const name = homeName.trim();
      if (!name) { toast('Enter your name first.'); const n = $('#name'); if (n) n.focus(); return; }
      if (a === 'join' && homeCode.length !== 5) { toast('Room codes have 5 letters.'); return; }
      b.disabled = true;
      const r = a === 'create' ? await post('/api/create', { name }) : await post('/api/join', { name, code: homeCode });
      b.disabled = false;
      await enterRoom(r);
      break;
    }
    case 'own': homeCode = ''; history.replaceState(null, '', location.pathname); renderHome(); break;
    case 'copy': {
      const text = b.dataset.text || `${location.origin}/?room=${snap.code}`;
      try { await navigator.clipboard.writeText(text); toast('Invite link copied.'); } catch { prompt('Copy this link:', text); }
      break;
    }
    case 'opt': {
      const v = b.dataset.v;
      send({ type: 'setOptions', [b.dataset.k]: v === 'null' ? null : Number(v) });
      break;
    }
    case 'meet-save': {
      const inp = $('#meetInput');
      send({ type: 'setMeet', link: inp ? inp.value : '' });
      meetDraft = null;
      if (inp && !inp.value.trim()) toast('Video link removed.');
      break;
    }
    case 'meet-edit': {
      const next = prompt('Paste your Google Meet link (leave empty to remove it):', snap.meetLink || 'https://meet.google.com/');
      if (next !== null) send({ type: 'setMeet', link: next });
      break;
    }
    case 'start': send({ type: 'start' }); break;
    case 'remove': send({ type: 'remove', targetId: b.dataset.id }); break;
    case 'back': send({ type: 'backToLobby' }); break;
    case 'dismiss': resultsDismissed = true; els.results.hidden = true; break;
    case 'leave': {
      if (snap && snap.phase === 'playing' && !confirm('Leave the game? Your cards will be set aside.')) return;
      send({ type: 'leave' });
      setTimeout(() => leaveLocal(''), 120);
      break;
    }
    case 'sound':
      muted = !muted;
      try { localStorage.setItem('bluff.muted', muted ? '1' : '0'); } catch { /* ignore */ }
      els.sound.textContent = muted ? 'Muted' : 'Sound';
      break;
    case 'card': {
      const id = Number(b.dataset.id);
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      if (!rankTouched && snap && snap.game && snap.game.you && !snap.game.stackRank) {
        const first = snap.game.you.hand.find((c) => selected.has(c.id) && c.rank !== 'JOKER');
        if (first) declRank = first.rank;
      }
      updateHand();
      updateControls();
      break;
    }
    case 'rank': declRank = b.dataset.r; rankTouched = true; updateControls(); break;
    case 'play':
      send({ type: 'play', cardIds: [...selected], rank: declRank });
      selected.clear();
      rankTouched = false;
      updateHand();
      updateControls();
      break;
    case 'peek': peek = !peek; els.hand.classList.toggle('peek', peek); b.textContent = peek ? 'Hide my cards' : 'Peek at all my cards'; break;
    case 'skip': send({ type: 'skip' }); break;
    case 'check': send({ type: 'check' }); break;
    default: break;
  }
});

render(null);
if (session) connect();
