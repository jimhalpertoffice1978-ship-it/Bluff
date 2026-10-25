// Bluff rules engine. Pure logic: no network, no browser. State in, state out.
// Implements "Bluff Card Game: Final Rule Spec v1".
import { randomInt } from 'node:crypto';

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS = ['S', 'H', 'D', 'C'];
export const JOKER = 'JOKER';
export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 10;

// rng(max) must return an integer in [0, max). Default is cryptographically secure.
const defaultRng = (max) => randomInt(max);

export function recommendedDecks(playerCount) {
  return playerCount <= 5 ? 1 : 2;
}

export function buildDeck(deckCount) {
  const cards = [];
  let id = 0;
  for (let d = 0; d < deckCount; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) cards.push({ id: id++, rank, suit });
    }
    for (let j = 0; j < 3; j++) cards.push({ id: id++, rank: JOKER, suit: null });
  }
  return cards;
}

export function shuffle(cards, rng = defaultRng) {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------- helpers

const clone = (s) => structuredClone(s);
const fail = (error) => ({ ok: false, error });
const findPlayer = (s, id) => s.players.find((p) => p.id === id);
const activeCount = (s) => s.players.filter((p) => p.status === 'active').length;

// Next player with status 'active' after `id` in seating order (clockwise).
function nextActiveAfter(s, id, inclusive = false) {
  const n = s.players.length;
  const start = s.players.findIndex((p) => p.id === id);
  for (let k = inclusive ? 0 : 1; k <= n; k++) {
    const p = s.players[(start + k) % n];
    if (p.status === 'active') return p.id;
  }
  return null;
}

// A player who went out last turn is confirmed out once the next player acts.
function confirmPending(s) {
  if (!s.pendingOutId) return;
  const p = findPlayer(s, s.pendingOutId);
  p.status = 'finished';
  s.finishedOrder.push(p.id);
  s.pendingOutId = null;
}

// Game ends when at most one player still holds cards (and nobody is pending).
function endIfOver(s) {
  if (s.pendingOutId) return false;
  const holders = s.players.filter((p) => p.status === 'active');
  if (holders.length <= 1) {
    s.phase = 'ended';
    s.turn = null;
    s.loserId = holders.length === 1 ? holders[0].id : null;
    return true;
  }
  return false;
}

// Everyone skipped in a full round: the stack is set aside unrevealed.
function resetStackBySkips(s) {
  const lastPlayerId = s.lastPlay.playerId;
  s.setAside.push(...s.stack);
  s.stack = [];
  s.stackRank = null;
  s.lastPlay = null;
  s.skipsInRow = 0;
  s.turn = nextActiveAfter(s, lastPlayerId);
}

// ---------------------------------------------------------------- setup

export function createGame(players, options = {}) {
  const rng = options.rng || defaultRng;
  const n = players.length;
  if (n < MIN_PLAYERS || n > MAX_PLAYERS) {
    throw new Error(`Bluff needs ${MIN_PLAYERS} to ${MAX_PLAYERS} players (got ${n}).`);
  }
  if (new Set(players.map((p) => p.id)).size !== n) throw new Error('Player ids must be unique.');
  const deckCount = options.deckCount ?? recommendedDecks(n);
  if (!Number.isInteger(deckCount) || deckCount < 1) throw new Error('deckCount must be a whole number >= 1.');

  const deck = shuffle(buildDeck(deckCount), rng);
  const perPlayer = Math.floor(deck.length / n);
  const seated = players.map((p, i) => ({
    id: p.id,
    name: p.name,
    hand: deck.slice(i * perPlayer, (i + 1) * perPlayer),
    status: 'active', // active | pending | finished | removed
  }));

  return {
    phase: 'playing', // playing | ended
    deckCount,
    totalCards: deck.length,
    players: seated,
    stack: [],
    stackRank: null, // the rank everyone must claim until the stack is cleared
    lastPlay: null, // { playerId, rank, count, cards }
    turn: seated[rng(n)].id,
    skipsInRow: 0,
    pendingOutId: null,
    finishedOrder: [],
    loserId: null,
    setAside: deck.slice(perPlayer * n), // leftovers, never revealed
    lastCheck: null,
  };
}

// ---------------------------------------------------------------- actions

// action: { type: 'play', cardIds: [..], rank: 'K' } | { type: 'skip' } | { type: 'check' }
// returns { ok: true, state } or { ok: false, error }
export function applyAction(state, playerId, action) {
  if (state.phase !== 'playing') return fail('The game is over.');
  if (state.turn !== playerId) return fail('It is not your turn.');
  if (!action || typeof action !== 'object') return fail('Invalid action.');

  const me = findPlayer(state, playerId);
  const starting = state.stack.length === 0;

  switch (action.type) {
    case 'play': {
      if (!RANKS.includes(action.rank)) return fail('Declare a rank from A to K.');
      if (state.stackRank && action.rank !== state.stackRank) {
        return fail(`This stack is on ${state.stackRank}. You must claim ${state.stackRank}.`);
      }
      const ids = action.cardIds;
      if (!Array.isArray(ids) || ids.length < 1) return fail('Play at least one card.');
      if (new Set(ids).size !== ids.length) return fail('Duplicate cards selected.');
      const handIds = new Set(me.hand.map((c) => c.id));
      if (!ids.every((id) => handIds.has(id))) return fail('You do not hold those cards.');

      const s = clone(state);
      confirmPending(s);
      if (endIfOver(s)) return { ok: true, state: s };
      const mine = findPlayer(s, playerId);
      const chosen = new Set(ids);
      const played = mine.hand.filter((c) => chosen.has(c.id));
      mine.hand = mine.hand.filter((c) => !chosen.has(c.id));
      s.stack.push(...played);
      if (!s.stackRank) s.stackRank = action.rank; // the first play sets the rank
      s.lastPlay = { playerId, rank: action.rank, count: played.length, cards: played };
      s.skipsInRow = 0;
      s.lastCheck = null;
      if (mine.hand.length === 0) {
        mine.status = 'pending';
        s.pendingOutId = playerId;
      }
      s.turn = nextActiveAfter(s, playerId);
      return { ok: true, state: s };
    }

    case 'skip': {
      if (starting) return fail('You are starting a new stack, so you must play cards.');
      const s = clone(state);
      confirmPending(s);
      if (endIfOver(s)) return { ok: true, state: s };
      s.skipsInRow += 1;
      if (s.skipsInRow >= activeCount(s)) resetStackBySkips(s);
      else s.turn = nextActiveAfter(s, playerId);
      return { ok: true, state: s };
    }

    case 'check': {
      if (starting || !state.lastPlay) return fail('There is nothing to check.');
      if (state.lastPlay.playerId === playerId) return fail('Everyone skipped, so you cannot call bluff on your own play. Play more cards or skip.');
      const s = clone(state);
      const { playerId: accusedId, rank, count, cards } = s.lastPlay;
      const accused = findPlayer(s, accusedId);
      const checker = findPlayer(s, playerId);
      const truthful = cards.every((c) => c.rank === JOKER || c.rank === rank);
      const loser = truthful ? checker : accused;
      const winner = truthful ? accused : checker;

      const pickedUp = s.stack.length;
      if (loser.status === 'removed') s.setAside.push(...s.stack);
      else loser.hand.push(...s.stack);
      s.stack = [];
      s.stackRank = null;
      s.lastPlay = null;
      s.skipsInRow = 0;
      s.lastCheck = {
        checkerId: playerId,
        accusedId,
        truthful,
        loserId: loser.id,
        pickedUp,
        declaredRank: rank,
        declaredCount: count,
        revealed: cards,
      };

      if (s.pendingOutId) {
        if (truthful) confirmPending(s);
        else {
          accused.status = 'active'; // caught bluffing their last cards
          s.pendingOutId = null;
        }
      }
      if (endIfOver(s)) return { ok: true, state: s };
      s.turn = nextActiveAfter(s, winner.id, true);
      return { ok: true, state: s };
    }

    default:
      return fail('Unknown action.');
  }
}

// Host removes a player (or the server gives up on a disconnected one).
export function removePlayer(state, playerId) {
  const target = findPlayer(state, playerId);
  if (!target || state.phase !== 'playing') return fail('Cannot remove that player.');
  if (target.status === 'removed' || target.status === 'finished') return { ok: true, state };

  const s = clone(state);
  const p = findPlayer(s, playerId);
  const hadTurn = s.turn === playerId;
  s.setAside.push(...p.hand);
  p.hand = [];
  if (s.pendingOutId === playerId) s.pendingOutId = null;
  p.status = 'removed';

  if (s.pendingOutId && activeCount(s) === 0) confirmPending(s); // nobody left to check them
  if (endIfOver(s)) return { ok: true, state: s };
  if (hadTurn) s.turn = nextActiveAfter(s, playerId);
  if (s.lastPlay && s.skipsInRow >= activeCount(s)) resetStackBySkips(s);
  return { ok: true, state: s };
}

// What the server plays for a player who timed out or is disconnected:
// skip if allowed, otherwise play one card honestly.
export function autoAction(state, playerId) {
  if (state.phase !== 'playing' || state.turn !== playerId) return null;
  if (state.stack.length > 0) return { type: 'skip' };
  const me = findPlayer(state, playerId);
  const real = me.hand.find((c) => c.rank !== JOKER);
  return { type: 'play', cardIds: [(real ?? me.hand[0]).id], rank: real ? real.rank : 'A' };
}

// ---------------------------------------------------------------- views

// The ONLY thing a player's browser should ever receive. Hidden info stays on the server.
export function viewFor(state, viewerId) {
  const me = findPlayer(state, viewerId);
  const myTurn = state.phase === 'playing' && state.turn === viewerId;
  const lc = state.lastCheck;
  return {
    phase: state.phase,
    deckCount: state.deckCount,
    totalCards: state.totalCards,
    setAsideCount: state.setAside.length,
    turn: state.turn,
    stackSize: state.stack.length,
    stackRank: state.stackRank,
    lastPlay: state.lastPlay
      ? { playerId: state.lastPlay.playerId, rank: state.lastPlay.rank, count: state.lastPlay.count }
      : null,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      cardCount: p.hand.length,
      status: p.status,
    })),
    finishedOrder: state.finishedOrder,
    loserId: state.loserId,
    lastCheck: lc
      ? {
          checkerId: lc.checkerId,
          accusedId: lc.accusedId,
          truthful: lc.truthful,
          loserId: lc.loserId,
          pickedUp: lc.pickedUp,
          declaredRank: lc.declaredRank,
          declaredCount: lc.declaredCount,
          revealedCards: viewerId === lc.loserId ? lc.revealed : null, // loser only
        }
      : null,
    you: me
      ? {
          id: me.id,
          hand: me.hand,
          canPlay: myTurn,
          canSkip: myTurn && state.stack.length > 0,
          canCheck: myTurn && state.stack.length > 0 && !!state.lastPlay && state.lastPlay.playerId !== viewerId,
        }
      : null,
  };
}

// For tests and debugging: every card must be somewhere, exactly once.
export function countCards(state) {
  const ids = [];
  for (const p of state.players) for (const c of p.hand) ids.push(c.id);
  for (const c of state.stack) ids.push(c.id);
  for (const c of state.setAside) ids.push(c.id);
  return { total: ids.length, unique: new Set(ids).size };
}
