#!/usr/bin/env node
'use strict';
// TEST ONLY. A throwaway bot that uncovers a uniformly random covered cell.
// It exists to exercise board.html; it contains no deduction of any kind.
//
//   node mock-bot.js [--port 8080] [--slow ms] [--silent] [--garbage] [--double] [--no-ready] [--quiet]
//
//   --slow ms    wait ms before every MOVE (set it above the move timeout to see TIMEOUT)
//   --silent     send READY, then never send a MOVE (every game times out)
//   --garbage    answer every STATE with invalid JSON (BAD_MESSAGE, then ERROR_LIMIT)
//   --double     send two MOVEs per STATE (NOT_YOUR_TURN, ALREADY_UNCOVERED, WRONG_GAME)
//   --no-ready   never answer HELLO (the board's handshake timeout fails the run)
//   --quiet      do not print per-run summaries

const { WebSocketServer } = require('ws');

function parseArgs(argv) {
  const opts = { port: 8080, slow: 0, silent: false, garbage: false, double: false, noReady: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--slow') opts.slow = Number(argv[++i]);
    else if (a === '--silent') opts.silent = true;
    else if (a === '--garbage') opts.garbage = true;
    else if (a === '--double') opts.double = true;
    else if (a === '--no-ready') opts.noReady = true;
    else if (a === '--quiet') opts.quiet = true;
    else { console.error(`unknown flag: ${a}`); process.exit(2); }
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) { console.error('--port needs 1-65535'); process.exit(2); }
  if (!Number.isFinite(opts.slow) || opts.slow < 0) { console.error('--slow needs a number of ms'); process.exit(2); }
  return opts;
}

function randomCovered(board) {
  const covered = [];
  for (let r = 0; r < board.length; r++) {
    for (let c = 0; c < board[r].length; c++) if (board[r][c] === -2) covered.push([r, c]);
  }
  return covered.length ? covered[Math.floor(Math.random() * covered.length)] : null;
}

const opts = parseArgs(process.argv.slice(2));
const wss = new WebSocketServer({ port: opts.port });
const mode = ['slow', 'silent', 'garbage', 'double', 'noReady'].filter((k) => opts[k]).join(', ') || 'random';
wss.on('listening', () => console.log(`mock bot listening on ws://localhost:${opts.port} (${mode})`));
wss.on('error', (e) => { console.error(`mock bot: ${e.message}`); process.exit(1); });

wss.on('connection', (ws) => {
  if (!opts.quiet) console.log('board connected');
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    switch (msg.type) {
      case 'HELLO':
        if (!opts.noReady) send({ type: 'READY', name: 'mock-random-bot' });
        break;
      case 'STATE': {
        if (msg.result !== 0 || opts.silent) break;
        const act = () => {
          if (opts.garbage) { if (ws.readyState === ws.OPEN) ws.send('{"type":"MOVE", this is not json'); return; }
          const cell = randomCovered(msg.board);
          if (!cell) return;
          send({ type: 'MOVE', game: msg.game, row: cell[0], col: cell[1] });
          if (opts.double) {
            const other = randomCovered(msg.board);
            send({ type: 'MOVE', game: msg.game, row: other[0], col: other[1] });
          }
        };
        if (opts.slow > 0) setTimeout(act, opts.slow); else act();
        break;
      }
      case 'ERROR':
        break;
      case 'SUMMARY':
        if (!opts.quiet) {
          const rate = msg.played ? ((100 * msg.won) / msg.played).toFixed(1) : '0.0';
          console.log(`summary: ${msg.played} played, ${msg.won} won (${rate}%), ${msg.elapsedMs} ms, losses ${JSON.stringify(msg.lossReasons)}`);
        }
        break;
      default:
        break;
    }
  });
  ws.on('close', () => { if (!opts.quiet) console.log('board disconnected'); });
});
