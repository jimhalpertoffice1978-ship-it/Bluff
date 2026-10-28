import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RANKS, JOKER, buildDeck, createGame, applyAction, removePlayer, autoAction, viewFor, countCards,
} from '../src/engine.js';

// ---------- helpers for hand-built situations

let nextId = 10000;
const card = (rank) => ({ id: nextId++, rank, suit: rank === JOKER ? null : 'S' });

// make([['K','K','5'], ['3','3'], ...], turnIndex) builds a state with exact hands.
function make(handRanks, turnIndex = 0) {
  const players = handRanks.map((ranks, i) => ({
    id: `p${i}`, name: `P${i}`, hand: ranks.map(card), status: 'active',
  }));
  return {
    phase: 'playing', deckCount: 1,
    totalCards: players.reduce((n, p) => n + p.hand.length, 0),
    players, stack: [], stackRank: null, lastPlay: null, turn: `p${turnIndex}`, skipsInRow: 0,
    pendingOutId: null, finishedOrder: [], loserId: null, setAside: [], lastCheck: null,
  };
}
const P = (s, id) => s.players.find((p) => p.id === id);
// Play the first cards of the given ranks from the player's hand, declaring `declared`.
function playRanks(s, id, ranks, declared) {
  const hand = [...P(s, id).hand];
  const ids = ranks.map((r) => {
    const i = hand.findIndex((c) => c.rank === r);
    return hand.splice(i, 1)[0].id;
  });
  return { type: 'play', cardIds: ids, rank: declared };
}
function act(s, id, action) {
  const r = applyAction(s, id, action);
  assert.ok(r.ok, r.error);
  return r.state;
}

// ---------- deck and setup

test('a deck has 55 cards including 3 jokers; decks multiply', () => {
  const d = buildDeck(2);
  assert.equal(d.length, 110);
  assert.equal(d.filter((c) => c.rank === JOKER).length, 6);
  assert.equal(new Set(d.map((c) => c.id)).size, 110);
});

test('deal is equal and leftovers are set aside', () => {
  const g = createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], { deckCount: 1 });
  assert.deepEqual(g.players.map((p) => p.hand.length), [18, 18, 18]);
  assert.equal(g.setAside.length, 1);
  const eight = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
  const g2 = createGame(eight, { deckCount: 1 });
  assert.equal(g2.players[0].hand.length, 6);
  assert.equal(g2.setAside.length, 7);
  assert.deepEqual(countCards(g2), { total: 55, unique: 55 });
});

test('player count must be 3 to 10', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
  assert.throws(() => createGame(mk(2)));
  assert.throws(() => createGame(mk(11)));
  assert.doesNotThrow(() => createGame(mk(10)));
});

// ---------- turn validation

test('cannot act out of turn, skip when starting, or play cards you do not hold', () => {
  const s = make([['K', '5'], ['3', '3'], ['4', '4']]);
  assert.equal(applyAction(s, 'p1', { type: 'skip' }).ok, false);
  assert.equal(applyAction(s, 'p0', { type: 'skip' }).ok, false);
  assert.equal(applyAction(s, 'p0', { type: 'check' }).ok, false);
  assert.equal(applyAction(s, 'p0', { type: 'play', cardIds: [P(s, 'p1').hand[0].id], rank: 'K' }).ok, false);
  assert.equal(applyAction(s, 'p0', { type: 'play', cardIds: [], rank: 'K' }).ok, false);
  assert.equal(applyAction(s, 'p0', { type: 'play', cardIds: [P(s, 'p0').hand[0].id], rank: JOKER }).ok, false);
});

// ---------- checking

test('truthful play: the checker loses, picks up the stack, and the truth-teller starts', () => {
  let s = make([['K', 'K', '5'], ['3', '3', '9'], ['7', '7', '7']]);
  s = act(s, 'p0', playRanks(s, 'p0', ['K', 'K'], 'K'));
  assert.equal(s.turn, 'p1');
  s = act(s, 'p1', { type: 'check' });
  assert.equal(s.lastCheck.truthful, true);
  assert.equal(s.lastCheck.loserId, 'p1');
  assert.equal(P(s, 'p1').hand.length, 5);
  assert.equal(s.stack.length, 0);
  assert.equal(s.turn, 'p0');
});

test('bluff caught: the bluffer picks up the WHOLE stack and the checker starts', () => {
  let s = make([['K', '5', '5'], ['3', '9', '9'], ['7', '7', '7']]);
  s = act(s, 'p0', playRanks(s, 'p0', ['5'], 'K')); // lie
  s = act(s, 'p1', playRanks(s, 'p1', ['9'], 'K')); // lie
  s = act(s, 'p2', { type: 'check' });
  assert.equal(s.lastCheck.truthful, false);
  assert.equal(s.lastCheck.loserId, 'p1');
  assert.equal(P(s, 'p1').hand.length, 2 + 2); // 2 left + whole stack of 2
  assert.equal(s.turn, 'p2');
});

test('only the most recent play is judged', () => {
  let s = make([['K', '5'], ['K', '9', '9'], ['7', '7', '7']]);
  s = act(s, 'p0', playRanks(s, 'p0', ['5'], 'K')); // a lie, but gets away with it
  s = act(s, 'p1', playRanks(s, 'p1', ['K'], 'K')); // truth
  s = act(s, 'p2', { type: 'check' });
  assert.equal(s.lastCheck.truthful, true);
  assert.equal(s.lastCheck.loserId, 'p2');
  assert.equal(P(s, 'p2').hand.length, 3 + 2);
});

test('jokers count as truth, alone or mixed', () => {
  let s = make([[JOKER, 'K', '5'], ['3', '3', '9'], ['7', '7', '7']]);
  s = act(s, 'p0', playRanks(s, 'p0', ['K', JOKER], 'K'));
  s = act(s, 'p1', { type: 'check' });
  assert.equal(s.lastCheck.truthful, true);
  let t = make([[JOKER, '5', '5'], ['3', '3', '9'], ['7', '7', '7']]);
  t = act(t, 'p0', playRanks(t, 'p0', [JOKER], '9'));
  t = act(t, 'p1', { type: 'check' });
  assert.equal(t.lastCheck.truthful, true);
});

test('declared quantity always equals cards played', () => {
  let s = make([['K', 'K', '5'], ['3'], ['7']]);
  s = act(s, 'p0', playRanks(s, 'p0', ['K', 'K'], 'K'));
  assert.equal(s.lastPlay.count, 2);
});

// ---------- the stack rank is locked by the first play

test('the first play sets the rank and everyone after must claim the same rank', () => {
  let s = make([['K', 'K', '5'], ['3', '3', '9'], ['7', '7', '7']]);
  assert.equal(s.stackRank, null);
  s = act(s, 'p0', playRanks(s, 'p0', ['K', 'K'], 'K'));
  assert.equal(s.stackRank, 'K');
  const bad = applyAction(s, 'p1', playRanks(s, 'p1', ['3'], '3'));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /K/);
  s = act(s, 'p1', playRanks(s, 'p1', ['3'], 'K')); // lying about it is fine, switching rank is not
  assert.equal(s.stackRank, 'K');
  assert.equal(viewFor(s, 'p2').stackRank, 'K');
});

test('the rank is free again after a check', () => {
  let s = make([['K', '5', '5'], ['3', '3', '9'], ['7', '7', '7']]);
  s = act(s, 'p0', playRanks(s, 'p0', ['K'], 'K'));
  s = act(s, 'p1', { type: 'check' });
  assert.equal(s.stackRank, null);
  s = act(s, 'p0', playRanks(s, 'p0', ['5'], '5')); // winner starts the new stack with any rank
  assert.equal(s.stackRank, '5');
});

test('the rank is free again after a full round of skips', () => {
  let s = make([['5', '6'], ['2', '2'], ['3', '3']]);
  s = act(s, 'p0', playRanks(s, 'p0', ['5'], '5'));
  s = act(s, 'p1', { type: 'skip' });
  s = act(s, 'p2', { type: 'skip' });
  s = act(s, 'p0', { type: 'skip' });
  assert.equal(s.stackRank, null);
  s = act(s, 'p1', playRanks(s, 'p1', ['2'], '2'));
  assert.equal(s.stackRank, '2');
});

// ---------- no checking your own play after everyone skipped

test('when everyone skips and the turn returns to the last player, they cannot check; they can play again or skip', () => {
  let s = make([['5', '5', '6'], ['2', '2'], ['3', '3']]);
  s = act(s, 'p0', playRanks(s, 'p0', ['5'], '5'));
  s = act(s, 'p1', { type: 'skip' });
  s = act(s, 'p2', { type: 'skip' });
  assert.equal(s.turn, 'p0');
  const r = applyAction(s, 'p0', { type: 'check' });
  assert.equal(r.ok, false);
  assert.match(r.error, /own play/);
  const v = viewFor(s, 'p0').you;
  assert.equal(v.canCheck, false);
  assert.equal(v.canSkip, true);
  assert.equal(viewFor(s, 'p1').you.canCheck, false); // not their turn
  const again = act(s, 'p0', playRanks(s, 'p0', ['5'], '5')); // playing again is allowed
  assert.equal(again.stack.length, 2);
  assert.equal(again.turn, 'p1');
  assert.equal(viewFor(again, 'p1').you.canCheck, true); // the next player can check as usual
  const cleared = act(s, 'p0', { type: 'skip' }); // skipping clears the stack
  assert.equal(cleared.stack.length, 0);
  assert.equal(cleared.stackRank, null);
});

// ---------- privacy

test('checked cards are revealed only to the loser', () => {
  let s = make([['K', '5', '5'], ['3', '3', '9'], ['7', '7', '7']]);
  s = act(s, 'p0', playRanks(s, 'p0', ['5'], 'K'));
  s = act(s, 'p1', { type: 'check' });
  assert.ok(viewFor(s, 'p0').lastCheck.revealedCards); // p0 was the loser
  assert.equal(viewFor(s, 'p1').lastCheck.revealedCards, null);
  assert.equal(viewFor(s, 'p2').lastCheck.revealedCards, null);
});

test('views never leak other hands or the stack contents', () => {
  const s = make([['K', '5'], ['3', '9'], ['7', '7']]);
  const text = JSON.stringify(viewFor(s, 'p0'));
  assert.ok(!text.includes('"hand":[{"id":' + P(s, 'p1').hand[0].id));
  const v = viewFor(s, 'p0');
  assert.equal(v.players.find((p) => p.id === 'p1').cardCount, 2);
  assert.equal(v.players.find((p) => p.id === 'p1').hand, undefined);
});

// ---------- skipping

test('full round of skips sets the stack aside unrevealed; player after the last player starts', () => {
  let s = make([['5', '6'], ['2', '2'], ['3', '3']]);
  s = act(s, 'p0', playRanks(s, 'p0', ['5'], '5'));
  s = act(s, 'p1', { type: 'skip' });
  s = act(s, 'p2', { type: 'skip' });
  assert.equal(s.stack.length, 1);
  s = act(s, 'p0', { type: 'skip' });
  assert.equal(s.stack.length, 0);
  assert.equal(s.setAside.length, 1);
  assert.equal(s.turn, 'p1');
  assert.equal(applyAction(s, 'p1', { type: 'skip' }).ok, false); // must play on a fresh stack
});

// ---------- going out

test('going out is confirmed when the next player skips', () => {
  let s = make([['K'], ['3', '3'], ['4', '4']]);
  s = act(s, 'p0', playRanks(s, 'p0', ['K'], 'K'));
  assert.equal(s.pendingOutId, 'p0');
  assert.deepEqual(s.finishedOrder, []);
  s = act(s, 'p1', { type: 'skip' });
  assert.deepEqual(s.finishedOrder, ['p0']);
  assert.equal(P(s, 'p0').status, 'finished');
  assert.equal(s.turn, 'p2');
});

test('going out with a bluff: caught, picks up the stack, stays in the game', () => {
  let s = make([['5'], ['3', '3'], ['4', '4']]);
  s = act(s, 'p0', playRanks(s, 'p0', ['5'], 'K'));
  s = act(s, 'p1', { type: 'check' });
  assert.equal(P(s, 'p0').status, 'active');
  assert.equal(P(s, 'p0').hand.length, 1);
  assert.deepEqual(s.finishedOrder, []);
  assert.equal(s.turn, 'p1');
});

test('going out with the truth: checked and confirmed', () => {
  let s = make([['K'], ['3', '3'], ['4', '4']]);
  s = act(s, 'p0', playRanks(s, 'p0', ['K'], 'K'));
  s = act(s, 'p1', { type: 'check' });
  assert.deepEqual(s.finishedOrder, ['p0']);
  assert.equal(P(s, 'p1').hand.length, 3);
  assert.equal(s.turn, 'p1'); // winner already out, so the next active player starts
});

test('a finished player is skipped in the rotation', () => {
  let s = make([['K'], ['3', '3'], ['4', '4']]);
  s = act(s, 'p0', playRanks(s, 'p0', ['K'], 'K'));
  s = act(s, 'p1', { type: 'skip' });
  s = act(s, 'p2', playRanks(s, 'p2', ['4'], 'K'));
  assert.equal(s.turn, 'p1'); // p0 is out, so it goes back to p1
});

test('the game ends when one player is left holding cards', () => {
  let s = make([['K'], ['K'], ['4', '4']]);
  s = act(s, 'p0', playRanks(s, 'p0', ['K'], 'K'));
  s = act(s, 'p1', playRanks(s, 'p1', ['K'], 'K'));
  assert.deepEqual(s.finishedOrder, ['p0']);
  assert.equal(s.phase, 'playing');
  s = act(s, 'p2', { type: 'skip' });
  assert.equal(s.phase, 'ended');
  assert.deepEqual(s.finishedOrder, ['p0', 'p1']);
  assert.equal(s.loserId, 'p2');
  assert.equal(applyAction(s, 'p2', { type: 'skip' }).ok, false);
});

// ---------- removal and auto actions

test('removing a player sets their cards aside and passes the turn', () => {
  let s = make([['K', '5'], ['3', '3'], ['4', '4']], 1);
  const r = removePlayer(s, 'p1');
  assert.ok(r.ok);
  s = r.state;
  assert.equal(P(s, 'p1').status, 'removed');
  assert.equal(s.setAside.length, 2);
  assert.equal(s.turn, 'p2');
  assert.deepEqual(countCards(s), { total: 6, unique: 6 });
});

test('removing down to one player ends the game', () => {
  let s = make([['K', '5'], ['3', '3'], ['4', '4']]);
  s = removePlayer(s, 'p1').state;
  s = removePlayer(s, 'p2').state;
  assert.equal(s.phase, 'ended');
  assert.equal(s.loserId, 'p0');
});

test('autoAction skips when allowed, otherwise plays one card honestly', () => {
  let s = make([['K', '5'], ['3', '3'], ['4', '4']]);
  const a = autoAction(s, 'p0');
  assert.equal(a.type, 'play');
  s = act(s, 'p0', a);
  assert.equal(autoAction(s, 'p1').type, 'skip');
  s = act(s, 'p1', { type: 'check' });
  assert.equal(s.lastCheck.truthful, true);
});

// ---------- the move history

test('a new game starts with a fresh history holding only the start entry', () => {
  const people = Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
  const g1 = createGame(people, {});
  assert.equal(g1.log.length, 1);
  assert.equal(g1.log[0].t, 'start');
  assert.equal(g1.log[0].n, 3);
  // play on a bit, then start another game: nothing carries over
  const first = g1.players.find((p) => p.id === g1.turn);
  const r = applyAction(g1, first.id, { type: 'play', cardIds: [first.hand[0].id], rank: 'K' });
  assert.ok(r.ok);
  assert.equal(r.state.log.length, 2);
  const g2 = createGame(people, {});
  assert.equal(g2.log.length, 1);
});

test('plays, skips and bluff calls are recorded in order with the claim and the stack size', () => {
  let s = make([['K', 'K', '5'], ['3', '3', '9'], ['7', '7', '7']]);
  s = act(s, 'p0', playRanks(s, 'p0', ['K', 'K'], 'K'));
  s = act(s, 'p1', { type: 'skip' });
  s = act(s, 'p2', playRanks(s, 'p2', ['7'], 'K')); // a lie
  s = act(s, 'p0', { type: 'check' });
  const kinds = s.log.map((e) => e.t);
  assert.deepEqual(kinds, ['play', 'skip', 'play', 'check']);
  assert.deepEqual(s.log[0], { i: 1, t: 'play', by: 'p0', rank: 'K', count: 2, stack: 2, last: false });
  assert.equal(s.log[2].stack, 3);
  const check = s.log[3];
  assert.equal(check.by, 'p0');
  assert.equal(check.on, 'p2');
  assert.equal(check.truthful, false);
  assert.equal(check.loser, 'p2');
  assert.equal(check.picked, 3);
  assert.deepEqual(s.log.map((e) => e.i), [1, 2, 3, 4]);
});

test('a truthful claim is logged as truthful, with the checker as the loser', () => {
  let s = make([['K', '5'], ['3', '3', '9'], ['7', '7', '7']]);
  s = act(s, 'p0', playRanks(s, 'p0', ['K'], 'K'));
  s = act(s, 'p1', { type: 'check' });
  const check = s.log.at(-1);
  assert.equal(check.truthful, true);
  assert.equal(check.loser, 'p1');
});

test('a full round of skips is logged as a reset', () => {
  let s = make([['5', '6'], ['2', '2'], ['3', '3']]);
  s = act(s, 'p0', playRanks(s, 'p0', ['5'], '5'));
  s = act(s, 'p1', { type: 'skip' });
  s = act(s, 'p2', { type: 'skip' });
  s = act(s, 'p0', { type: 'skip' });
  assert.deepEqual(s.log.map((e) => e.t), ['play', 'skip', 'skip', 'skip', 'reset']);
});

test('going out is recorded: the last cards are flagged and the finish is logged with its place', () => {
  let s = make([['K'], ['3', '3'], ['4', '4']]);
  s = act(s, 'p0', playRanks(s, 'p0', ['K'], 'K'));
  assert.equal(s.log[0].last, true);
  s = act(s, 'p1', { type: 'skip' });
  const out = s.log.find((e) => e.t === 'out');
  assert.deepEqual([out.id, out.place], ['p0', 1]);
});

test('the end of the game and a player leaving are recorded', () => {
  let s = make([['K'], ['K'], ['4', '4']]);
  s = act(s, 'p0', playRanks(s, 'p0', ['K'], 'K'));
  s = act(s, 'p1', playRanks(s, 'p1', ['K'], 'K'));
  s = act(s, 'p2', { type: 'skip' });
  assert.equal(s.log.at(-1).t, 'end');
  assert.equal(s.log.at(-1).loser, 'p2');
  const t = removePlayer(make([['K', '5'], ['3', '3'], ['4', '4']]), 'p1').state;
  assert.equal(t.log.at(-1).t, 'left');
});

test('the history never reveals a card: no ranks held, suits or card ids', () => {
  let s = make([['K', '5', '5'], ['K', '9', '9'], ['7', '7', '7']]);
  s = act(s, 'p0', playRanks(s, 'p0', ['5'], 'K')); // a lie: the log must say K, never 5
  s = act(s, 'p1', playRanks(s, 'p1', ['K'], 'K'));
  s = act(s, 'p2', { type: 'check' });
  const allowed = new Set(['i', 't', 'by', 'on', 'rank', 'count', 'stack', 'last', 'truthful', 'loser', 'picked', 'id', 'place', 'n']);
  for (const e of s.log) for (const key of Object.keys(e)) assert.ok(allowed.has(key), `unexpected key ${key}`);
  for (const viewer of ['p0', 'p1', 'p2']) {
    const text = JSON.stringify(viewFor(s, viewer).log);
    assert.ok(!text.includes('suit') && !text.includes('cards') && !text.includes('cardIds'));
  }
  const bluffed = s.log.find((e) => e.t === 'play' && e.by === 'p0');
  assert.equal(bluffed.rank, 'K');
});

test('the view sends only the newest 200 moves', () => {
  const s = make([['K'], ['3'], ['4']]);
  s.log = Array.from({ length: 450 }, (_, i) => ({ i: i + 1, t: 'skip', by: 'p0' }));
  const v = viewFor(s, 'p0').log;
  assert.equal(v.length, 200);
  assert.equal(v.at(-1).i, 450);
});

// ---------- bot simulation: thousands of random games must always finish cleanly

function seededRng(seed) {
  let a = seed >>> 0;
  return (max) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
  };
}

test('bot simulation: random games always end and never lose or duplicate a card', () => {
  const GAMES = 400;
  for (let g = 0; g < GAMES; g++) {
    const rng = seededRng(1000 + g);
    const n = 3 + rng(8); // 3..10 players
    const deckCount = 1 + rng(2);
    const players = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
    let s = createGame(players, { deckCount, rng });
    let steps = 0;
    while (s.phase === 'playing') {
      assert.ok(++steps < 100000, `game ${g} did not finish`);
      const id = s.turn;
      assert.equal(P(s, id).status, 'active', 'turn must belong to an active player');
      const me = P(s, id);
      const r = rng(100);
      let action;
      if (s.stack.length > 0 && r < 25 && s.lastPlay.playerId !== id) action = { type: 'check' };
      else if (s.stack.length > 0 && r < 50) action = { type: 'skip' };
      else {
        const k = 1 + rng(Math.min(4, me.hand.length));
        const hand = [...me.hand];
        const picked = [];
        for (let i = 0; i < k; i++) picked.push(hand.splice(rng(hand.length), 1)[0]);
        const honest = rng(2) === 0 && picked[0].rank !== JOKER;
        const rank = s.stackRank || (honest ? picked[0].rank : RANKS[rng(13)]);
        action = { type: 'play', cardIds: picked.map((c) => c.id), rank };
      }
      const res = applyAction(s, id, action);
      assert.ok(res.ok, res.error);
      s = res.state;
      const c = countCards(s);
      assert.equal(c.total, s.totalCards, 'card count changed');
      assert.equal(c.unique, s.totalCards, 'duplicate card found');
    }
    assert.ok(s.loserId, 'a finished game has a loser');
    assert.equal(s.finishedOrder.length, n - 1);
  }
});
