'use strict';
// Runner checks from section 8 of the spec, against a fake socket and a fake clock.
// Run: node test/runner.test.js
const assert = require('assert');
const { load, harness } = require('./load');

const { COVERED, PRESETS, Game, Runner, gameSeed } = load();
const T = harness('Runner tests');

class FakeClock {
  constructor() { this.t = 0; this.q = []; this.seq = 0; }
  now = () => this.t;
  setTimeout = (fn, ms) => { const id = ++this.seq; this.q.push({ id, at: this.t + Math.max(0, ms), fn }); return id; };
  clearTimeout = (id) => { this.q = this.q.filter((x) => x.id !== id); };
  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      this.q.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.q[0];
      if (!next || next.at > end) break;
      this.q.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

class FakeSocket {
  constructor(url) { this.url = url; this.sent = []; this.closed = false; }
  send(raw) { if (this.closed) throw new Error('send on closed socket'); this.sent.push(JSON.parse(raw)); }
  close() { if (this.closed) return; this.closed = true; if (this.onclose) this.onclose({ code: 1000 }); }
  // Test side: what the bot (server) does.
  open() { this.onopen(); }
  receive(msg) { this.onmessage({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) }); }
  drop() { this.closed = true; this.onclose({ code: 1006 }); }
  last() { return this.sent[this.sent.length - 1]; }
  take() { const out = this.sent; this.sent = []; return out; }
}

function setup(opts = {}) {
  const clock = new FakeClock();
  let sock = null;
  const events = { status: [], state: [], gameEnd: [], message: [], summary: [] };
  const runner = new Runner({
    url: 'ws://localhost:8080', preset: 'beginner', games: 3, baseSeed: 12345,
    ...opts,
    timers: clock,
    socketFactory: (url) => (sock = new FakeSocket(url)),
  });
  for (const ev of Object.keys(events)) runner.on(ev, (p) => events[ev].push(p));
  runner.start();
  return { runner, clock, sock: () => sock, events };
}

// Opens the socket and completes the handshake; returns the first STATE.
function handshake(ctx) {
  const s = ctx.sock();
  s.open();
  assert.deepStrictEqual(s.take(), [{ type: 'HELLO', protocol: 1 }]);
  s.receive({ type: 'READY', name: 'test-bot' });
  const sent = s.take();
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].type, 'STATE');
  return sent[0];
}

function firstCovered(state) {
  for (let r = 0; r < state.rows; r++) for (let c = 0; c < state.cols; c++) {
    if (state.board[r][c] === COVERED) return [r, c];
  }
  throw new Error('no covered cell');
}

function move(state, r, c) { return { type: 'MOVE', game: state.game, row: r, col: c }; }

// Plays a game-1 opening that does not end the game and returns the resulting STATE.
function safeOpening(ctx, state) {
  ctx.sock().receive(move(state, 4, 4));
  const next = ctx.sock().take();
  assert.strictEqual(next.length, 1);
  return next[0];
}

// Seed 12345 Beginner from (4,4) leaves the game open (see the README reference vector).
const OPEN_SEED = 12345;

// ---------------------------------------------------------------------------

T.check('happy path, 3 games: HELLO, READY, STATEs, final STATEs not awaited, SUMMARY, close', () => {
  const ctx = setup({ games: 3, baseSeed: 4294967294 });
  const s = ctx.sock();
  assert.strictEqual(ctx.events.status[0].phase, 'connecting');
  assert.strictEqual(s.url, 'ws://localhost:8080');
  let state = handshake(ctx);
  assert.deepStrictEqual(ctx.events.status.map((e) => e.phase), ['connecting', 'handshake', 'running']);
  assert.ok(ctx.events.status[2].detail.includes('test-bot'));

  const transcript = [];
  for (let k = 1; k <= 3; k++) {
    assert.strictEqual(state.game, k);
    assert.strictEqual(state.games, 3);
    assert.strictEqual(state.seed, gameSeed(4294967294, k));
    assert.strictEqual(state.moves, 0);
    assert.strictEqual(state.last, null);
    assert.strictEqual(state.result, 0);
    assert.ok(state.board.every((line) => line.every((v) => v === COVERED)));
    // Mirror the game locally to verify every STATE the runner sends.
    const mirror = new Game({ ...PRESETS.beginner, seed: state.seed });
    for (;;) {
      const [r, c] = firstCovered(state);
      s.receive(move(state, r, c));
      mirror.uncover(r, c);
      const out = s.take();
      transcript.push(...out);
      const st = out[0];
      assert.strictEqual(st.type, 'STATE');
      assert.deepStrictEqual(st.board, mirror.view());
      assert.strictEqual(st.moves, mirror.moves);
      assert.deepStrictEqual(st.last, [r, c]);
      if (st.result === 0) { assert.strictEqual(out.length, 1); state = st; continue; }
      // Final STATE: the runner does not wait for an answer, it moves on at once.
      assert.strictEqual(st.result, mirror.result);
      assert.strictEqual(st.reason, mirror.reason);
      assert.deepStrictEqual(st.exploded, mirror.exploded);
      assert.strictEqual(out.length, 2);
      if (k < 3) { assert.strictEqual(out[1].type, 'STATE'); assert.strictEqual(out[1].game, k + 1); state = out[1]; }
      else assert.strictEqual(out[1].type, 'SUMMARY');
      break;
    }
  }
  const summary = transcript[transcript.length - 1];
  assert.strictEqual(summary.played, 3);
  assert.strictEqual(summary.won + summary.lost, 3);
  assert.strictEqual(summary.games.length, 3);
  assert.deepStrictEqual(summary.games.map((g) => g.seed), [4294967294, 4294967295, 0]);
  assert.strictEqual(summary.totalMoves, summary.games.reduce((n, g) => n + g.moves, 0));
  assert.deepStrictEqual(Object.keys(summary.lossReasons).sort(), ['DISCONNECT', 'ERROR_LIMIT', 'MINE', 'TIMEOUT']);
  assert.strictEqual(ctx.events.gameEnd.length, 3);
  assert.strictEqual(ctx.events.summary.length, 1);
  assert.strictEqual(ctx.runner.phase, 'done');
  assert.ok(!s.closed, 'socket must stay open for 500 ms after SUMMARY');
  ctx.clock.advance(499);
  assert.ok(!s.closed);
  ctx.clock.advance(1);
  assert.ok(s.closed, 'socket closed 500 ms after SUMMARY');
  assert.strictEqual(ctx.events.status[ctx.events.status.length - 1].phase, 'done');
  assert.ok(ctx.events.message.some((m) => m.dir === 'in') && ctx.events.message.some((m) => m.dir === 'out'));
  assert.strictEqual(ctx.events.state.length, ctx.events.message.filter((m) => m.dir === 'out' && JSON.parse(m.raw).type === 'STATE').length);
});

T.check('ERROR then the unchanged STATE, for every error code', () => {
  const ctx = setup({ games: 2, baseSeed: OPEN_SEED, delayMs: 0 });
  const s = ctx.sock();
  let state = handshake(ctx);
  state = safeOpening(ctx, state);
  assert.strictEqual(state.result, 0);

  const cases = [
    ['not json at all', 'BAD_MESSAGE'],
    [{ type: 'MOVE', game: 1, row: 1 }, 'BAD_MESSAGE'],
    [{ type: 'MOVE', game: 1, row: '1', col: 1 }, 'BAD_MESSAGE'],
    [{ type: 'MOVE', game: 1, row: 1.5, col: 1 }, 'BAD_MESSAGE'],
    [{ type: 'FLAG', game: 1, row: 1, col: 1 }, 'BAD_MESSAGE'],
    ['[1,2,3]', 'BAD_MESSAGE'],
    [{ type: 'MOVE', game: 1, row: 9, col: 0 }, 'OUT_OF_BOUNDS'],
    [{ type: 'MOVE', game: 1, row: 0, col: -1 }, 'OUT_OF_BOUNDS'],
    [{ type: 'MOVE', game: 1, row: 4, col: 4 }, 'ALREADY_UNCOVERED'],
    [{ type: 'MOVE', game: 2, row: 0, col: 0 }, 'WRONG_GAME'],
  ];
  for (const [msg, code] of cases) {
    s.receive(msg);
    const out = s.take();
    assert.strictEqual(out.length, 2, `${code}: expected ERROR + STATE`);
    assert.deepStrictEqual(Object.keys(out[0]).sort(), ['code', 'game', 'msg', 'type']);
    assert.strictEqual(out[0].type, 'ERROR');
    assert.strictEqual(out[0].code, code);
    assert.strictEqual(out[0].game, 1);
    assert.deepStrictEqual(out[1], state, `${code}: STATE changed`);
  }
  // Unknown extra fields are ignored.
  const [r, c] = firstCovered(state);
  s.receive({ type: 'MOVE', game: 1, row: r, col: c, note: 'hi', extra: [1] });
  const out = s.take();
  assert.strictEqual(out[0].type, 'STATE');
  assert.strictEqual(out[0].moves, 2);

  // NOT_YOUR_TURN needs a STATE still pending, which happens with an animation delay.
  const ctx2 = setup({ games: 1, baseSeed: OPEN_SEED, delayMs: 150 });
  const s2 = ctx2.sock();
  s2.open(); s2.take();
  s2.receive({ type: 'READY' });
  assert.strictEqual(s2.sent.length, 0, 'STATE must wait for the delay');
  ctx2.clock.advance(150);
  const st0 = s2.take()[0];
  s2.receive(move(st0, 4, 4));
  s2.receive(move(st0, 0, 0)); // second MOVE before the STATE answering the first
  const err = s2.take();
  assert.strictEqual(err.length, 1);
  assert.strictEqual(err[0].code, 'NOT_YOUR_TURN');
  ctx2.clock.advance(150);
  const st1 = s2.take();
  assert.strictEqual(st1.length, 1, 'exactly one STATE follows the ERROR');
  assert.strictEqual(st1[0].moves, 1, 'the second MOVE was not applied');
  assert.deepStrictEqual(st1[0].last, [4, 4]);
});

T.check('20 consecutive errors end the game with ERROR_LIMIT; an accepted move resets the count', () => {
  const ctx = setup({ games: 2, baseSeed: OPEN_SEED });
  const s = ctx.sock();
  let state = handshake(ctx);
  for (let i = 0; i < 19; i++) { s.receive('garbage'); assert.strictEqual(s.take().length, 2); }
  state = safeOpening(ctx, state); // accepted move resets the count
  assert.strictEqual(state.result, 0);
  for (let i = 0; i < 19; i++) {
    s.receive({ type: 'MOVE', game: 1, row: 99, col: 99 });
    const out = s.take();
    assert.strictEqual(out[1].result, 0, `game ended early after ${i + 1} errors`);
  }
  s.receive({ type: 'MOVE', game: 1, row: 4, col: 4 });
  const out = s.take();
  assert.strictEqual(out.length, 3, 'ERROR, final STATE, next game STATE');
  assert.strictEqual(out[0].code, 'ALREADY_UNCOVERED');
  assert.strictEqual(out[1].result, 2);
  assert.strictEqual(out[1].reason, 'ERROR_LIMIT');
  assert.strictEqual(out[1].exploded, null);
  assert.ok(!out[1].board.some((line) => line.includes(-3)), 'non-mine loss must not reveal mines');
  assert.strictEqual(out[2].game, 2);
  assert.strictEqual(ctx.events.gameEnd[0].reason, 'ERROR_LIMIT');
  assert.strictEqual(ctx.runner.stats.lossReasons.ERROR_LIMIT, 1);
  // The count is per game: game 2 starts from zero.
  for (let i = 0; i < 19; i++) { s.receive('x'); assert.strictEqual(s.take()[1].result, 0); }
});

T.check('a silent bot hits TIMEOUT and the run moves on to the next game', () => {
  const ctx = setup({ games: 2, moveTimeoutMs: 5000 });
  const s = ctx.sock();
  handshake(ctx);
  ctx.clock.advance(4999);
  assert.strictEqual(s.sent.length, 0);
  ctx.clock.advance(1);
  const out = s.take();
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].result, 2);
  assert.strictEqual(out[0].reason, 'TIMEOUT');
  assert.strictEqual(out[0].game, 1);
  assert.strictEqual(out[1].game, 2);
  assert.strictEqual(out[1].result, 0);
  assert.strictEqual(ctx.events.gameEnd[0].ms, 5000);
  ctx.clock.advance(5000);
  const end = s.take();
  assert.strictEqual(end[0].reason, 'TIMEOUT');
  assert.strictEqual(end[1].type, 'SUMMARY');
  assert.strictEqual(end[1].lossReasons.TIMEOUT, 2);
  assert.strictEqual(ctx.runner.phase, 'done');
});

T.check('no timeout fires while paused; pause holds the next STATE', () => {
  const ctx = setup({ games: 1, baseSeed: OPEN_SEED, moveTimeoutMs: 1000 });
  const s = ctx.sock();
  let state = handshake(ctx);
  ctx.clock.advance(600);
  ctx.runner.pause();
  assert.strictEqual(ctx.runner.phase, 'paused');
  ctx.clock.advance(60000);
  assert.strictEqual(s.sent.length, 0, 'timeout fired while paused');
  ctx.runner.resume();
  ctx.clock.advance(399);
  assert.strictEqual(s.sent.length, 0, 'remaining time not honoured');
  // A move received while paused is applied but its STATE is held.
  ctx.runner.pause();
  s.receive(move(state, 4, 4));
  assert.strictEqual(s.sent.length, 0, 'STATE sent while paused');
  ctx.clock.advance(10000);
  assert.strictEqual(s.sent.length, 0);
  ctx.runner.resume();
  state = s.take()[0];
  assert.strictEqual(state.moves, 1);
  // Fresh timer for the new STATE.
  ctx.clock.advance(999);
  assert.strictEqual(s.sent.length, 0);
  ctx.clock.advance(1);
  assert.strictEqual(s.take()[0].reason, 'TIMEOUT');
  // Elapsed time excludes the pauses: 600 + 399 + 1000 ms.
  assert.strictEqual(ctx.runner.stats.elapsedMs, 1999);
});

T.check('late MOVE for a finished game gets WRONG_GAME; double MOVE gets NOT_YOUR_TURN', () => {
  const ctx = setup({ games: 2, moveTimeoutMs: 1000 });
  const s = ctx.sock();
  handshake(ctx);
  ctx.clock.advance(1000); // game 1 times out
  const [final1, state2] = s.take();
  assert.strictEqual(final1.reason, 'TIMEOUT');
  s.receive({ type: 'MOVE', game: 1, row: 0, col: 0 }); // too late
  const out = s.take();
  assert.strictEqual(out[0].code, 'WRONG_GAME');
  assert.deepStrictEqual(out[1], state2);
  assert.strictEqual(ctx.runner.currentGame().moves, 0);

  // Same game number, but the game is already over (final STATE still held by the delay).
  const ctx2 = setup({ games: 2, delayMs: 100, moveTimeoutMs: 1000 });
  const s2 = ctx2.sock();
  s2.open(); s2.take(); s2.receive({ type: 'READY' });
  ctx2.clock.advance(100);
  s2.take();
  ctx2.clock.advance(1000); // timeout; final STATE now waits 100 ms
  s2.receive({ type: 'MOVE', game: 1, row: 0, col: 0 });
  assert.strictEqual(s2.take()[0].code, 'WRONG_GAME');

  // Double MOVE while the paused runner holds the answering STATE.
  const ctx3 = setup({ games: 1, baseSeed: OPEN_SEED });
  const s3 = ctx3.sock();
  const st = handshake(ctx3);
  ctx3.runner.pause();
  s3.receive(move(st, 4, 4));
  s3.receive(move(st, 0, 0));
  const errs = s3.take();
  assert.strictEqual(errs.length, 1);
  assert.strictEqual(errs[0].code, 'NOT_YOUR_TURN');
  ctx3.runner.resume();
  const after = s3.take();
  assert.strictEqual(after.length, 1);
  assert.strictEqual(after[0].moves, 1);
});

T.check('socket close mid-game records DISCONNECT and stops with a partial summary', () => {
  const ctx = setup({ games: 5, moveTimeoutMs: 1000 });
  const s = ctx.sock();
  handshake(ctx);
  ctx.clock.advance(1000); // game 1: TIMEOUT
  s.take();
  s.receive(move({ game: 2 }, 4, 4));
  s.drop();
  assert.strictEqual(ctx.runner.phase, 'stopped');
  const st = ctx.events.status[ctx.events.status.length - 1];
  assert.ok(/disconnected during game 2/.test(st.detail), st.detail);
  assert.strictEqual(ctx.events.summary.length, 1);
  const sum = ctx.events.summary[0];
  assert.strictEqual(sum.played, 2);
  assert.strictEqual(sum.lossReasons.TIMEOUT, 1);
  const g2 = sum.games[1];
  // The first move is always safe, so game 2 is either won outright or lost to the disconnect.
  assert.ok(g2.result === 1 || g2.reason === 'DISCONNECT', JSON.stringify(g2));
  assert.strictEqual(g2.moves, 1);
  // Nothing happens afterwards: no reconnect, no more timers.
  ctx.clock.advance(100000);
  assert.strictEqual(ctx.events.gameEnd.length, 2);
});

T.check('no READY within 5 s ends the run as failed with no games counted', () => {
  const ctx = setup({ games: 3 });
  const s = ctx.sock();
  s.open();
  s.receive({ type: 'HELLO_BACK' }); // anything but READY is ignored during the handshake
  ctx.clock.advance(4999);
  assert.strictEqual(ctx.runner.phase, 'handshake');
  ctx.clock.advance(1);
  assert.strictEqual(ctx.runner.phase, 'failed');
  assert.ok(/READY/.test(ctx.events.status[ctx.events.status.length - 1].detail));
  assert.ok(s.closed);
  assert.strictEqual(ctx.runner.stats.played, 0);
  assert.strictEqual(ctx.events.gameEnd.length, 0);
  assert.strictEqual(ctx.events.summary.length, 0);
  assert.deepStrictEqual(s.sent.map((m) => m.type), ['HELLO']);
});

T.check('connection refused fails with a plain sentence; stop() ends the run without counting the game', () => {
  const ctx = setup();
  ctx.sock().drop(); // closes before open
  assert.strictEqual(ctx.runner.phase, 'failed');
  assert.ok(/Is the bot running\?/.test(ctx.events.status[ctx.events.status.length - 1].detail));

  const ctx2 = setup({ games: 10, moveTimeoutMs: 1000 });
  handshake(ctx2);
  ctx2.clock.advance(1000);
  ctx2.runner.stop();
  assert.strictEqual(ctx2.runner.phase, 'stopped');
  assert.ok(ctx2.sock().closed);
  assert.strictEqual(ctx2.events.summary.length, 1);
  assert.strictEqual(ctx2.events.summary[0].played, 1, 'the game in progress is not counted');
  ctx2.clock.advance(100000);
  assert.strictEqual(ctx2.events.gameEnd.length, 1);

  const r = new Runner({ url: 'ws://x', preset: 'beginner', games: 1, baseSeed: 1, socketFactory: () => { throw new Error('bad url'); } });
  const phases = [];
  r.on('status', (st) => phases.push(st.phase));
  r.start();
  assert.deepStrictEqual(phases, ['connecting', 'failed']);
});

T.check('animated delay is applied before every STATE and can change live', () => {
  const ctx = setup({ games: 1, baseSeed: OPEN_SEED, delayMs: 200 });
  const s = ctx.sock();
  s.open(); s.take(); s.receive({ type: 'READY' });
  ctx.clock.advance(199);
  assert.strictEqual(s.sent.length, 0);
  ctx.clock.advance(1);
  const st = s.take()[0];
  ctx.runner.setDelay(50);
  s.receive(move(st, 4, 4));
  ctx.clock.advance(49);
  assert.strictEqual(s.sent.length, 0);
  ctx.clock.advance(1);
  assert.strictEqual(s.take().length, 1);
  // The bot's own time excludes the delay: the move timeout starts only when the STATE goes out.
  assert.strictEqual(ctx.events.state.length, 2);
});

T.done();
