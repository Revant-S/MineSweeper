'use strict';
// Human play session checks. Run: node test/human.test.js
const assert = require('assert');
const { load, harness } = require('./load');

const { COVERED, PRESETS, Game, HumanSession, gameSeed } = load();
const T = harness('Human session tests');

function clock() {
  const c = { t: 0 };
  return { c, timers: { now: () => c.t, setTimeout: () => 0, clearTimeout: () => {} } };
}

function setup(opts = {}) {
  const { c, timers } = clock();
  const events = { status: [], state: [], gameEnd: [], summary: [] };
  const h = new HumanSession({ preset: 'beginner', games: 2, baseSeed: 12345, timers, ...opts });
  for (const ev of Object.keys(events)) h.on(ev, (p) => events[ev].push(p));
  return { h, c, events };
}

// Uncovers every safe cell of the current game (a "perfect" human) using a mirror game.
function playToWin(h) {
  const g0 = h.currentGame();
  const mirror = new Game({ rows: g0.rows, cols: g0.cols, mines: g0.mines, seed: g0.seed });
  h.uncover(4, 4);
  mirror.uncover(4, 4);
  const mines = new Set(mirror.mineIndices());
  for (let i = 0; i < g0.rows * g0.cols && h.currentGame().result === 0; i++) {
    if (!mines.has(i)) h.uncover((i / g0.cols) | 0, i % g0.cols);
  }
}

T.check('start shows a covered board for game 1 with the run seed', () => {
  const { h, events } = setup();
  h.start();
  assert.deepStrictEqual(events.status.map((s) => s.phase), ['running']);
  assert.strictEqual(events.state.length, 1);
  const s = events.state[0];
  assert.strictEqual(s.game, 1);
  assert.strictEqual(s.result, 0);
  assert.ok(s.view.every((line) => line.every((v) => v === COVERED)));
  assert.strictEqual(h.currentGame().seed, gameSeed(12345, 1));
  assert.strictEqual(h.betweenGames, false);
});

T.check('clicks apply moves, the clock starts on the first click', () => {
  const { h, c, events } = setup();
  h.start();
  c.t = 1000;
  assert.strictEqual(h.gameMs(), 0, 'clock must not run before the first click');
  assert.ok(h.uncover(4, 4).ok);
  c.t = 1250;
  assert.strictEqual(h.gameMs(), 250);
  assert.strictEqual(events.state.length, 2);
  assert.deepStrictEqual(events.state[1].last, [4, 4]);
  assert.strictEqual(h.uncover(4, 4).code, 'ALREADY_UNCOVERED');
  assert.strictEqual(h.uncover(9, 0).code, 'OUT_OF_BOUNDS');
  assert.strictEqual(events.state.length, 2, 'rejected clicks emit nothing');
});

T.check('a win is recorded, then next() starts the following game', () => {
  const { h, c, events } = setup();
  h.start();
  playToWin(h);
  c.t = 5000;
  assert.strictEqual(events.gameEnd.length, 1);
  const row = events.gameEnd[0];
  assert.strictEqual(row.result, 1);
  assert.strictEqual(row.reason, null);
  assert.strictEqual(row.seed, 12345);
  assert.strictEqual(h.betweenGames, true);
  assert.strictEqual(h.uncover(0, 0).ok, false, 'no clicks between games');
  assert.strictEqual(h.next(), true);
  assert.strictEqual(h.currentGame().seed, 12346);
  assert.strictEqual(h.betweenGames, false);
  assert.strictEqual(h.next(), false);
  assert.strictEqual(h.stats.won, 1);
});

T.check('hitting a mine loses with reason MINE; the last game ends the run', () => {
  const { h, events } = setup({ games: 1 });
  h.start();
  const g = h.currentGame();
  h.uncover(4, 4);
  assert.strictEqual(g.result, 0, 'seed 12345 from (4,4) leaves the game open');
  const mine = g.mineIndices()[0];
  h.uncover((mine / 9) | 0, mine % 9);
  assert.strictEqual(events.gameEnd.length, 1);
  assert.strictEqual(events.gameEnd[0].result, 2);
  assert.strictEqual(events.gameEnd[0].reason, 'MINE');
  assert.deepStrictEqual(events.state[events.state.length - 1].exploded, [(mine / 9) | 0, mine % 9]);
  assert.strictEqual(h.stats.lossReasons.MINE, 1);
  assert.strictEqual(h.phase, 'done');
  assert.strictEqual(events.summary.length, 1);
  assert.strictEqual(events.summary[0].played, 1);
  assert.strictEqual(h.next(), false, 'no game after the last one');
});

T.check('stop() ends the session without counting the game in progress', () => {
  const { h, events } = setup({ games: 5, preset: 'expert' });
  h.start();
  h.uncover(0, 0);
  h.stop();
  assert.strictEqual(h.phase, 'stopped');
  assert.strictEqual(events.summary[0].played, 0);
  assert.strictEqual(h.uncover(5, 5).ok, false);
  assert.throws(() => new HumanSession({ ...PRESETS.beginner, games: 0, baseSeed: 1 }));
});

T.done();
