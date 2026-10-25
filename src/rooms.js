// Room manager: lobbies, seats, the game, timers. No networking in here, so it is easy to test.
import { randomBytes, randomInt } from 'node:crypto';
import {
  createGame, applyAction, removePlayer, autoAction, viewFor, recommendedDecks,
  MIN_PLAYERS, MAX_PLAYERS,
} from './engine.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O (look like 1 and 0)
const MAX_NAME = 20;

const fail = (error) => ({ ok: false, error });

// Only genuine Google Meet links are accepted, and the stored link is rebuilt from the
// matched code, so nothing else a player types can ever be shown to the others.
export function normalizeMeetLink(raw) {
  if (raw === null || raw === undefined) return { ok: true, link: null };
  if (typeof raw !== 'string') return { ok: false };
  let s = raw.trim();
  if (!s) return { ok: true, link: null };
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false };
  }
  if (u.hostname !== 'meet.google.com') return { ok: false };
  const code = u.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/i);
  if (code) return { ok: true, link: `https://meet.google.com/${code[1].toLowerCase()}` };
  const lookup = u.pathname.match(/^\/lookup\/([A-Za-z0-9_-]{4,64})\/?$/);
  if (lookup) return { ok: true, link: `https://meet.google.com/lookup/${lookup[1]}` };
  return { ok: false };
}

function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const n = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return n.length ? n : null;
}

export class RoomManager {
  constructor(opts = {}) {
    this.now = opts.now || Date.now;
    this.gameRng = opts.gameRng; // optional seeded rng, for tests
    this.graceMs = opts.graceMs ?? 30_000; // how long a disconnected player may hold up the table
    this.idleMs = opts.idleMs ?? 2 * 60 * 60 * 1000; // empty rooms are deleted after this
    this.onChange = opts.onChange || (() => {});
    this.onRoomDeleted = opts.onRoomDeleted || (() => {});
    this.rooms = new Map(); // code -> room
    this.tokens = new Map(); // secret token -> { code, playerId }
  }

  // ------------------------------------------------------------ lookups

  _auth(token) {
    const t = this.tokens.get(token);
    if (!t) return null;
    const room = this.rooms.get(t.code);
    if (!room) {
      this.tokens.delete(token);
      return null;
    }
    const player = room.players.find((p) => p.id === t.playerId && !p.gone);
    return player ? { room, player } : null;
  }

  _touch(room) {
    room.rev += 1;
    room.lastActivity = this.now();
    this.onChange(room.code);
  }

  _newCode() {
    for (let i = 0; i < 200; i++) {
      let code = '';
      for (let k = 0; k < 5; k++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('Could not allocate a room code.');
  }

  _addPlayer(room, name) {
    const player = {
      id: randomBytes(4).toString('hex'),
      name,
      connected: false,
      disconnectedAt: this.now(),
      gone: false,
    };
    const token = randomBytes(24).toString('hex');
    room.players.push(player);
    this.tokens.set(token, { code: room.code, playerId: player.id });
    return { player, token };
  }

  // ------------------------------------------------------------ create / join

  createRoom(rawName) {
    const name = cleanName(rawName);
    if (!name) return fail('Enter a name (1 to 20 characters).');
    const room = {
      code: this._newCode(),
      hostId: null,
      players: [],
      options: { deckCount: null, turnTimerSec: 0 },
      meetLink: null,
      phase: 'lobby', // lobby | playing | ended
      game: null,
      turnStartedAt: null,
      rev: 0,
      lastActivity: this.now(),
    };
    const { player, token } = this._addPlayer(room, name);
    room.hostId = player.id;
    this.rooms.set(room.code, room);
    return { ok: true, code: room.code, token, playerId: player.id };
  }

  joinRoom(rawCode, rawName) {
    const name = cleanName(rawName);
    if (!name) return fail('Enter a name (1 to 20 characters).');
    const code = String(rawCode || '').trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room) return fail('No room with that code.');
    if (room.phase !== 'lobby') return fail('That game has already started.');
    if (room.players.length >= MAX_PLAYERS) return fail(`The room is full (${MAX_PLAYERS} players).`);
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return fail('That name is taken in this room. Pick another.');
    }
    const { player, token } = this._addPlayer(room, name);
    this._touch(room);
    return { ok: true, code: room.code, token, playerId: player.id };
  }

  // ------------------------------------------------------------ connection state

  markConnected(token, connected) {
    const a = this._auth(token);
    if (!a) return false;
    a.player.connected = connected;
    if (!connected) a.player.disconnectedAt = this.now();
    this._touch(a.room);
    return true;
  }

  // ------------------------------------------------------------ snapshots

  snapshot(token) {
    const a = this._auth(token);
    if (!a) return fail('Session expired. Please join again.');
    const { room, player } = a;
    const timerMs = room.options.turnTimerSec * 1000;
    return {
      ok: true,
      snapshot: {
        rev: room.rev,
        code: room.code,
        youId: player.id,
        hostId: room.hostId,
        phase: room.phase,
        options: room.options,
        meetLink: room.meetLink,
        recommendedDecks: recommendedDecks(Math.max(room.players.length, MIN_PLAYERS)),
        players: room.players.map((p) => ({
          id: p.id, name: p.name, connected: p.connected, isHost: p.id === room.hostId, gone: p.gone,
        })),
        game: room.game ? viewFor(room.game, player.id) : null,
        serverNow: this.now(),
        turnDeadline: room.phase === 'playing' && timerMs > 0 ? room.turnStartedAt + timerMs : null,
      },
    };
  }

  // ------------------------------------------------------------ actions

  act(token, msg) {
    const a = this._auth(token);
    if (!a) return fail('Session expired. Please join again.');
    if (!msg || typeof msg !== 'object') return fail('Invalid message.');
    const { room, player } = a;
    const isHost = room.hostId === player.id;

    switch (msg.type) {
      case 'setOptions': {
        if (!isHost) return fail('Only the host can change settings.');
        if (room.phase !== 'lobby') return fail('Settings are locked once the game starts.');
        const next = { ...room.options };
        if ('deckCount' in msg) {
          const d = msg.deckCount;
          if (d !== null && !(Number.isInteger(d) && d >= 1 && d <= 4)) return fail('Decks must be 1 to 4, or automatic.');
          next.deckCount = d;
        }
        if ('turnTimerSec' in msg) {
          const t = msg.turnTimerSec;
          if (!(t === 0 || (Number.isInteger(t) && t >= 10 && t <= 300))) return fail('Turn timer must be off or 10 to 300 seconds.');
          next.turnTimerSec = t;
        }
        room.options = next;
        this._touch(room);
        return { ok: true };
      }

      case 'setMeet': {
        if (!isHost) return fail('Only the host can set the video link.');
        const m = normalizeMeetLink(msg.link);
        if (!m.ok) return fail('That is not a Google Meet link. It should look like https://meet.google.com/abc-defg-hij');
        room.meetLink = m.link;
        this._touch(room);
        return { ok: true };
      }

      case 'start': {
        if (!isHost) return fail('Only the host can start the game.');
        if (room.phase !== 'lobby') return fail('The game has already started.');
        const seated = room.players.filter((p) => !p.gone);
        if (seated.length < MIN_PLAYERS) return fail(`Need at least ${MIN_PLAYERS} players to start.`);
        room.game = createGame(
          seated.map((p) => ({ id: p.id, name: p.name })),
          { deckCount: room.options.deckCount ?? undefined, rng: this.gameRng },
        );
        room.phase = 'playing';
        room.turnStartedAt = this.now();
        this._touch(room);
        return { ok: true };
      }

      case 'play':
      case 'skip':
      case 'check': {
        if (room.phase !== 'playing') return fail('The game is not in progress.');
        const action = { type: msg.type };
        if (msg.type === 'play') {
          action.cardIds = msg.cardIds;
          action.rank = msg.rank;
        }
        const r = this._applyGame(room, player.id, action);
        if (!r.ok) return r;
        this._touch(room);
        return { ok: true };
      }

      case 'remove': {
        if (!isHost) return fail('Only the host can remove players.');
        const target = room.players.find((p) => p.id === msg.targetId && !p.gone);
        if (!target) return fail('That player is not in the room.');
        if (target.id === player.id) return fail('Use Leave to leave the room yourself.');
        this._removeFromRoom(room, target);
        return { ok: true };
      }

      case 'leave': {
        this._removeFromRoom(room, player);
        return { ok: true };
      }

      case 'backToLobby': {
        if (!isHost) return fail('Only the host can do that.');
        if (room.phase !== 'ended') return fail('The game is not over yet.');
        room.players = room.players.filter((p) => !p.gone);
        room.game = null;
        room.phase = 'lobby';
        room.turnStartedAt = null;
        this._touch(room);
        return { ok: true };
      }

      default:
        return fail('Unknown action.');
    }
  }

  _applyGame(room, playerId, action) {
    const r = applyAction(room.game, playerId, action);
    if (!r.ok) return r;
    room.game = r.state;
    room.turnStartedAt = this.now();
    if (room.game.phase === 'ended') room.phase = 'ended';
    return r;
  }

  // Used for leaving and for host removal.
  _removeFromRoom(room, target) {
    for (const [tok, t] of this.tokens) {
      if (t.code === room.code && t.playerId === target.id) this.tokens.delete(tok);
    }
    target.connected = false;
    if (room.phase === 'lobby') {
      room.players = room.players.filter((p) => p.id !== target.id);
    } else {
      target.gone = true; // keep the record so results still show their name
      if (room.phase === 'playing') {
        const r = removePlayer(room.game, target.id);
        if (r.ok) {
          room.game = r.state;
          room.turnStartedAt = this.now();
          if (room.game.phase === 'ended') room.phase = 'ended';
        }
      }
    }
    const remaining = room.players.filter((p) => !p.gone);
    if (remaining.length === 0) {
      this._deleteRoom(room);
      return;
    }
    if (room.hostId === target.id) room.hostId = remaining[0].id;
    this._touch(room);
  }

  _deleteRoom(room) {
    this.rooms.delete(room.code);
    for (const [tok, t] of this.tokens) if (t.code === room.code) this.tokens.delete(tok);
    this.onRoomDeleted(room.code);
  }

  // ------------------------------------------------------------ timers (call about once a second)

  tick() {
    const now = this.now();
    for (const room of [...this.rooms.values()]) {
      if (room.phase === 'playing') {
        const g = room.game;
        const p = room.players.find((x) => x.id === g.turn);
        if (p) {
          const timerMs = room.options.turnTimerSec * 1000;
          const timedOut = timerMs > 0 && now - room.turnStartedAt >= timerMs;
          const since = Math.max(room.turnStartedAt, p.disconnectedAt || 0);
          const absent = !p.connected && now - since >= this.graceMs;
          if (timedOut || absent) {
            const action = autoAction(g, p.id);
            if (action && this._applyGame(room, p.id, action).ok) this._touch(room);
          }
        }
      }
      const anyoneOnline = room.players.some((p) => p.connected && !p.gone);
      if (!anyoneOnline && now - room.lastActivity > this.idleMs) this._deleteRoom(room);
    }
  }
}
