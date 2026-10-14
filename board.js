'use strict';
// ENGINE START
// Pure game engine: no DOM, no network, no timers, no global randomness.
const COVERED = -2, MINE = -3;
const PRESETS = {
  beginner:     { rows: 9,  cols: 9,  mines: 10 },
  intermediate: { rows: 16, cols: 16, mines: 40 },
  expert:       { rows: 16, cols: 30, mines: 99 },
};
const FORFEIT_REASONS = ['TIMEOUT', 'ERROR_LIMIT', 'DISCONNECT'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function validateConfig({ rows, cols, mines } = {}) {
  if (!Number.isInteger(rows) || rows < 2 || rows > 50) return 'Rows must be a whole number from 2 to 50.';
  if (!Number.isInteger(cols) || cols < 2 || cols > 50) return 'Cols must be a whole number from 2 to 50.';
  const max = rows * cols - 1;
  if (!Number.isInteger(mines) || mines < 1 || mines > max) return `Mines must be a whole number from 1 to ${max}.`;
  return null;
}

function gameSeed(baseSeed, k) {
  return (baseSeed + k - 1) >>> 0;
}

function fmtCoord(v) {
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  if (v === undefined) return 'undefined';
  try { return JSON.stringify(v); } catch (e) { return String(typeof v); }
}

class Game {
  constructor({ rows, cols, mines, seed }) {
    const err = validateConfig({ rows, cols, mines });
    if (err) throw new Error(err);
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xFFFFFFFF) {
      throw new Error('Seed must be an unsigned 32-bit integer.');
    }
    this.rows = rows;
    this.cols = cols;
    this.mines = mines;
    this.seed = seed >>> 0;
    const n = rows * cols;
    this._mine = new Uint8Array(n);
    this._count = new Uint8Array(n);
    this._open = new Uint8Array(n);
    this._safeTotal = n - mines;
    this._safeOpen = 0;
    this._placed = false;
    this._result = 0;
    this._reason = null;
    this._moves = 0;
    this._last = null;
    this._exploded = null;
  }

  // Section 4 of the spec, bit for bit.
  _place(r0, c0) {
    const { rows, cols, mines } = this;
    const total = rows * cols;
    const skip = r0 * cols + c0;
    const cells = new Int32Array(total - 1);
    for (let i = 0, k = 0; i < total; i++) if (i !== skip) cells[k++] = i;
    const n = cells.length;
    const rng = mulberry32(this.seed);
    for (let i = 0; i < mines; i++) {
      const j = i + Math.floor(rng() * (n - i));
      const tmp = cells[i]; cells[i] = cells[j]; cells[j] = tmp;
    }
    for (let i = 0; i < mines; i++) this._mine[cells[i]] = 1;
    for (let i = 0; i < mines; i++) {
      const idx = cells[i];
      const r = (idx / cols) | 0, c = idx - r * cols;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= cols || (dr === 0 && dc === 0)) continue;
          this._count[rr * cols + cc]++;
        }
      }
    }
    this._placed = true;
  }

  uncover(row, col) {
    if (this._result !== 0) {
      return { ok: false, code: 'WRONG_GAME', msg: 'this game is already over' };
    }
    const { rows, cols } = this;
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= rows || col < 0 || col >= cols) {
      return { ok: false, code: 'OUT_OF_BOUNDS',
        msg: `cell (${fmtCoord(row)},${fmtCoord(col)}) is off the ${rows}x${cols} board` };
    }
    const idx = row * cols + col;
    if (this._open[idx]) {
      return { ok: false, code: 'ALREADY_UNCOVERED', msg: `cell (${row},${col}) is already uncovered` };
    }
    if (!this._placed) this._place(row, col);
    this._moves++;
    this._last = [row, col];
    if (this._mine[idx]) {
      this._result = 2;
      this._reason = 'MINE';
      this._exploded = [row, col];
      return { ok: true };
    }
    this._flood(idx);
    if (this._safeOpen === this._safeTotal) this._result = 1;
    return { ok: true };
  }

  // Iterative flood fill over 8-neighbourhoods; zeros spread, numbers stop.
  _flood(start) {
    const { rows, cols } = this;
    const open = this._open, count = this._count, mine = this._mine;
    const stack = [start];
    open[start] = 1;
    this._safeOpen++;
    while (stack.length) {
      const i = stack.pop();
      if (count[i] !== 0) continue;
      const r = (i / cols) | 0, c = i - r * cols;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= cols) continue;
          const j = rr * cols + cc;
          if (open[j] || mine[j]) continue;
          open[j] = 1;
          this._safeOpen++;
          stack.push(j);
        }
      }
    }
  }

  view() {
    const { rows, cols } = this;
    const showMines = this._result === 2 && this._reason === 'MINE';
    const out = new Array(rows);
    for (let r = 0; r < rows; r++) {
      const line = new Array(cols);
      const base = r * cols;
      for (let c = 0; c < cols; c++) {
        const i = base + c;
        if (this._open[i]) line[c] = this._count[i];
        else line[c] = showMines && this._mine[i] ? MINE : COVERED;
      }
      out[r] = line;
    }
    return out;
  }

  forfeit(reason) {
    if (!FORFEIT_REASONS.includes(reason)) throw new Error(`Unknown forfeit reason: ${reason}`);
    if (this._result !== 0) return false;
    this._result = 2;
    this._reason = reason;
    return true;
  }

  get result() { return this._result; }
  get reason() { return this._reason; }
  get moves() { return this._moves; }
  get last() { return this._last ? [this._last[0], this._last[1]] : null; }
  get exploded() { return this._exploded ? [this._exploded[0], this._exploded[1]] : null; }
  get placed() { return this._placed; }

  mineIndices() {
    if (!this._placed) throw new Error('Mines are not placed until the first uncover.');
    const out = [];
    for (let i = 0; i < this._mine.length; i++) if (this._mine[i]) out.push(i);
    return out;
  }
}
// ENGINE END

// RUNNER START
// Protocol state machine: owns the socket, timeouts, seeds and stats. No DOM.
const PROTOCOL_VERSION = 1;
const ACTIVE_PHASES = ['connecting', 'handshake', 'running', 'paused'];

const defaultTimers = {
  now: () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

class Runner {
  // `timers` ({ now, setTimeout, clearTimeout }) exists only so tests can use a fake clock.
  constructor({
    url, preset, rows, cols, mines, games, baseSeed,
    moveTimeoutMs = 5000, handshakeTimeoutMs = 5000,
    errorLimit = 20, delayMs = 0,
    socketFactory = (u) => new WebSocket(u),
    timers = defaultTimers,
  } = {}) {
    let size;
    if (preset !== undefined) {
      size = PRESETS[preset];
      if (!size) throw new Error(`Unknown preset: ${preset}`);
    } else {
      size = { rows, cols, mines };
    }
    const err = validateConfig(size);
    if (err) throw new Error(err);
    if (!Number.isInteger(games) || games < 1) throw new Error('games must be a positive integer');
    if (!Number.isInteger(baseSeed) || baseSeed < 0 || baseSeed > 0xFFFFFFFF) {
      throw new Error('baseSeed must be an unsigned 32-bit integer');
    }
    this.url = url;
    this.rows = size.rows;
    this.cols = size.cols;
    this.mines = size.mines;
    this.games = games;
    this.baseSeed = baseSeed >>> 0;
    this.moveTimeoutMs = moveTimeoutMs;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.errorLimit = errorLimit;
    this.delayMs = Math.max(0, Number(delayMs) || 0);
    this._socketFactory = socketFactory;
    this._t = timers;

    this._listeners = Object.create(null);
    this._phase = 'idle';
    this._ws = null;
    this._k = 0;
    this._game = null;
    this._recorded = false;
    this._errors = 0;
    this._awaiting = false;
    this._pending = false;
    this._paused = false;
    this._delayTimer = null;
    this._moveTimer = null;
    this._moveRemaining = 0;
    this._waitStart = 0;
    this._gameMs = 0;
    this._handshakeTimer = null;
    this._closeTimer = null;
    this._runStart = null;
    this._runEnd = null;
    this._pausedAt = null;
    this._pausedTotal = 0;
    this._history = [];
    this._stats = {
      played: 0, won: 0, lost: 0,
      lossReasons: { MINE: 0, TIMEOUT: 0, ERROR_LIMIT: 0, DISCONNECT: 0 },
      totalMoves: 0,
    };
  }

  // ---- public API ----

  on(event, fn) {
    (this._listeners[event] || (this._listeners[event] = [])).push(fn);
    return this;
  }

  get phase() { return this._phase; }

  get stats() {
    const s = this._stats;
    return {
      played: s.played, won: s.won, lost: s.lost,
      lossReasons: Object.assign({}, s.lossReasons),
      totalMoves: s.totalMoves,
      elapsedMs: Math.round(this._elapsed()),
    };
  }

  get history() { return this._history.slice(); }

  currentGame() { return this._game; }

  start() {
    if (this._phase !== 'idle') throw new Error('A Runner can only be started once.');
    this._setPhase('connecting', `Connecting to ${this.url}`);
    let ws;
    try {
      ws = this._socketFactory(this.url);
    } catch (e) {
      this._fail(`Could not open a connection to ${this.url}: ${e && e.message ? e.message : e}`);
      return;
    }
    this._ws = ws;
    ws.onopen = () => this._onOpen();
    ws.onmessage = (ev) => this._onMessage(ev.data);
    ws.onclose = () => this._onClose();
    ws.onerror = () => {}; // a close event always follows
  }

  pause() {
    if (this._phase !== 'running') return;
    this._paused = true;
    this._pausedAt = this._t.now();
    if (this._awaiting && this._moveTimer !== null) {
      const now = this._t.now();
      this._moveRemaining = Math.max(0, this._moveRemaining - (now - this._waitStart));
      this._gameMs += now - this._waitStart;
      this._t.clearTimeout(this._moveTimer);
      this._moveTimer = null;
    }
    this._setPhase('paused', `Paused at game ${this._k} of ${this.games}`);
  }

  resume() {
    if (this._phase !== 'paused') return;
    this._paused = false;
    this._pausedTotal += this._t.now() - this._pausedAt;
    this._pausedAt = null;
    this._setPhase('running', `Running game ${this._k} of ${this.games}`);
    if (this._awaiting) {
      this._waitStart = this._t.now();
      this._moveTimer = this._t.setTimeout(() => this._onMoveTimeout(), this._moveRemaining);
    }
    if (this._pending && this._delayTimer === null) {
      this._pending = false;
      this._queueState();
    }
  }

  stop() {
    if (!ACTIVE_PHASES.includes(this._phase)) return;
    const hadGames = this._phase === 'running' || this._phase === 'paused';
    this._endRun();
    this._setPhase('stopped', `Stopped by user after ${this._stats.played} of ${this.games} games.`);
    this._closeSocket();
    if (hadGames) this._emit('summary', this._summary());
  }

  setDelay(ms) {
    const v = Number(ms);
    if (Number.isFinite(v) && v >= 0) this.delayMs = v;
  }

  // ---- internals ----

  _emit(event, payload) {
    const list = this._listeners[event];
    if (!list) return;
    for (const fn of list) {
      try { fn(payload); } catch (e) { if (typeof console !== 'undefined') console.error(e); }
    }
  }

  _setPhase(phase, detail) {
    this._phase = phase;
    this._emit('status', { phase, detail });
  }

  _send(obj) {
    const raw = JSON.stringify(obj);
    if (this._listeners.message) this._emit('message', { dir: 'out', raw });
    try { this._ws.send(raw); } catch (e) { /* the close handler deals with dead sockets */ }
  }

  _elapsed() {
    if (this._runStart === null) return 0;
    const end = this._runEnd !== null ? this._runEnd : this._t.now();
    const pausedNow = this._pausedAt !== null ? end - this._pausedAt : 0;
    return Math.max(0, end - this._runStart - this._pausedTotal - pausedNow);
  }

  _clearTimers() {
    for (const k of ['_delayTimer', '_moveTimer', '_handshakeTimer']) {
      if (this[k] !== null) { this._t.clearTimeout(this[k]); this[k] = null; }
    }
  }

  _endRun() {
    this._clearTimers();
    if (this._awaiting) {
      this._gameMs += this._t.now() - this._waitStart;
      this._awaiting = false;
    }
    this._pending = false;
    if (this._runStart !== null && this._runEnd === null) {
      this._runEnd = this._t.now();
      if (this._pausedAt !== null) { this._pausedTotal += this._runEnd - this._pausedAt; this._pausedAt = null; }
    }
  }

  _closeSocket() {
    const ws = this._ws;
    if (!ws) return;
    try { ws.close(); } catch (e) { /* already closed */ }
  }

  _fail(detail) {
    this._endRun();
    this._setPhase('failed', detail);
    this._closeSocket();
  }

  _onOpen() {
    if (this._phase !== 'connecting') return;
    this._setPhase('handshake', `Connected to ${this.url}. Waiting for READY from the bot.`);
    this._send({ type: 'HELLO', protocol: PROTOCOL_VERSION });
    this._handshakeTimer = this._t.setTimeout(() => {
      this._handshakeTimer = null;
      if (this._phase === 'handshake') {
        this._fail(`The bot did not send READY within ${this.handshakeTimeoutMs} ms. No games were played.`);
      }
    }, this.handshakeTimeoutMs);
  }

  _onClose() {
    const phase = this._phase;
    if (phase === 'connecting') {
      this._fail(`Could not connect to ${this.url}. Is the bot running?`);
    } else if (phase === 'handshake') {
      this._fail('The bot closed the connection before sending READY. No games were played.');
    } else if (phase === 'running' || phase === 'paused') {
      const k = this._k;
      this._endRun();
      if (this._game && !this._recorded) {
        this._game.forfeit('DISCONNECT'); // no-op if the game had already ended
        this._record();
      }
      this._setPhase('stopped', `The bot disconnected during game ${k}. The run stopped after ${this._stats.played} of ${this.games} games.`);
      this._emit('summary', this._summary());
    }
  }

  _onMessage(data) {
    const raw = typeof data === 'string' ? data : null;
    if (this._listeners.message) this._emit('message', { dir: 'in', raw: raw === null ? '[binary frame]' : raw });
    if (this._phase === 'handshake') {
      let msg = null;
      try { msg = JSON.parse(raw); } catch (e) { /* ignored until READY */ }
      if (msg && typeof msg === 'object' && msg.type === 'READY') this._beginRun(msg);
      return;
    }
    if (this._phase === 'running' || this._phase === 'paused') this._handleBotFrame(raw);
  }

  _beginRun(msg) {
    this._t.clearTimeout(this._handshakeTimer);
    this._handshakeTimer = null;
    this._runStart = this._t.now();
    const name = typeof msg.name === 'string' && msg.name ? `Bot "${msg.name}" is ready. ` : '';
    this._setPhase('running', `${name}Running ${this.games} games.`);
    this._startGame(1);
  }

  _startGame(k) {
    this._k = k;
    this._game = new Game({ rows: this.rows, cols: this.cols, mines: this.mines, seed: gameSeed(this.baseSeed, k) });
    this._recorded = false;
    this._errors = 0;
    this._gameMs = 0;
    this._queueState();
  }

  // Every STATE goes through here so the animation delay and pause apply uniformly.
  _queueState() {
    if (this._pending) return;
    this._pending = true;
    if (this._paused) return;
    if (this.delayMs > 0) {
      this._delayTimer = this._t.setTimeout(() => {
        this._delayTimer = null;
        if (!this._paused) this._flushState();
      }, this.delayMs);
    } else {
      this._flushState();
    }
  }

  _flushState() {
    if (!this._pending) return;
    this._pending = false;
    const g = this._game;
    const view = g.view();
    const last = g.last, exploded = g.exploded;
    this._send({
      type: 'STATE',
      game: this._k, games: this.games, seed: g.seed,
      rows: g.rows, cols: g.cols, mines: g.mines,
      board: view,
      result: g.result, reason: g.reason,
      moves: g.moves, last, exploded,
    });
    this._emit('state', { game: this._k, view, result: g.result, reason: g.reason, last, exploded });
    if (g.result === 0) {
      this._awaiting = true;
      this._waitStart = this._t.now();
      this._moveRemaining = this.moveTimeoutMs;
      this._moveTimer = this._t.setTimeout(() => this._onMoveTimeout(), this.moveTimeoutMs);
    } else {
      this._finishGame();
    }
  }

  _stopWaiting() {
    if (!this._awaiting) return;
    if (this._moveTimer !== null) {
      this._t.clearTimeout(this._moveTimer);
      this._moveTimer = null;
      this._gameMs += this._t.now() - this._waitStart;
    }
    this._awaiting = false;
  }

  _onMoveTimeout() {
    this._moveTimer = null;
    if (!this._awaiting) return;
    this._gameMs += this._t.now() - this._waitStart;
    this._awaiting = false;
    this._game.forfeit('TIMEOUT');
    this._queueState();
  }

  _handleBotFrame(raw) {
    if (raw === null) return this._reject('BAD_MESSAGE', 'binary frames are not allowed');
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return this._reject('BAD_MESSAGE', 'frame is not valid JSON'); }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return this._reject('BAD_MESSAGE', 'frame must be a JSON object');
    }
    if (msg.type === 'READY') return; // a repeated READY is harmless
    if (msg.type !== 'MOVE') {
      return this._reject('BAD_MESSAGE', `unexpected message type ${fmtCoord(msg.type)}`);
    }
    if (!Number.isInteger(msg.game) || !Number.isInteger(msg.row) || !Number.isInteger(msg.col)) {
      return this._reject('BAD_MESSAGE', 'MOVE needs integer fields game, row and col');
    }
    if (msg.game !== this._k || this._game.result !== 0) {
      const why = msg.game !== this._k
        ? `move is for game ${msg.game}, but game ${this._k} is in progress`
        : `game ${msg.game} is already over`;
      return this._reject('WRONG_GAME', why);
    }
    if (!this._awaiting) {
      return this._reject('NOT_YOUR_TURN', 'a move arrived before the STATE answering the previous one was sent');
    }
    this._stopWaiting();
    const res = this._game.uncover(msg.row, msg.col);
    if (!res.ok) return this._reject(res.code, res.msg);
    this._errors = 0;
    this._queueState();
  }

  // Sends ERROR and makes sure a STATE follows: either one already queued, or a resend of the current one.
  _reject(code, msg) {
    this._send({ type: 'ERROR', game: this._k, code, msg });
    this._stopWaiting();
    this._errors++;
    if (this._errors >= this.errorLimit && this._game.result === 0) this._game.forfeit('ERROR_LIMIT');
    this._queueState();
  }

  _record() {
    const g = this._game;
    const row = { game: this._k, seed: g.seed, result: g.result, reason: g.reason, moves: g.moves, ms: Math.round(this._gameMs) };
    this._recorded = true;
    this._history.push(row);
    const s = this._stats;
    s.played++;
    s.totalMoves += g.moves;
    if (g.result === 1) s.won++;
    else { s.lost++; s.lossReasons[g.reason]++; }
    this._emit('gameEnd', row);
  }

  _finishGame() {
    this._record();
    if (this._k < this.games) {
      this._startGame(this._k + 1);
    } else {
      this._complete();
    }
  }

  _complete() {
    this._endRun();
    const summary = this._summary();
    this._send(summary);
    const secs = (summary.elapsedMs / 1000).toFixed(1);
    this._setPhase('done', `Done: ${summary.played} games in ${secs} s.`);
    this._emit('summary', summary);
    this._closeTimer = this._t.setTimeout(() => { this._closeTimer = null; this._closeSocket(); }, 500);
  }

  _summary() {
    const s = this.stats;
    return {
      type: 'SUMMARY',
      played: s.played, won: s.won, lost: s.lost,
      lossReasons: s.lossReasons,
      totalMoves: s.totalMoves, elapsedMs: s.elapsedMs,
      games: this._history.slice(),
    };
  }
}
// RUNNER END

// HUMAN START
// A run played by a person clicking the board. Same events and stats shape as Runner,
// so the UI draws both the same way. No DOM, no network.
class HumanSession {
  constructor({ preset, rows, cols, mines, games, baseSeed, timers = defaultTimers } = {}) {
    const size = preset !== undefined ? PRESETS[preset] : { rows, cols, mines };
    if (!size) throw new Error(`Unknown preset: ${preset}`);
    const err = validateConfig(size);
    if (err) throw new Error(err);
    if (!Number.isInteger(games) || games < 1) throw new Error('games must be a positive integer');
    if (!Number.isInteger(baseSeed) || baseSeed < 0 || baseSeed > 0xFFFFFFFF) {
      throw new Error('baseSeed must be an unsigned 32-bit integer');
    }
    this.rows = size.rows;
    this.cols = size.cols;
    this.mines = size.mines;
    this.games = games;
    this.baseSeed = baseSeed >>> 0;
    this._t = timers;
    this._listeners = Object.create(null);
    this._phase = 'idle';
    this._k = 0;
    this._game = null;
    this._gameStart = null; // set on the first click of each game
    this._gameEnd = null;
    this._runStart = null;
    this._runEnd = null;
    this._history = [];
    this._stats = {
      played: 0, won: 0, lost: 0,
      lossReasons: { MINE: 0, TIMEOUT: 0, ERROR_LIMIT: 0, DISCONNECT: 0 },
      totalMoves: 0,
    };
  }

  on(event, fn) {
    (this._listeners[event] || (this._listeners[event] = [])).push(fn);
    return this;
  }

  get phase() { return this._phase; }

  get stats() {
    const s = this._stats;
    let elapsed = 0;
    if (this._runStart !== null) elapsed = (this._runEnd !== null ? this._runEnd : this._t.now()) - this._runStart;
    return {
      played: s.played, won: s.won, lost: s.lost,
      lossReasons: Object.assign({}, s.lossReasons),
      totalMoves: s.totalMoves,
      elapsedMs: Math.round(elapsed),
    };
  }

  get history() { return this._history.slice(); }

  currentGame() { return this._game; }

  // True between a finished game and the next one, while more games remain.
  get betweenGames() {
    return this._phase === 'running' && this._game !== null && this._game.result !== 0;
  }

  // Milliseconds since the first click of the current game (0 before it).
  gameMs() {
    if (this._gameStart === null) return 0;
    return Math.round((this._gameEnd !== null ? this._gameEnd : this._t.now()) - this._gameStart);
  }

  start() {
    if (this._phase !== 'idle') throw new Error('A HumanSession can only be started once.');
    this._runStart = this._t.now();
    this._setPhase('running', `Playing ${this.games} game${this.games === 1 ? '' : 's'} by hand.`);
    this._startGame(1);
  }

  uncover(row, col) {
    const g = this._game;
    if (this._phase !== 'running' || !g || g.result !== 0) {
      return { ok: false, code: 'WRONG_GAME', msg: 'no game in progress' };
    }
    const res = g.uncover(row, col);
    if (!res.ok) return res;
    if (this._gameStart === null) this._gameStart = this._t.now();
    this._emitState();
    if (g.result !== 0) this._finishGame();
    return res;
  }

  next() {
    if (!this.betweenGames) return false;
    this._startGame(this._k + 1);
    return true;
  }

  pause() {}
  resume() {}

  stop() {
    if (this._phase !== 'running') return;
    this._runEnd = this._t.now();
    this._setPhase('stopped', `Stopped after ${this._stats.played} of ${this.games} games.`);
    this._emit('summary', this._summary());
  }

  _emit(event, payload) {
    const list = this._listeners[event];
    if (!list) return;
    for (const fn of list) {
      try { fn(payload); } catch (e) { if (typeof console !== 'undefined') console.error(e); }
    }
  }

  _setPhase(phase, detail) {
    this._phase = phase;
    this._emit('status', { phase, detail });
  }

  _startGame(k) {
    this._k = k;
    this._game = new Game({ rows: this.rows, cols: this.cols, mines: this.mines, seed: gameSeed(this.baseSeed, k) });
    this._gameStart = null;
    this._gameEnd = null;
    this._emitState();
  }

  _emitState() {
    const g = this._game;
    this._emit('state', { game: this._k, view: g.view(), result: g.result, reason: g.reason, last: g.last, exploded: g.exploded });
  }

  _finishGame() {
    const g = this._game;
    this._gameEnd = this._t.now();
    const row = { game: this._k, seed: g.seed, result: g.result, reason: g.reason, moves: g.moves, ms: this.gameMs() };
    this._history.push(row);
    const s = this._stats;
    s.played++;
    s.totalMoves += g.moves;
    if (g.result === 1) s.won++;
    else { s.lost++; s.lossReasons[g.reason]++; }
    this._emit('gameEnd', row);
    if (this._k >= this.games) {
      this._runEnd = this._t.now();
      this._setPhase('done', `Done: ${s.played} game${s.played === 1 ? '' : 's'} played by hand.`);
      this._emit('summary', this._summary());
    }
  }

  _summary() {
    const s = this.stats;
    return {
      type: 'SUMMARY',
      played: s.played, won: s.won, lost: s.lost,
      lossReasons: s.lossReasons,
      totalMoves: s.totalMoves, elapsedMs: s.elapsedMs,
      games: this._history.slice(),
    };
  }
}
// HUMAN END

// UI: reads runner events and draws. Never touches game internals beyond the read-only Game view.
(function () {
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = 'minesweeper-bot-harness-settings-v1';
  const DEFAULTS = {
    player: 'bot', url: 'ws://localhost:8080', difficulty: 'expert', rows: 16, cols: 30, mines: 99,
    games: 100, baseSeed: null, mode: 'animated', delay: 150, moveTimeout: 5000,
  };
  const HISTORY_ROWS = 500;
  const LOG_ROWS = 200;
  const FAST_FRAME_MS = 100; // 10 redraws per second at most in Fast mode

  const el = {
    url: $('url'), difficulty: $('difficulty'), rows: $('rows'), cols: $('cols'), mines: $('mines'),
    games: $('games'), baseSeed: $('baseSeed'), reroll: $('reroll'), delay: $('delay'), delayOut: $('delayOut'),
    moveTimeout: $('moveTimeout'), modeRadios: document.querySelectorAll('input[name=mode]'),
    playerRadios: document.querySelectorAll('input[name=player]'), urlHint: $('urlHint'), tagline: $('tagline'),
    next: $('nextBtn'), start: $('startBtn'), pause: $('pauseBtn'), resume: $('resumeBtn'), stop: $('stopBtn'), status: $('status'),
    canvas: $('board'), boardWrap: $('boardWrap'), boardHead: $('boardHead'),
    replayBar: $('replayBar'), replayNote: $('replayNote'), replayRestart: $('replayRestart'), replayExit: $('replayExit'),
    stats: $('stats'), histBody: $('histBody'), histEmpty: $('histEmpty'), lossesOnly: $('lossesOnly'),
    exportBtn: $('exportBtn'), logBox: $('logBox'), log: $('log'),
  };

  // ---------- state ----------
  const ui = {
    runner: null,
    phase: 'idle',
    detail: '',
    run: null,            // snapshot of the settings the current/last run used
    live: null,           // what the board shows for the run
    recent: [],           // last games, oldest first (trimmed to HISTORY_ROWS)
    recentBase: 0,        // how many games were trimmed off the front of `recent`
    histShown: 0,         // absolute count of games already in the table
    histFilter: null,     // the losses-only setting the table was built with
    firstMoves: new Map(),// game -> bot's first move, so replays use the same mine layout
    totalMs: 0,
    summary: null,
    replay: null,
    log: [], logSeq: 0, logExpanded: new Set(),
  };

  // ---------- settings ----------
  function randomSeed() {
    try { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0]; }
    catch (e) { return Math.floor(Math.random() * 4294967296) >>> 0; }
  }

  function loadSettings() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { saved = null; }
    const s = Object.assign({}, DEFAULTS, saved && typeof saved === 'object' ? saved : {});
    if (!Number.isInteger(s.baseSeed) || s.baseSeed < 0 || s.baseSeed > 0xFFFFFFFF) s.baseSeed = randomSeed();
    if (s.mode !== 'fast' && s.mode !== 'animated') s.mode = 'animated';
    if (s.player !== 'human' && s.player !== 'bot') s.player = 'bot';
    if (!PRESETS[s.difficulty] && s.difficulty !== 'custom') s.difficulty = 'expert';
    return s;
  }

  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(readForm())); } catch (e) { /* storage blocked */ }
  }

  function getMode() {
    for (const r of el.modeRadios) if (r.checked) return r.value;
    return 'animated';
  }

  function getPlayer() {
    for (const r of el.playerRadios) if (r.checked) return r.value;
    return 'bot';
  }

  function urlValid(url) { return /^wss?:\/\/[^\s/]+\S*$/i.test(url); }

  function num(input) {
    const t = input.value.trim();
    return t === '' ? NaN : Number(t);
  }

  function readForm() {
    return {
      player: getPlayer(), url: el.url.value.trim(), difficulty: el.difficulty.value,
      rows: num(el.rows), cols: num(el.cols), mines: num(el.mines),
      games: num(el.games), baseSeed: num(el.baseSeed), mode: getMode(),
      delay: Number(el.delay.value), moveTimeout: num(el.moveTimeout),
    };
  }

  function applySettings(s) {
    for (const r of el.playerRadios) r.checked = r.value === s.player;
    el.url.value = s.url;
    el.difficulty.value = s.difficulty;
    el.rows.value = s.rows; el.cols.value = s.cols; el.mines.value = s.mines;
    if (PRESETS[s.difficulty]) fillPreset(s.difficulty);
    el.games.value = s.games;
    el.baseSeed.value = s.baseSeed;
    for (const r of el.modeRadios) r.checked = r.value === s.mode;
    el.delay.value = s.delay;
    el.moveTimeout.value = s.moveTimeout;
    el.delayOut.textContent = `${el.delay.value} ms`;
  }

  function fillPreset(name) {
    const p = PRESETS[name];
    el.rows.value = p.rows; el.cols.value = p.cols; el.mines.value = p.mines;
  }

  function validateForm() {
    const f = readForm();
    const errors = [];
    const bot = f.player === 'bot';
    if (bot && !urlValid(f.url)) errors.push(['url', 'Enter a valid bot URL starting with ws:// or wss://.']);
    const sizeErr = validateConfig({ rows: f.rows, cols: f.cols, mines: f.mines });
    if (sizeErr) {
      const field = /^Rows/.test(sizeErr) ? 'rows' : /^Cols/.test(sizeErr) ? 'cols' : 'mines';
      errors.push([field, sizeErr]);
    }
    if (!Number.isInteger(f.games) || f.games < 1 || f.games > 1000000) errors.push(['games', 'Games must be a whole number from 1 to 1,000,000.']);
    if (!Number.isInteger(f.baseSeed) || f.baseSeed < 0 || f.baseSeed > 0xFFFFFFFF) errors.push(['baseSeed', 'Base seed must be a whole number from 0 to 4294967295.']);
    if (bot && (!Number.isInteger(f.moveTimeout) || f.moveTimeout < 100 || f.moveTimeout > 60000)) errors.push(['moveTimeout', 'Move timeout must be a whole number of ms from 100 to 60000.']);
    for (const k of ['url', 'rows', 'cols', 'mines', 'games', 'baseSeed', 'moveTimeout']) el[k].removeAttribute('aria-invalid');
    for (const [k] of errors) el[k].setAttribute('aria-invalid', 'true');
    return { form: f, errors };
  }

  function isActive() { return ACTIVE_PHASES.includes(ui.phase); }
  function isFastRun() { return ui.run && ui.run.mode === 'fast' && isActive(); }

  function isHumanRun() { return ui.run !== null && ui.run.player === 'human'; }

  function syncControls() {
    const active = isActive();
    const custom = el.difficulty.value === 'custom';
    // While a run is active the page shows the controls for that run's player.
    const human = active ? isHumanRun() : getPlayer() === 'human';
    document.body.classList.toggle('human', human);
    el.tagline.textContent = human
      ? 'human play · click a cell to uncover it'
      : 'protocol v1 · board is the client, the bot is the server';
    for (const k of ['url', 'difficulty', 'games', 'baseSeed', 'moveTimeout', 'reroll']) el[k].disabled = active;
    for (const k of ['rows', 'cols', 'mines']) el[k].disabled = active || !custom;
    for (const r of el.modeRadios) r.disabled = active;
    for (const r of el.playerRadios) r.disabled = active;
    el.delay.disabled = getMode() !== 'animated';
    // Bot play needs a usable URL before Start is allowed.
    const badUrl = !human && !urlValid(el.url.value.trim());
    el.urlHint.hidden = !badUrl;
    if (badUrl) el.url.setAttribute('aria-invalid', 'true'); else el.url.removeAttribute('aria-invalid');
    el.start.disabled = badUrl;
    el.start.title = badUrl ? 'Enter a bot URL starting with ws:// or wss://' : '';
    el.start.hidden = active;
    el.next.hidden = !(active && human && ui.runner && ui.runner.betweenGames);
    el.pause.hidden = human || ui.phase !== 'running';
    el.resume.hidden = human || ui.phase !== 'paused';
    el.stop.hidden = !active;
    el.canvas.classList.toggle('clickable', !!ui.replay || (active && human));
    if (!active && !ui.run) {
      // Before the first run, show a starter message that matches the chosen player.
      setStatus(human ? 'Press Start, then click the board to play.' : 'Start the bot, then press Start.');
    }
    el.exportBtn.disabled = !ui.runner || ui.recent.length === 0;
  }

  // ---------- run control ----------
  function startRun() {
    const { form, errors } = validateForm();
    if (errors.length) {
      setStatus(errors.map((e) => e[1]).join(' '), 'error');
      return;
    }
    saveSettings();
    exitReplay(false);
    const human = form.player === 'human';
    const run = human
      ? { player: 'human', difficulty: form.difficulty, rows: form.rows, cols: form.cols, mines: form.mines,
          games: form.games, baseSeed: form.baseSeed >>> 0, mode: 'animated', startedAt: new Date().toISOString() }
      : { player: 'bot', url: form.url, difficulty: form.difficulty, rows: form.rows, cols: form.cols, mines: form.mines,
          games: form.games, baseSeed: form.baseSeed >>> 0, mode: form.mode,
          moveTimeoutMs: form.moveTimeout, startedAt: new Date().toISOString() };
    let r;
    try {
      r = human
        ? new HumanSession({ rows: run.rows, cols: run.cols, mines: run.mines, games: run.games, baseSeed: run.baseSeed })
        : new Runner({
          url: run.url, rows: run.rows, cols: run.cols, mines: run.mines, games: run.games,
          baseSeed: run.baseSeed, moveTimeoutMs: run.moveTimeoutMs,
          delayMs: run.mode === 'animated' ? form.delay : 0,
        });
    } catch (e) {
      setStatus(`Could not start: ${e.message}`, 'error');
      return;
    }
    ui.runner = r;
    ui.run = run;
    ui.recent = []; ui.recentBase = 0; ui.histShown = 0; ui.histFilter = null;
    ui.firstMoves = new Map();
    ui.totalMs = 0;
    ui.summary = null;
    ui.log = []; ui.logSeq = 0; ui.logExpanded.clear();
    ui.live = { game: 0, seed: null, view: null, last: null, exploded: null, result: 0, reason: null, moves: 0, ms: null, startedAt: 0 };

    r.on('status', (s) => {
      if (ui.runner !== r) return;
      ui.phase = s.phase;
      ui.detail = s.detail;
      syncControls();
      markDirty('status', 'stats', 'board');
    });
    r.on('state', (s) => {
      if (ui.runner !== r) return;
      const L = ui.live;
      if (L.game !== s.game) {
        L.game = s.game; L.ms = null; L.startedAt = performance.now();
      }
      if (s.last && !ui.firstMoves.has(s.game)) {
        ui.firstMoves.set(s.game, s.last);
        if (ui.firstMoves.size > HISTORY_ROWS + 100) {
          const oldest = ui.firstMoves.keys().next().value;
          ui.firstMoves.delete(oldest);
        }
      }
      // Fast mode only draws finished games; gameEnd fills those in.
      if (ui.run.mode !== 'animated') return;
      const g = r.currentGame();
      L.seed = g.seed; L.moves = g.moves;
      L.view = s.view; L.last = s.last; L.exploded = s.exploded; L.result = s.result; L.reason = s.reason;
      markDirty('board');
    });
    r.on('gameEnd', (row) => {
      if (ui.runner !== r) return;
      ui.recent.push(row);
      if (ui.recent.length > HISTORY_ROWS * 2) {
        const drop = ui.recent.length - HISTORY_ROWS;
        ui.recent.splice(0, drop);
        ui.recentBase += drop;
      }
      ui.totalMs += row.ms;
      // gameEnd fires before the next game starts, so currentGame() is still the finished one.
      // A disconnect ends a game without a STATE, so the final board comes from here, not 'state'.
      const L = ui.live, g = r.currentGame();
      if (L.game !== row.game) { L.game = row.game; L.startedAt = performance.now(); }
      L.seed = row.seed; L.moves = row.moves; L.ms = row.ms; L.result = row.result; L.reason = row.reason;
      if (g && g.seed === row.seed && (ui.run.mode !== 'animated' || row.reason === 'DISCONNECT')) {
        L.view = g.view(); L.last = g.last; L.exploded = g.exploded;
      }
      if (human) syncControls(); // shows Next game
      markDirty('stats', 'history', 'status', 'board');
    });
    r.on('message', (m) => {
      if (ui.runner !== r) return;
      // Stored as-is; formatting happens only when the log is open and rendered.
      ui.log.push({ id: ++ui.logSeq, dir: m.dir, t: Date.now(), raw: m.raw, short: null });
      if (ui.log.length > LOG_ROWS * 2) ui.log.splice(0, ui.log.length - LOG_ROWS);
      if (el.logBox.open) markDirty('log');
    });
    r.on('summary', (sm) => {
      if (ui.runner !== r) return;
      ui.summary = sm;
      markDirty('stats', 'history');
    });
    r.start();
  }

  // ---------- status line ----------
  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function renderStatus() {
    const r = ui.runner;
    if (!r) return;
    const k = ui.live ? ui.live.game : 0;
    const n = ui.run.games;
    if (isHumanRun()) {
      if (ui.phase === 'running') {
        const L = ui.live;
        if (r.betweenGames) {
          const what = L.result === 1 ? 'You won' : 'You hit a mine in';
          return setStatus(`${what} game ${k} of ${n}. Press Next game or click the board to continue.`, L.result === 1 ? 'ok' : '');
        }
        return setStatus(`Game ${Math.max(1, k)} of ${n}: click a cell to uncover it.`);
      }
      if (ui.phase === 'done') return setStatus(ui.detail, 'ok');
      return setStatus(ui.detail);
    }
    switch (ui.phase) {
      case 'connecting': return setStatus(`Connecting to ${ui.run.url}`);
      case 'handshake': return setStatus(ui.detail);
      case 'running': {
        const hello = /^Bot ".*" is ready\./.exec(ui.detail);
        return setStatus(`${hello ? hello[0] + ' ' : ''}Running game ${Math.max(1, k)} of ${n}.`);
      }
      case 'paused': return setStatus(`Paused at game ${k} of ${n}.`);
      case 'done': {
        const s = r.stats;
        const gps = s.elapsedMs > 0 ? (s.played / (s.elapsedMs / 1000)) : 0;
        return setStatus(`${ui.detail} ${fmtNum(gps, 1)} games per second.`, 'ok');
      }
      case 'stopped': return setStatus(ui.detail, /disconnected/.test(ui.detail) ? 'error' : '');
      case 'failed': return setStatus(ui.detail, 'error');
      default: return undefined;
    }
  }

  // ---------- render scheduling ----------
  const dirty = new Set();
  let renderQueued = false;
  let lastRender = 0;

  function markDirty(...parts) {
    for (const p of parts) dirty.add(p);
    if (renderQueued) return;
    renderQueued = true;
    const wait = isFastRun() ? Math.max(0, FAST_FRAME_MS - (performance.now() - lastRender)) : 0;
    const go = () => requestAnimationFrame(doRender);
    if (wait > 0) setTimeout(go, wait); else go();
  }

  function doRender() {
    renderQueued = false;
    lastRender = performance.now();
    const parts = new Set(dirty);
    dirty.clear();
    if (parts.has('status')) renderStatus();
    if (parts.has('board')) drawCurrent();
    else if (parts.has('head')) renderBoardHead();
    if (parts.has('stats')) renderStats();
    if (parts.has('history')) renderHistory();
    if (parts.has('log')) renderLog();
  }

  // ---------- board drawing ----------
  let colors = null;
  let cellPx = 20;

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    colors = {
      covered: v('--cell-covered'), hi: v('--cell-covered-hi'), lo: v('--cell-covered-lo'),
      open: v('--cell-open'), grid: v('--cell-grid'), mine: v('--mine'),
      exploded: v('--exploded-bg'), last: v('--last-outline'),
      nums: [null, v('--n1'), v('--n2'), v('--n3'), v('--n4'), v('--n5'), v('--n6'), v('--n7'), v('--n8')],
    };
  }

  function boardSize() {
    if (ui.replay) return { rows: ui.replay.game.rows, cols: ui.replay.game.cols };
    if (ui.run) return { rows: ui.run.rows, cols: ui.run.cols };
    const f = readForm();
    if (validateConfig({ rows: f.rows, cols: f.cols, mines: f.mines })) return { rows: 16, cols: 30 };
    return { rows: f.rows, cols: f.cols };
  }

  function drawCurrent() {
    let view, last, exploded;
    if (ui.replay) {
      const g = ui.replay.game;
      view = g.view(); last = g.last; exploded = g.exploded;
    } else if (ui.live && ui.live.view) {
      view = ui.live.view; last = ui.live.last; exploded = ui.live.exploded;
    }
    const { rows, cols } = boardSize();
    drawBoard(view, rows, cols, last, exploded);
    renderBoardHead();
  }

  function drawBoard(view, rows, cols, last, exploded) {
    if (!colors) readColors();
    const avail = Math.max(0, el.boardWrap.clientWidth);
    cellPx = Math.max(16, Math.min(36, Math.floor(avail / cols)));
    const w = cellPx * cols, h = cellPx * rows;
    const dpr = window.devicePixelRatio || 1;
    const cv = el.canvas;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.width = w + 'px';
      cv.style.height = h + 'px';
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const s = cellPx;
    const bevel = Math.max(2, Math.round(s / 10));
    ctx.font = `700 ${Math.round(s * 0.62)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const ex = exploded ? exploded[0] * cols + exploded[1] : -1;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * s, y = r * s;
        const v = view ? view[r][c] : COVERED;
        if (v === COVERED) {
          ctx.fillStyle = colors.covered; ctx.fillRect(x, y, s, s);
          ctx.fillStyle = colors.hi;
          ctx.fillRect(x, y, s, bevel); ctx.fillRect(x, y, bevel, s);
          ctx.fillStyle = colors.lo;
          ctx.fillRect(x, y + s - bevel, s, bevel); ctx.fillRect(x + s - bevel, y, bevel, s);
          continue;
        }
        const isExploded = r * cols + c === ex;
        ctx.fillStyle = isExploded ? colors.exploded : colors.open;
        ctx.fillRect(x, y, s, s);
        ctx.strokeStyle = colors.grid; ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
        if (v === MINE) drawMine(ctx, x, y, s);
        else if (v > 0) {
          ctx.fillStyle = colors.nums[v];
          ctx.fillText(String(v), x + s / 2, y + s / 2 + 1);
        }
      }
    }
    if (last) {
      ctx.strokeStyle = colors.last; ctx.lineWidth = 2;
      ctx.strokeRect(last[1] * s + 1, last[0] * s + 1, s - 2, s - 2);
    }
  }

  function drawMine(ctx, x, y, s) {
    const cx = x + s / 2, cy = y + s / 2, rad = s * 0.24;
    ctx.strokeStyle = colors.mine; ctx.fillStyle = colors.mine;
    ctx.lineWidth = Math.max(1, s / 14);
    ctx.beginPath();
    for (let a = 0; a < 4; a++) {
      const ang = a * Math.PI / 4;
      const dx = Math.cos(ang) * rad * 1.45, dy = Math.sin(ang) * rad * 1.45;
      ctx.moveTo(cx - dx, cy - dy); ctx.lineTo(cx + dx, cy + dy);
    }
    ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.fill();
  }

  function resultText(result, reason) {
    if (result === 1) return '<span class="res-won">Won</span>';
    if (result === 2) return `<span class="res-lost">Lost: ${reasonText(reason)}</span>`;
    return 'In progress';
  }
  function reasonText(r) {
    return { MINE: 'mine', TIMEOUT: 'timeout', ERROR_LIMIT: 'error limit', DISCONNECT: 'disconnect' }[r] || '';
  }

  function renderBoardHead() {
    if (ui.replay) {
      const g = ui.replay.game;
      el.boardHead.innerHTML =
        `<span><b>Replay</b> of game ${ui.replay.row.game}</span><span>Seed <b>${g.seed}</b></span>` +
        `<span><b>${g.moves}</b> moves</span><span>${g.placed ? resultText(g.result, g.reason) : 'Click a cell to start'}</span>`;
      return;
    }
    const L = ui.live;
    if (!L || !L.game) {
      el.boardHead.textContent = ui.run ? 'Waiting for the first game.' : 'No game yet.';
      return;
    }
    let ms;
    if (L.ms !== null) ms = `${L.ms} ms`;
    else if (isHumanRun()) ms = `${ui.runner.gameMs()} ms`;
    else if (L.result === 0 && isActive()) ms = `${Math.round(performance.now() - L.startedAt)} ms so far`;
    else ms = '…';
    el.boardHead.innerHTML =
      `<span>Game <b>${L.game}</b> of ${ui.run.games}</span><span>Seed <b>${L.seed}</b></span>` +
      `<span><b>${L.moves}</b> moves</span><span>${ms}</span><span>${resultText(L.result, L.reason)}</span>`;
  }

  // ---------- stats ----------
  function fmtNum(x, d) { return Number.isFinite(x) ? x.toFixed(d) : '–'; }

  function wilson(won, n) {
    if (n === 0) return null;
    const z = 1.96, p = won / n, z2 = z * z;
    const denom = 1 + z2 / n;
    const centre = (p + z2 / (2 * n)) / denom;
    const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom;
    return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
  }

  function renderStats() {
    const r = ui.runner;
    const s = r ? r.stats : { played: 0, won: 0, lost: 0, lossReasons: { MINE: 0, TIMEOUT: 0, ERROR_LIMIT: 0, DISCONNECT: 0 }, totalMoves: 0, elapsedMs: 0 };
    const w = wilson(s.won, s.played);
    const rate = w ? `${fmtNum(w.p * 100, 1)}% (${fmtNum(w.lo * 100, 1)} to ${fmtNum(w.hi * 100, 1)})` : '–';
    const per = (x) => (s.played ? fmtNum(x / s.played, 1) : '–');
    const gps = s.elapsedMs > 0 ? fmtNum(s.played / (s.elapsedMs / 1000), 1) : '–';
    const lr = s.lossReasons;
    const rows = [
      ['Played', s.played.toLocaleString()],
      ['Won', s.won.toLocaleString()],
      ['Lost', s.lost.toLocaleString()],
      ['Win rate (95% CI)', rate],
      ['Lost to mine', lr.MINE.toLocaleString()],
      ['Lost to timeout', lr.TIMEOUT.toLocaleString()],
      ['Lost to error limit', lr.ERROR_LIMIT.toLocaleString()],
      ['Lost to disconnect', lr.DISCONNECT.toLocaleString()],
      ['Avg moves per game', per(s.totalMoves)],
      [isHumanRun() ? 'Avg ms per game' : 'Avg bot ms per game', per(ui.totalMs)],
      ['Games per second', gps],
      ['Elapsed', `${fmtNum(s.elapsedMs / 1000, 1)} s`],
    ];
    el.stats.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }

  // ---------- history ----------
  // Rows carry an absolute index (data-a) so the table can be updated incrementally:
  // new games are prepended and games older than the last HISTORY_ROWS are trimmed.
  function renderHistory() {
    const onlyLosses = el.lossesOnly.checked;
    const total = ui.recentBase + ui.recent.length;
    const oldest = Math.max(0, total - HISTORY_ROWS);
    let from;
    if (ui.histFilter !== onlyLosses || ui.histShown > total) {
      el.histBody.textContent = '';
      ui.histFilter = onlyLosses;
      from = oldest;
    } else {
      from = Math.max(ui.histShown, oldest);
    }
    const out = [];
    for (let a = total - 1; a >= from; a--) {
      const h = ui.recent[a - ui.recentBase];
      if (onlyLosses && h.result !== 2) continue;
      const res = h.result === 1 ? '<td class="won">won</td>' : '<td class="lost">lost</td>';
      out.push(`<tr data-a="${a}" title="Replay game ${h.game} by hand"><td>${h.game}</td><td>${h.seed}</td>${res}<td>${h.reason ? reasonText(h.reason) : ''}</td><td>${h.moves}</td><td>${h.ms}</td></tr>`);
    }
    if (out.length) el.histBody.insertAdjacentHTML('afterbegin', out.join(''));
    ui.histShown = total;
    let tr = el.histBody.lastElementChild;
    while (tr && Number(tr.dataset.a) < oldest) {
      const prev = tr.previousElementSibling;
      tr.remove();
      tr = prev;
    }
    el.histEmpty.hidden = el.histBody.childElementCount > 0;
    el.histEmpty.textContent = ui.recent.length && onlyLosses ? 'No losses in the last 500 games.' : 'No games yet. Click a row to replay it by hand.';
    el.exportBtn.disabled = !ui.runner || ui.recent.length === 0;
  }

  // ---------- replay ----------
  function enterReplay(row) {
    const run = ui.run;
    const game = new Game({ rows: run.rows, cols: run.cols, mines: run.mines, seed: row.seed });
    const first = ui.firstMoves.get(row.game) || null;
    if (first) game.uncover(first[0], first[1]);
    ui.replay = { row, first, game };
    el.replayNote.textContent = first
      ? `Game ${row.game}, seed ${row.seed}. The bot's first move (${first[0]},${first[1]}) is replayed so the mines match; click to continue by hand. Run stats are not affected.`
      : `Game ${row.game}, seed ${row.seed}. The bot made no move in this game; your first click places the mines. Run stats are not affected.`;
    el.replayBar.hidden = false;
    el.canvas.classList.add('clickable');
    markDirty('board');
  }

  function exitReplay(redraw = true) {
    ui.replay = null;
    el.replayBar.hidden = true;
    syncControls();
    if (redraw) markDirty('board');
  }

  function onCanvasClick(ev) {
    const rect = el.canvas.getBoundingClientRect();
    const col = Math.floor((ev.clientX - rect.left) / cellPx);
    const row = Math.floor((ev.clientY - rect.top) / cellPx);
    if (ui.replay) {
      const g = ui.replay.game;
      if (g.result !== 0) return;
      g.uncover(row, col);
      markDirty('board');
      return;
    }
    if (!isHumanRun() || !isActive()) return;
    // Between games a click on the finished board starts the next one.
    if (ui.runner.betweenGames) nextGame();
    else ui.runner.uncover(row, col);
  }

  function nextGame() {
    if (ui.runner && isHumanRun() && ui.runner.next()) {
      syncControls();
      markDirty('status');
    }
  }

  // ---------- message log ----------
  function abbreviate(raw) {
    if (raw.indexOf('"board"') < 0 && raw.indexOf('"games":[') < 0) {
      return raw.length > 400 ? raw.slice(0, 400) + '…' : raw;
    }
    try {
      const o = JSON.parse(raw);
      if (Array.isArray(o.board)) o.board = `<${o.board.length}x${o.board[0] ? o.board[0].length : 0} board>`;
      if (Array.isArray(o.games)) o.games = `<${o.games.length} game rows>`;
      return JSON.stringify(o);
    } catch (e) {
      return raw.slice(0, 400) + (raw.length > 400 ? '…' : '');
    }
  }

  function fmtTime(t) {
    const d = new Date(t);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }

  function renderLog() {
    if (!el.logBox.open) return;
    const frag = document.createDocumentFragment();
    const start = Math.max(0, ui.log.length - LOG_ROWS);
    for (let i = ui.log.length - 1; i >= start; i--) {
      const e = ui.log[i];
      if (e.short === null) e.short = abbreviate(e.raw);
      const div = document.createElement('div');
      div.className = 'log-row ' + e.dir;
      div.dataset.id = e.id;
      const t = document.createElement('span'); t.className = 't'; t.textContent = fmtTime(e.t);
      const d = document.createElement('span'); d.className = 'd'; d.textContent = e.dir === 'out' ? 'board →' : 'bot →';
      div.append(t, d);
      if (ui.logExpanded.has(e.id)) {
        const pre = document.createElement('pre'); pre.textContent = e.raw;
        div.append(pre);
      } else {
        div.append(document.createTextNode(e.short));
      }
      frag.append(div);
    }
    if (!ui.log.length) {
      const div = document.createElement('div'); div.className = 'empty';
      div.textContent = 'No frames yet.';
      frag.append(div);
    }
    el.log.replaceChildren(frag);
  }

  // ---------- export ----------
  function exportJson() {
    const r = ui.runner;
    if (!r) return;
    const history = r.history;
    let summary;
    if (ui.summary) {
      summary = Object.assign({}, ui.summary);
      delete summary.games;
      delete summary.type;
    } else {
      summary = r.stats;
    }
    const data = { exportedAt: new Date().toISOString(), phase: ui.phase, config: ui.run, summary, history };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `minesweeper-run-${ui.run.baseSeed}-${Date.now()}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- wiring ----------
  function init() {
    applySettings(loadSettings());
    syncControls();

    el.difficulty.addEventListener('change', () => {
      if (PRESETS[el.difficulty.value]) fillPreset(el.difficulty.value);
      syncControls(); validateForm(); saveSettings();
      if (!ui.run) markDirty('board');
    });
    for (const k of ['url', 'rows', 'cols', 'mines', 'games', 'baseSeed', 'moveTimeout']) {
      el[k].addEventListener('change', () => {
        validateForm(); saveSettings();
        if (!ui.run) markDirty('board');
      });
    }
    el.reroll.addEventListener('click', () => { el.baseSeed.value = randomSeed(); validateForm(); saveSettings(); });
    for (const r of el.modeRadios) r.addEventListener('change', () => { syncControls(); saveSettings(); });
    el.delay.addEventListener('input', () => {
      el.delayOut.textContent = `${el.delay.value} ms`;
      if (ui.runner && isActive() && ui.run.mode === 'animated') ui.runner.setDelay(Number(el.delay.value));
    });
    el.delay.addEventListener('change', saveSettings);

    el.start.addEventListener('click', startRun);
    el.next.addEventListener('click', nextGame);
    for (const r of el.playerRadios) r.addEventListener('change', () => { syncControls(); validateForm(); saveSettings(); });
    el.url.addEventListener('input', syncControls);
    // Human games show a running clock in the board header.
    setInterval(() => {
      if (isHumanRun() && isActive() && !ui.replay && ui.live && ui.live.ms === null && ui.runner.gameMs() > 0) markDirty('head');
    }, 200);
    el.pause.addEventListener('click', () => ui.runner && ui.runner.pause());
    el.resume.addEventListener('click', () => { exitReplay(); if (ui.runner) ui.runner.resume(); });
    el.stop.addEventListener('click', () => ui.runner && ui.runner.stop());

    el.histBody.addEventListener('click', (ev) => {
      const tr = ev.target.closest('tr[data-a]');
      if (!tr) return;
      const row = ui.recent[Number(tr.dataset.a) - ui.recentBase];
      if (row) enterReplay(row);
    });
    el.lossesOnly.addEventListener('change', () => markDirty('history'));
    el.exportBtn.addEventListener('click', exportJson);

    el.canvas.addEventListener('click', onCanvasClick);
    el.replayRestart.addEventListener('click', () => { if (ui.replay) enterReplay(ui.replay.row); });
    el.replayExit.addEventListener('click', () => exitReplay());

    el.logBox.addEventListener('toggle', () => { if (el.logBox.open) markDirty('log'); });
    el.log.addEventListener('click', (ev) => {
      const row = ev.target.closest('.log-row');
      if (!row) return;
      const id = Number(row.dataset.id);
      if (ui.logExpanded.has(id)) ui.logExpanded.delete(id); else ui.logExpanded.add(id);
      markDirty('log');
    });

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onTheme = () => { colors = null; markDirty('board'); };
    if (mq.addEventListener) mq.addEventListener('change', onTheme); else if (mq.addListener) mq.addListener(onTheme);
    if (window.ResizeObserver) new ResizeObserver(() => markDirty('board')).observe(el.boardWrap);
    else window.addEventListener('resize', () => markDirty('board'));

    markDirty('board', 'stats', 'history');
  }

  init();
})();
