# Minesweeper bot harness: board spec

## 1. Purpose and split of work

Claude builds the Minesweeper board: a game engine, a WebSocket client that drives a bot through many games, and a browser UI to watch and benchmark it, all in JavaScript. I writes the bot in Go. This document is the full brief Claude works from.

## 2. Architecture

The Go bot is a WebSocket server on localhost; the board page is the client that connects to it and drives every game. A browser page cannot accept incoming connections, so the bot must be the server.

Only the runner touches the socket; the engine never sees the network and the UI never sees the protocol.

The same architecture as text:

```text
+--------------------+                      +---------------- board.html (Claude) ----------------+
|  Go bot (Revant)   |   READY, MOVE        |                                                     |
|  WebSocket server  | -------------------> |  +--------------------+      +-------------------+  |
|  ws://localhost:   |                      |  | Runner             | ---> | Engine            |  |
|  8080              | <------------------- |  | protocol, timeouts |      | rules, mines,     |  |
|                    |   HELLO, STATE,      |  | seeds, stats       |      | flood fill        |  |
+--------------------+   ERROR, SUMMARY     |  +--------------------+      | pure, no I/O      |  |
                                            |        ^          |          +-------------------+  |
                          start, pause, stop|        |          | events                          |
                                            |        |          v                                 |
                                            |  +-----------------------------------------------+  |
                                            |  | UI: controls, canvas board, stats, history,   |  |
                                            |  |     message log                               |  |
                                            |  +-----------------------------------------------+  |
                                            +-----------------------------------------------------+
```

- **Bot address:** `ws://localhost:8080` by default, editable in the UI. Path is whatever the URL says; the board does not assume `/`.
- **One file:** the board ships as a single `board.html` with all CSS and JS inline. No CDN, no build step, no npm packages at runtime. It must work when opened straight from disk (`file://`), which also avoids the mixed-content block a hosted `https` page would hit when connecting to `ws://localhost`.
- **One connection per run:** a run of N games uses one WebSocket. The board opens it when the user presses Start and closes it after SUMMARY or Stop.
- **Layering inside the file:** three parts, kept separate so the engine can be tested without a browser.
  1. Engine: pure functions and a `Game` class. No DOM, no WebSocket, no timers, no `Math.random`.
  2. Runner: owns the socket, the protocol state machine, timeouts, seeds and stats. No DOM.
  3. UI: reads runner events and draws. Never touches game internals directly.
- **Testability:** the engine and runner sit in one `<script>` block between the markers `// ENGINE START` and `// ENGINE END` (engine) and `// RUNNER START` and `// RUNNER END` (runner), written so a Node test can extract and `eval` them. The runner takes a socket factory as a constructor argument, so tests pass a fake socket.

## 3. Game rules the board enforces

Standard Minesweeper with one action, uncover, and a guaranteed-safe first move. There are no flags anywhere: not in the protocol, not in the engine, not in the UI.

| Preset | Rows | Cols | Mines | Density |
| --- | --- | --- | --- | --- |
| Beginner | 9 | 9 | 10 | 12.3% |
| Intermediate | 16 | 16 | 40 | 15.6% |
| Expert | 16 | 30 | 99 | 20.6% |
| Custom | 2 to 50 | 2 to 50 | 1 to rows × cols − 1 | any |

1. A new game starts with every cell covered and **no mines placed yet**.
2. The first uncover is always safe: mines are placed only at that moment, never on the clicked cell (section 4). The clicked cell may still show a number; it is not guaranteed to be a zero.
3. Uncovering a cell with no neighbouring mines opens all of its neighbours, recursively (flood fill over 8-neighbourhoods). The flood counts as one move.
4. Uncovering a mine ends the game as a loss.
5. The game is won the moment every non-mine cell is uncovered. Mines never need to be marked.
6. An illegal move (off the board, already uncovered, wrong game, malformed) changes nothing and is answered with ERROR (section 5).
7. A game also ends as a loss if the bot times out, exceeds the error limit, or disconnects (section 5).

Custom sizes must be rejected in the UI, before a run starts, if rows or cols fall outside 2 to 50 or mines is not between 1 and rows × cols − 1.

## 4. Seeding and mine placement

A game is fully determined by its seed, its size and its first move, so any game the bot loses can be replayed exactly. The algorithm below is part of the spec: Revant may reimplement it in Go to replay games offline, so Claude must follow it bit for bit and never call `Math.random` in the engine.

**Seeds.** The UI has a base seed (unsigned 32-bit integer, default random, editable, with a re-roll button). Games are numbered from 1. Game `k` uses seed `(baseSeed + k - 1) >>> 0`.

**Cell index.** `index = row * cols + col`, with `row` and `col` 0-indexed from the top-left.

**PRNG.** Mulberry32, one fresh generator per game, seeded with that game's seed, used only for mine placement:

```javascript
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
```

**Placement, run once on the first uncover at `(r0, c0)`:**

1. Build `cells` = every index from 0 to `rows * cols - 1` in ascending order, except `r0 * cols + c0`. Its length is `n = rows * cols - 1`.
2. For `i` from 0 to `mines - 1`: `j = i + Math.floor(rng() * (n - i))`, then swap `cells[i]` and `cells[j]`.
3. The mines are `cells[0 .. mines - 1]`.
4. Compute every cell's neighbour count once, then apply the first uncover as a normal move.

**Reference vector.** Claude must compute and record in the README the mine indices for seed 12345, Beginner, first move (4, 4), so a Go port can be checked against it.

## 5. Wire protocol (version 1)

Every message is one JSON object in one WebSocket text frame, with a `type` field. The board always speaks first and the bot only ever answers a STATE whose `result` is 0, with exactly one MOVE.

### 5.1 Messages

| Type | Direction | When | Bot replies with |
| --- | --- | --- | --- |
| HELLO | Board to bot | Right after the socket opens | READY |
| READY | Bot to board | Answer to HELLO | nothing more |
| STATE | Board to bot | Start of each game, after every move, after every ERROR | MOVE if `result` is 0, else nothing |
| MOVE | Bot to board | Answer to a STATE with `result` 0 | none |
| ERROR | Board to bot | A MOVE was rejected | none; a STATE follows immediately |
| SUMMARY | Board to bot | After the last game | none; either side may close |

### 5.2 Fields

```json
{"type": "HELLO", "protocol": 1}

{"type": "READY", "name": "revant-bot"}

{"type": "STATE",
 "game": 3, "games": 1000, "seed": 12347,
 "rows": 16, "cols": 30, "mines": 99,
 "board": [[-2, -2, 1, 0, 0], [-2, -2, 1, 0, 0]],
 "result": 0, "reason": null,
 "moves": 7, "last": [4, 12], "exploded": null}

{"type": "MOVE", "game": 3, "row": 7, "col": 12}

{"type": "ERROR", "game": 3, "code": "ALREADY_UNCOVERED", "msg": "cell (7,12) is already uncovered"}

{"type": "SUMMARY", "played": 1000, "won": 381, "lost": 619,
 "lossReasons": {"MINE": 612, "TIMEOUT": 4, "ERROR_LIMIT": 3, "DISCONNECT": 0},
 "totalMoves": 148220, "elapsedMs": 41873,
 "games": [{"game": 1, "seed": 12345, "result": 1, "reason": null, "moves": 152, "ms": 38}]}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `game` | int | 1-based game number within this run |
| `games` | int | total games in this run |
| `seed` | uint32 | this game's seed (section 4) |
| `rows`, `cols`, `mines` | int | board size and total mine count; constant within a game |
| `board` | int\[rows\]\[cols\] | row-major view, `board[row][col]`, encoding in 5.3 |
| `result` | int | 0 ongoing, 1 won, 2 lost |
| `reason` | string or null | null unless `result` is 2: `MINE`, `TIMEOUT`, `ERROR_LIMIT` or `DISCONNECT` |
| `moves` | int | accepted moves so far in this game (errors not counted) |
| `last` | \[row, col\] or null | the last accepted move, null before the first |
| `exploded` | \[row, col\] or null | the mine that ended the game, only when `reason` is `MINE` |
| `row`, `col` | int | 0-indexed cell the bot uncovers |
| `code` | string | `OUT_OF_BOUNDS`, `ALREADY_UNCOVERED`, `WRONG_GAME`, `BAD_MESSAGE`, `NOT_YOUR_TURN` |

Unknown extra fields in a bot message are ignored. Missing or wrongly typed required fields give `BAD_MESSAGE`.

### 5.3 Cell encoding

| Value | Meaning | When it appears |
| --- | --- | --- |
| -2 | Covered | Any time |
| 0 | Uncovered, no neighbouring mines | Any time |
| 1 to 8 | Uncovered, that many neighbouring mines | Any time |
| -3 | Mine | Only when `result` is 2 with reason `MINE`; then every mine shows as -3 |

While a game is ongoing, or after a win or a non-mine loss, the board view must never reveal a mine. On a win, mines stay -2.

### 5.4 Sequencing

1. User presses Start. Board opens the socket. On open, board sends HELLO.
2. Bot sends READY within the handshake timeout (default 5 s). Otherwise the run aborts with a UI error; no games are counted.
3. Board sends STATE for game 1 (all -2, `moves` 0, `last` null).
4. Bot sends MOVE. Board validates it, applies it, and sends the new STATE.
5. Repeat 4 until `result` is not 0. That final STATE is sent once; the bot must not answer it.
6. Board immediately sends STATE for the next game (new `game`, new `seed`). The bot tells games apart by `game`, not by timing.
7. After the last game's final STATE, board sends SUMMARY and closes the socket after 500 ms.

In animated mode the board waits the chosen delay before sending each STATE, so the bot never sees the delay as its own time.

### 5.5 Errors, timeouts and limits

- A rejected MOVE gets ERROR, then the same unchanged STATE again, so a bot loop of read STATE, send MOVE never stalls.
- `WRONG_GAME`: MOVE names a game other than the current one. A late MOVE for a finished game gets this too.
- `NOT_YOUR_TURN`: a second MOVE arrives before the board has sent the STATE answering the first. It is rejected and not applied.
- **Error limit:** 20 consecutive ERRORs in one game end it as a loss, reason `ERROR_LIMIT`. Any accepted move resets the count.
- **Move timeout:** the clock starts when a STATE with `result` 0 is sent. No MOVE within the limit (default 5000 ms, settable 100 ms to 60 s) ends the game as a loss, reason `TIMEOUT`, and the run continues with the next game.
- **Disconnect:** if the socket closes mid-run, the current game is a loss with reason `DISCONNECT`, the run stops, and the UI shows a partial summary. No reconnect.
- Non-JSON frames get `BAD_MESSAGE` and count toward the error limit.

### 5.6 Example session

```text
board: {"type":"HELLO","protocol":1}
bot:   {"type":"READY","name":"revant-bot"}
board: {"type":"STATE","game":1,"games":2,"seed":12345,"rows":9,"cols":9,"mines":10,"board":[[-2,...],...],"result":0,"reason":null,"moves":0,"last":null,"exploded":null}
bot:   {"type":"MOVE","game":1,"row":4,"col":4}
board: {"type":"STATE","game":1,...,"result":0,"moves":1,"last":[4,4],...}
bot:   {"type":"MOVE","game":1,"row":4,"col":4}
board: {"type":"ERROR","game":1,"code":"ALREADY_UNCOVERED","msg":"cell (4,4) is already uncovered"}
board: {"type":"STATE","game":1,...,"moves":1,...}
...
board: {"type":"STATE","game":1,...,"result":2,"reason":"MINE","exploded":[0,7],...}
board: {"type":"STATE","game":2,"seed":12346,...,"result":0,"moves":0,...}
...
board: {"type":"SUMMARY","played":2,"won":1,"lost":1,...}
```

## 6. Engine and runner API

The JS inside the page exposes two layers with fixed shapes: a pure engine that is the single source of truth for a game, and a runner that turns the protocol into engine calls. The UI uses only what is listed here.

### 6.1 Engine (pure, no DOM, no I/O)

```javascript
const COVERED = -2, MINE = -3;
const PRESETS = {
  beginner:     { rows: 9,  cols: 9,  mines: 10 },
  intermediate: { rows: 16, cols: 16, mines: 40 },
  expert:       { rows: 16, cols: 30, mines: 99 },
};

function mulberry32(seed)             // section 4
function validateConfig({ rows, cols, mines })  // -> null or an error string
function gameSeed(baseSeed, k)        // -> (baseSeed + k - 1) >>> 0

class Game {
  constructor({ rows, cols, mines, seed })
  uncover(row, col)   // -> { ok: true } | { ok: false, code, msg }
  view()              // -> fresh int[rows][cols] per 5.3; never shares internal arrays
  forfeit(reason)     // ends an ongoing game as a loss: 'TIMEOUT' | 'ERROR_LIMIT' | 'DISCONNECT'
  get result()        // 0 | 1 | 2
  get reason()        // null | 'MINE' | 'TIMEOUT' | 'ERROR_LIMIT' | 'DISCONNECT'
  get moves()         // accepted moves
  get last()          // [row, col] | null
  get exploded()      // [row, col] | null
  get placed()        // false until the first uncover
  mineIndices()       // sorted indices; throws if !placed. Test and replay use only
}
```

Invariants Claude must keep:

- `uncover` on a finished game returns `{ ok: false, code: 'WRONG_GAME' }` and changes nothing.
- `uncover` never throws on bad input; non-integer or out-of-range coordinates return `OUT_OF_BOUNDS`.
- Flood fill is iterative (an explicit stack), not recursive, so a 50 × 50 board with one mine cannot overflow the call stack.
- Uncovered-safe count is tracked incrementally; win is `uncoveredSafe === rows * cols - mines`, not a full scan.
- `view()` while `result` is 0 contains only -2 and 0 to 8.

### 6.2 Runner (protocol, no DOM)

```javascript
class Runner {
  constructor({ url, preset or rows/cols/mines, games, baseSeed,
                moveTimeoutMs = 5000, handshakeTimeoutMs = 5000,
                errorLimit = 20, delayMs = 0,
                socketFactory = (url) => new WebSocket(url) })
  start()             // opens socket, runs the state machine in 5.4
  pause() / resume()  // pause holds the next STATE; the move timeout does not run while paused
  stop()              // ends the run; current game is not counted; closes socket
  setDelay(ms)        // live change, used by the UI slider
  on(event, fn)       // events below
  get stats()         // { played, won, lost, lossReasons, totalMoves, elapsedMs }
  get history()       // array of { game, seed, result, reason, moves, ms }
  currentGame()       // the live Game, read only, for drawing
}
```

| Event | Payload | Fired when |
| --- | --- | --- |
| `status` | `{ phase, detail }` | phase is `connecting`, `handshake`, `running`, `paused`, `done`, `stopped` or `failed` |
| `state` | `{ game, view, result, reason, last, exploded }` | after every STATE the runner sends |
| `gameEnd` | one history row | a game finishes |
| `message` | `{ dir: 'in' or 'out', raw }` | every frame sent or received, for the log |
| `summary` | the SUMMARY object | the run completes or is stopped |

`pause` and `stop` are the only ways the UI changes a run in progress. Settings other than the delay are locked while a run is active.

## 7. Browser UI

One page with the board in the middle, controls on the left, and stats, history and the message log on the right; on screens under 900 px the three stack vertically in that order. The look is plain and functional: system font, light and dark themes following `prefers-color-scheme`, no animation beyond what is listed.

### 7.1 Controls panel

| Control | Type | Default | Notes |
| --- | --- | --- | --- |
| Bot URL | text | `ws://localhost:8080` | must start with `ws://` or `wss://` |
| Difficulty | select | Expert | Beginner, Intermediate, Expert, Custom |
| Rows, Cols, Mines | numbers | from preset | editable only for Custom; validated per section 3 |
| Games | number | 100 | 1 to 1,000,000 |
| Base seed | number + re-roll button | random uint32 |  |
| Mode | toggle | Animated | Animated or Fast |
| Delay | slider | 150 ms | 0 to 2000 ms, Animated only, live during a run |
| Move timeout | number | 5000 ms | 100 to 60000 |
| Start / Pause / Resume / Stop | buttons |  | only the valid ones are shown for the current phase |

A status line under the buttons shows the phase in words ("Connecting to ws://localhost:8080", "Running game 37 of 1000", "Could not connect: is the bot running?"). Every failure gets a plain sentence there, never only a console message. Settings persist in `localStorage`, wrapped in try/catch so a blocked storage never breaks the page.

### 7.2 Board

- Drawn on a `<canvas>`, sized to fit the column with square cells of at least 16 px; Expert must fit without horizontal scroll on a 1280 px window.
- Covered cells raised and grey; uncovered cells flat and lighter; numbers 1 to 8 in the classic colours (blue, green, red, navy, maroon, teal, black, grey), with dark-theme variants that stay readable.
- The last move gets a 2 px outline. On a mine loss, all mines are drawn and the exploded one sits on a red cell.
- A header above the board: game number, seed, moves, elapsed ms for this game, and the result once known.
- **Animated mode:** redraw after every STATE.
- **Fast mode:** redraw only at each game's end, and at most 10 times per second in total. The engine and runner must not wait on drawing.

### 7.3 Stats panel

Live numbers: played, won, lost, win rate with a 95% Wilson interval ("38.1% (35.1 to 41.2)"), losses by reason, average moves per game, average ms per game, and games per second. These update on every `gameEnd`, throttled to 10 per second in Fast mode.

### 7.4 History and replay

- A table of the last 500 games, newest first: game, seed, result, reason, moves, ms. A filter shows only losses.
- Clicking a row loads that game into **replay mode**: the same seed and size, played by hand with mouse clicks on the board, no bot involved. This is how Revant inspects a loss. Replay mode is clearly labelled and leaves the run's stats untouched.
- Export button: downloads the full history and summary as one JSON file.

### 7.5 Message log

Collapsed by default. When open, it shows the last 200 frames with direction, time and the raw JSON, `board` arrays abbreviated to their size unless the row is expanded. Logging must not slow Fast mode: when the log is closed, frames are not formatted at all.

## 8. Testing and acceptance

Claude delivers only after every check below passes, run with plain Node (no test framework) against the engine and runner extracted from `board.html`, plus a manual run in a browser against the mock bot.

**Engine tests (`test/engine.test.js`)**

- [ ] Same seed, size and first move give the same mines across 1,000 repeats.
- [ ] The first uncover is never a mine: 100,000 random seeds and first moves on all three presets.
- [ ] Exactly `mines` mines placed every time; none on the first-move cell.
- [ ] Neighbour counts match a brute-force recount on 1,000 random boards.
- [ ] Flood fill from a zero opens exactly the connected zero region plus its numbered border, checked against a reference BFS.
- [ ] A 50 × 50 board with 1 mine floods without a stack overflow.
- [ ] Win fires exactly when the last safe cell opens, and not before.
- [ ] `view()` never contains -3 unless the game was lost to a mine, and then contains exactly `mines` of them.
- [ ] Every illegal input returns the right error code and leaves `view()` and `moves` unchanged.
- [ ] The seed 12345 reference vector from section 4 is printed and recorded in the README.

**Runner tests (`test/runner.test.js`, fake socket)**

- [ ] Full happy path for 3 games: HELLO, READY, STATEs, final STATEs not awaited, SUMMARY, close.
- [ ] ERROR then the unchanged STATE for each error code.
- [ ] 20 consecutive errors end the game with `ERROR_LIMIT`; an accepted move in between resets the count.
- [ ] A silent bot hits `TIMEOUT` and the run moves on to the next game.
- [ ] No timeout fires while paused.
- [ ] A late MOVE for a finished game gets `WRONG_GAME`; a double MOVE gets `NOT_YOUR_TURN`.
- [ ] Socket close mid-game records `DISCONNECT` and stops the run with a partial summary.
- [ ] No READY within 5 s ends the run as `failed` with no games counted.

**Throughput**

- [ ] Fast mode with the mock bot completes 10,000 Expert games without the page freezing; Claude reports the measured games per second.

**Mock bot (`mock-bot.js`, test only)**

A Node WebSocket server on port 8080 using the `ws` package that answers each STATE by uncovering a uniformly random covered cell, with flags `--slow ms`, `--silent` (never answers), `--garbage` (sends invalid JSON) and `--double` (sends two MOVEs) to exercise the error paths by hand. It must contain no deduction of any kind.

## 9. Deliverables, non-goals and defaults

**Deliverables**

| File | What it is |
| --- | --- |
| `board.html` | The whole board: engine, runner, UI, single file, opens from disk |
| `test/engine.test.js`, `test/runner.test.js` | Node tests from section 8, run with `node test/<file>` |
| `mock-bot.js` + `package.json` | Test-only random bot; `npm install` then `node mock-bot.js` |
| `README.md` | How to open the board, run the tests and the mock bot, the seed reference vector, and a copy of section 5 as the protocol reference |

**Non-goals:** flags, chording, a hosted version, multiplayer or Minesweeper Flags, sound, any solver, hint or probability display, any Go code.

**Defaults chosen in this spec** (change them here before building, not after):

| Setting | Value |
| --- | --- |
| Bot address | `ws://localhost:8080` |
| First-move rule | first uncovered cell is never a mine; it need not be a zero |
| Move timeout | 5000 ms |
| Handshake timeout | 5000 ms |
| Consecutive error limit | 20 per game |
| Animated delay | 150 ms |
| History kept in the UI | last 500 games (full history in the export) |
| Protocol version | 1, sent in HELLO |
