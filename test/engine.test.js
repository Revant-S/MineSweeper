'use strict';
// Engine checks from section 8 of the spec. Run: node test/engine.test.js
const assert = require('assert');
const { load, source, harness } = require('./load');

const { COVERED, MINE, PRESETS, mulberry32, validateConfig, gameSeed, Game } = load();
const T = harness('Engine tests');

// Deterministic randomness for the tests themselves (not the engine's PRNG stream).
const rand = mulberry32(0xC0FFEE);
const randInt = (n) => Math.floor(rand() * n);
const presetList = Object.values(PRESETS);

function randomConfig() {
  if (rand() < 0.5) return presetList[randInt(presetList.length)];
  const rows = 2 + randInt(49), cols = 2 + randInt(49);
  const mines = 1 + randInt(Math.min(rows * cols - 1, Math.ceil(rows * cols * 0.3)));
  return { rows, cols, mines };
}

function bruteCount(mineSet, rows, cols, r, c) {
  let n = 0;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const rr = r + dr, cc = c + dc;
    if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && mineSet.has(rr * cols + cc)) n++;
  }
  return n;
}

function openCells(view) {
  const out = new Set();
  const cols = view[0].length;
  view.forEach((line, r) => line.forEach((v, c) => { if (v >= 0) out.add(r * cols + c); }));
  return out;
}

// Reference flood: plain BFS from scratch, written independently of the engine.
function referenceFlood(mineSet, rows, cols, r0, c0) {
  const seen = new Set([r0 * cols + c0]);
  const queue = [[r0, c0]];
  while (queue.length) {
    const [r, c] = queue.shift();
    if (bruteCount(mineSet, rows, cols, r, c) !== 0) continue;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
      const i = rr * cols + cc;
      if (seen.has(i) || mineSet.has(i)) continue;
      seen.add(i);
      queue.push([rr, cc]);
    }
  }
  return seen;
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ---------------------------------------------------------------------------

T.check('engine source has no Math.random, DOM, network or timers', () => {
  const src = source('ENGINE');
  for (const bad of ['Math.random', 'document', 'window', 'WebSocket', 'setTimeout', 'setInterval', 'Date.now']) {
    assert.ok(!src.includes(bad), `engine mentions ${bad}`);
  }
});

T.check('validateConfig and gameSeed', () => {
  assert.strictEqual(validateConfig({ rows: 2, cols: 2, mines: 3 }), null);
  assert.strictEqual(validateConfig({ rows: 50, cols: 50, mines: 2499 }), null);
  assert.ok(validateConfig({ rows: 1, cols: 9, mines: 1 }));
  assert.ok(validateConfig({ rows: 51, cols: 9, mines: 1 }));
  assert.ok(validateConfig({ rows: 9, cols: 9, mines: 0 }));
  assert.ok(validateConfig({ rows: 9, cols: 9, mines: 81 }));
  assert.ok(validateConfig({ rows: 9.5, cols: 9, mines: 10 }));
  assert.ok(validateConfig({ rows: '9', cols: 9, mines: 10 }));
  assert.strictEqual(gameSeed(12345, 1), 12345);
  assert.strictEqual(gameSeed(12345, 3), 12347);
  assert.strictEqual(gameSeed(4294967295, 2), 0);
});

T.check('same seed, size and first move give the same mines (1,000 repeats)', () => {
  for (const cfg of presetList) {
    const seed = 987654321, r0 = 3, c0 = 5;
    const ref = new Game({ ...cfg, seed });
    ref.uncover(r0, c0);
    const want = JSON.stringify(ref.mineIndices());
    for (let i = 0; i < 1000; i++) {
      const g = new Game({ ...cfg, seed });
      g.uncover(r0, c0);
      assert.strictEqual(JSON.stringify(g.mineIndices()), want);
    }
  }
  // A different first move or seed should (almost always) change the layout.
  const a = new Game({ ...PRESETS.expert, seed: 1 }); a.uncover(0, 0);
  const b = new Game({ ...PRESETS.expert, seed: 2 }); b.uncover(0, 0);
  assert.notStrictEqual(JSON.stringify(a.mineIndices()), JSON.stringify(b.mineIndices()));
});

T.check('first uncover is never a mine; exactly `mines` placed, none on the first cell (100,000 games)', () => {
  for (let i = 0; i < 100000; i++) {
    const cfg = presetList[i % 3];
    const seed = (rand() * 4294967296) >>> 0;
    const r0 = randInt(cfg.rows), c0 = randInt(cfg.cols);
    const g = new Game({ ...cfg, seed });
    assert.strictEqual(g.placed, false);
    const res = g.uncover(r0, c0);
    assert.ok(res.ok);
    assert.notStrictEqual(g.result, 2, `seed ${seed} first move (${r0},${c0}) hit a mine`);
    const mines = g.mineIndices();
    assert.strictEqual(mines.length, cfg.mines);
    assert.strictEqual(new Set(mines).size, cfg.mines);
    assert.ok(!mines.includes(r0 * cfg.cols + c0));
  }
});

T.check('neighbour counts match a brute-force recount (1,000 random boards)', () => {
  for (let b = 0; b < 1000; b++) {
    const cfg = randomConfig();
    const g = new Game({ ...cfg, seed: (rand() * 4294967296) >>> 0 });
    g.uncover(randInt(cfg.rows), randInt(cfg.cols));
    const mineSet = new Set(g.mineIndices());
    // Open every safe cell; the win view then shows every count.
    for (let i = 0; i < cfg.rows * cfg.cols && g.result === 0; i++) {
      if (mineSet.has(i)) continue;
      const r = (i / cfg.cols) | 0, c = i % cfg.cols;
      g.uncover(r, c);
    }
    assert.strictEqual(g.result, 1);
    const v = g.view();
    for (let r = 0; r < cfg.rows; r++) for (let c = 0; c < cfg.cols; c++) {
      const i = r * cfg.cols + c;
      if (mineSet.has(i)) assert.strictEqual(v[r][c], COVERED, 'mine shown after a win');
      else assert.strictEqual(v[r][c], bruteCount(mineSet, cfg.rows, cfg.cols, r, c));
    }
  }
});

T.check('flood fill opens exactly the zero region plus its numbered border (reference BFS)', () => {
  let zeroStarts = 0;
  for (let b = 0; b < 1000; b++) {
    const cfg = randomConfig();
    const g = new Game({ ...cfg, seed: (rand() * 4294967296) >>> 0 });
    const r0 = randInt(cfg.rows), c0 = randInt(cfg.cols);
    g.uncover(r0, c0);
    const mineSet = new Set(g.mineIndices());
    let expected = referenceFlood(mineSet, cfg.rows, cfg.cols, r0, c0);
    assert.ok(sameSet(openCells(g.view()), expected), 'first move flood differs from reference');
    // Further moves: each one adds exactly its own reference region.
    for (let step = 0; step < 5 && g.result === 0; step++) {
      const covered = [];
      g.view().forEach((line, r) => line.forEach((v, c) => {
        if (v === COVERED && !mineSet.has(r * cfg.cols + c)) covered.push([r, c]);
      }));
      const [r, c] = covered[randInt(covered.length)];
      if (bruteCount(mineSet, cfg.rows, cfg.cols, r, c) === 0) zeroStarts++;
      g.uncover(r, c);
      expected = new Set([...expected, ...referenceFlood(mineSet, cfg.rows, cfg.cols, r, c)]);
      assert.ok(sameSet(openCells(g.view()), expected), 'later flood differs from reference');
    }
  }
  assert.ok(zeroStarts > 50, 'too few zero-cell floods exercised');
});

T.check('50 x 50 board with 1 mine floods without a stack overflow', () => {
  for (let s = 0; s < 20; s++) {
    const g = new Game({ rows: 50, cols: 50, mines: 1, seed: s });
    const mine = (() => { const t = new Game({ rows: 50, cols: 50, mines: 1, seed: s }); t.uncover(0, 0); return t.mineIndices()[0]; })();
    g.uncover(0, 0);
    assert.strictEqual(g.result, 1, 'one click should open all 2,499 safe cells');
    assert.strictEqual(openCells(g.view()).size, 2499);
    assert.ok(!openCells(g.view()).has(mine));
  }
});

T.check('win fires exactly when the last safe cell opens, not before', () => {
  for (let b = 0; b < 300; b++) {
    const cfg = randomConfig();
    const g = new Game({ ...cfg, seed: (rand() * 4294967296) >>> 0 });
    g.uncover(randInt(cfg.rows), randInt(cfg.cols));
    const mineSet = new Set(g.mineIndices());
    const safe = [];
    for (let i = 0; i < cfg.rows * cfg.cols; i++) if (!mineSet.has(i)) safe.push(i);
    for (let i = safe.length - 1; i > 0; i--) { const j = randInt(i + 1); [safe[i], safe[j]] = [safe[j], safe[i]]; }
    const target = cfg.rows * cfg.cols - cfg.mines;
    for (const i of safe) {
      const r = (i / cfg.cols) | 0, c = i % cfg.cols;
      if (g.view()[r][c] !== COVERED) continue;
      assert.strictEqual(g.result, 0, 'won before every safe cell was open');
      g.uncover(r, c);
      const open = openCells(g.view()).size;
      assert.strictEqual(g.result === 1, open === target, `result ${g.result} with ${open}/${target} open`);
    }
    assert.strictEqual(g.result, 1);
  }
});

T.check('view() never shows -3 unless lost to a mine, then exactly `mines` of them', () => {
  for (let b = 0; b < 2000; b++) {
    const cfg = randomConfig();
    const g = new Game({ ...cfg, seed: (rand() * 4294967296) >>> 0 });
    const countMines = () => g.view().reduce((n, line) => n + line.filter((v) => v === MINE).length, 0);
    const forfeitAt = b % 4 === 0 ? 1 + randInt(5) : -1;
    let moves = 0;
    while (g.result === 0) {
      if (moves === forfeitAt) { g.forfeit(['TIMEOUT', 'ERROR_LIMIT', 'DISCONNECT'][b % 3]); break; }
      const v = g.view();
      for (const line of v) for (const x of line) assert.ok(x === COVERED || (x >= 0 && x <= 8), `bad value ${x} mid-game`);
      const covered = [];
      v.forEach((line, r) => line.forEach((x, c) => { if (x === COVERED) covered.push([r, c]); }));
      const [r, c] = covered[randInt(covered.length)];
      g.uncover(r, c);
      moves++;
    }
    if (g.reason === 'MINE') {
      assert.strictEqual(countMines(), cfg.mines);
      const [er, ec] = g.exploded;
      assert.strictEqual(g.view()[er][ec], MINE);
      assert.deepStrictEqual(g.last, g.exploded);
    } else {
      assert.strictEqual(countMines(), 0, `mines visible after ${g.result === 1 ? 'win' : g.reason}`);
      assert.strictEqual(g.exploded, null);
    }
  }
});

T.check('illegal input returns the right code and changes nothing', () => {
  const cfg = PRESETS.beginner;
  const fresh = new Game({ ...cfg, seed: 7 });
  const bad = [[-1, 0], [0, -1], [9, 0], [0, 9], [1.5, 2], [2, 0.1], ['1', 2], [null, null], [undefined, undefined],
    [NaN, 0], [Infinity, 0], [{}, []], [true, false], [2 ** 53, 0]];
  for (const [r, c] of bad) {
    const res = fresh.uncover(r, c);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'OUT_OF_BOUNDS', `(${String(r)},${String(c)})`);
    assert.strictEqual(typeof res.msg, 'string');
  }
  assert.strictEqual(fresh.placed, false, 'a rejected move must not place mines');
  assert.strictEqual(fresh.moves, 0);
  assert.strictEqual(fresh.last, null);

  // Find a seed where the first move does not end the game.
  let g, seed = 100;
  do { g = new Game({ ...cfg, seed: seed++ }); g.uncover(4, 4); } while (g.result !== 0);
  const before = JSON.stringify(g.view()), moves = g.moves, last = g.last;
  for (const [r, c] of bad) assert.strictEqual(g.uncover(r, c).code, 'OUT_OF_BOUNDS');
  const again = g.uncover(4, 4);
  assert.strictEqual(again.code, 'ALREADY_UNCOVERED');
  assert.strictEqual(again.msg, 'cell (4,4) is already uncovered');
  assert.strictEqual(JSON.stringify(g.view()), before);
  assert.strictEqual(g.moves, moves);
  assert.deepStrictEqual(g.last, last);

  // Finished game: WRONG_GAME, nothing changes.
  g.forfeit('TIMEOUT');
  const after = JSON.stringify(g.view());
  const covered = [];
  g.view().forEach((line, r) => line.forEach((x, c) => { if (x === COVERED) covered.push([r, c]); }));
  assert.strictEqual(g.uncover(covered[0][0], covered[0][1]).code, 'WRONG_GAME');
  assert.strictEqual(JSON.stringify(g.view()), after);
  assert.strictEqual(g.moves, moves);
  assert.strictEqual(g.reason, 'TIMEOUT');
  assert.strictEqual(g.forfeit('DISCONNECT'), false, 'forfeit on a finished game is a no-op');
  assert.strictEqual(g.reason, 'TIMEOUT');
  assert.throws(() => new Game({ ...cfg, seed: 1 }).forfeit('MINE'));
  assert.throws(() => new Game({ ...cfg, seed: 1 }).mineIndices());
  assert.throws(() => new Game({ rows: 1, cols: 9, mines: 1, seed: 1 }));
  assert.throws(() => new Game({ ...cfg, seed: -1 }));
});

T.check('view() returns fresh arrays every call', () => {
  const g = new Game({ ...PRESETS.beginner, seed: 3 });
  g.uncover(0, 0);
  const v = g.view();
  const snapshot = JSON.stringify(v);
  v[0][0] = 99; v.pop();
  assert.strictEqual(JSON.stringify(g.view()), snapshot);
  const l = g.last; l[0] = 42;
  assert.deepStrictEqual(g.last, [0, 0]);
});

T.check('reference vector: seed 12345, Beginner, first move (4, 4)', () => {
  const g = new Game({ ...PRESETS.beginner, seed: 12345 });
  g.uncover(4, 4);
  const mines = g.mineIndices();
  console.log(`       mine indices: [${mines.join(', ')}]`);
  console.log(`       as (row,col): ${mines.map((i) => `(${(i / 9) | 0},${i % 9})`).join(' ')}`);
  const readme = require('fs').readFileSync(require('path').join(__dirname, '..', 'README.md'), 'utf8');
  assert.ok(readme.includes(`[${mines.join(', ')}]`), 'README.md does not record this reference vector');
});

T.done();
