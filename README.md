# Minesweeper bot harness

A Minesweeper board that referees a bot over WebSocket, or lets a person play. In Bot mode the board (`board.html`) is the client and the bot is a WebSocket server on localhost: the board generates games from a seed, sends each position to the bot, applies the bot's moves, and keeps score across many games. In Human mode you play the same seeded games by clicking the board.

The bot itself is not in this repo. `mock-bot.js` is a random player used only to test the board.

## Files

| File | What it is |
| --- | --- |
| `board.html` | Page markup and CSS. Loads `board.js`. |
| `board.js` | Engine, bot runner, human session and UI. No build step, no network dependencies. |
| `test/engine.test.js` | Engine checks (determinism, first move, counts, flood fill, win, errors). |
| `test/runner.test.js` | Protocol checks against a fake socket and a fake clock. |
| `test/human.test.js` | Human session checks (clicks, clock, win, loss, next game, stop). |
| `test/load.js` | Pulls the engine, runner and human session out of `board.js` so Node can run them. |
| `mock-bot.js`, `package.json` | Test-only random bot on port 8080. |

## Running it

Keep `board.html` and `board.js` in the same folder and open `board.html` straight from disk. Pick a player with the Player toggle at the top of the Run panel.

### Human

Choose a difficulty, the number of games and a base seed, press Start, and click cells to uncover them. The clock for each game starts on your first click. When a game ends, press Next game or click the board to go on. Stats, history, replay and export work the same as for a bot run. The URL, mode, delay, timeout and message-log controls are hidden, since none of them apply.

### Bot

1. Start a bot on `ws://localhost:8080`. To try the board without one, use the mock bot:

   ```sh
   npm install
   node mock-bot.js
   ```

2. Open `board.html` from disk (double-click it, or `file:///path/to/board.html`). Opening from `file://` avoids the mixed-content block an `https` page would hit when connecting to `ws://localhost`.

3. Select Bot and enter the bot's URL. Start stays disabled until the URL starts with `ws://` or `wss://` and names a host.

4. Choose a difficulty, the number of games and a mode, then press Start.

Fast mode sends each STATE as soon as the previous MOVE is applied and redraws at most 10 times a second. Animated mode waits the slider delay before every STATE. That delay is not counted against the bot's move timeout.

Click any row in the history table to replay that game by hand: same seed, same size, and the bot's first move is applied for you, so the mine layout is the one the bot saw. Replay never touches the run's stats. Export JSON downloads the full history with the summary.

Settings are saved in `localStorage` when it is available.

### Mock bot flags

| Flag | Effect |
| --- | --- |
| `--slow ms` | Waits `ms` before every MOVE. Set it above the move timeout to see `TIMEOUT`. |
| `--silent` | Sends READY, then never moves. Every game times out. |
| `--garbage` | Answers every STATE with invalid JSON. Every game ends with `ERROR_LIMIT`. |
| `--double` | Sends two MOVEs per STATE. Produces `NOT_YOUR_TURN`, `ALREADY_UNCOVERED` and `WRONG_GAME`. |
| `--no-ready` | Never answers HELLO, so the board's handshake times out. |
| `--port n` | Listens on another port (default 8080). |
| `--quiet` | Does not print a line per run. |

## Tests

```sh
node test/engine.test.js
node test/runner.test.js
node test/human.test.js
# or all three:
npm test
```

They use plain Node (v18 or later) with no test framework. The tests read `board.js` and evaluate the code between the `// ENGINE START` / `// ENGINE END`, `// RUNNER START` / `// RUNNER END` and `// HUMAN START` / `// HUMAN END` markers, so they test the code the page runs. The engine test also checks that this README still contains the reference vector below.

### Measured throughput

Fast mode, Expert, 10,000 games against `mock-bot.js` in headless Chrome on the development machine:

- Full page: 10,000 games in 25.2 s, **396 games per second**, about 5.6 moves per game. The longest gap in a 50 ms timer during the run was 29 ms, so the page never froze.
- Runner alone in the same browser, no UI listeners: 465 to 524 games per second.
- Runner alone in Node using the `ws` client: about 1,100 games per second.

Most of the cost is socket round trips (one per move), not board work. A real bot that thinks for longer will be the bottleneck long before the board is. Numbers vary by about 30% between runs on a busy desktop.

## Seed reference vector

Game `k` of a run uses seed `(baseSeed + k - 1) >>> 0`. Mines are placed with Mulberry32 and a partial Fisher-Yates shuffle, run once on the first uncover (spec section 4). A Go port should reproduce this exactly:

Seed 12345, Beginner (9 x 9, 10 mines), first move (4, 4). Mine indices (`row * cols + col`):

```text
[11, 25, 31, 39, 43, 63, 66, 68, 79, 80]
```

As (row, col): (1,2) (2,7) (3,4) (4,3) (4,7) (7,0) (7,3) (7,5) (8,7) (8,8).

The vector was computed by the engine and confirmed by an independent Python port of the same algorithm.

## Behaviour the spec leaves to the implementation

These follow the spec but are worth knowing when writing the bot.

- **A STATE can repeat.** After every ERROR the board sends a STATE, which may be identical to one the bot has already answered. Answer every STATE with `result` 0, even a repeat. If the bot is one MOVE behind, the extra MOVE lands as the answer to the newer STATE, usually as `ALREADY_UNCOVERED`.
- **`NOT_YOUR_TURN` only happens while a STATE is being held**, which means during an animation delay or while paused. In Fast mode the answering STATE goes out as soon as a MOVE is applied, so a second MOVE is treated as the answer to that new STATE.
- **Check order for a MOVE:** `BAD_MESSAGE` (not JSON, not an object, unknown `type`, or `game`/`row`/`col` not integers), then `WRONG_GAME` (other game number, or the game is already over), then `NOT_YOUR_TURN`, then the engine's `OUT_OF_BOUNDS` / `ALREADY_UNCOVERED`. Every one counts toward the 20-error limit.
- **Messages during the handshake** other than READY are ignored. A repeated READY later is ignored and not an error.
- **`ms` in the history and SUMMARY is the bot's time:** from each STATE with `result` 0 being sent until its MOVE (or ERROR, or timeout) arrives, summed over the game. Animation delays and pauses are excluded. `elapsedMs` is run wall time minus pauses.
- **Disconnect** ends the current game as `DISCONNECT`, stops the run (phase `stopped`) and emits a partial summary. **Stop** does not count the game in progress and does not send SUMMARY to the bot.
- **The JavaScript is in `board.js`, not inline.** The spec asked for a single `board.html`; the code was moved out on request. The page still needs no build step and still works from `file://`, as long as both files sit together.
- **Human mode** uses `HumanSession`, which has the same events, `stats`, `history` and `currentGame()` as `Runner`, plus `uncover(row, col)`, `next()` and `gameMs()`. Human games use the same seeds as bot games, so game `k` with base seed `b` has the same mines for both if the first click matches.
- **`Runner` takes one extra constructor option**, `timers: { now, setTimeout, clearTimeout }`, used by the tests to inject a fake clock. The page never sets it.

## Protocol reference (spec section 5, version 1)

Every message is one JSON object in one WebSocket text frame, with a `type` field. The board always speaks first and the bot only ever answers a STATE whose `result` is 0, with exactly one MOVE.

### Messages

| Type | Direction | When | Bot replies with |
| --- | --- | --- | --- |
| HELLO | Board to bot | Right after the socket opens | READY |
| READY | Bot to board | Answer to HELLO | nothing more |
| STATE | Board to bot | Start of each game, after every move, after every ERROR | MOVE if `result` is 0, else nothing |
| MOVE | Bot to board | Answer to a STATE with `result` 0 | none |
| ERROR | Board to bot | A MOVE was rejected | none; a STATE follows immediately |
| SUMMARY | Board to bot | After the last game | none; either side may close |

### Fields

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
| `board` | int[rows][cols] | row-major view, `board[row][col]`, encoding below |
| `result` | int | 0 ongoing, 1 won, 2 lost |
| `reason` | string or null | null unless `result` is 2: `MINE`, `TIMEOUT`, `ERROR_LIMIT` or `DISCONNECT` |
| `moves` | int | accepted moves so far in this game (errors not counted) |
| `last` | [row, col] or null | the last accepted move, null before the first |
| `exploded` | [row, col] or null | the mine that ended the game, only when `reason` is `MINE` |
| `row`, `col` | int | 0-indexed cell the bot uncovers |
| `code` | string | `OUT_OF_BOUNDS`, `ALREADY_UNCOVERED`, `WRONG_GAME`, `BAD_MESSAGE`, `NOT_YOUR_TURN` |

Unknown extra fields in a bot message are ignored. Missing or wrongly typed required fields give `BAD_MESSAGE`.

### Cell encoding

| Value | Meaning | When it appears |
| --- | --- | --- |
| -2 | Covered | Any time |
| 0 | Uncovered, no neighbouring mines | Any time |
| 1 to 8 | Uncovered, that many neighbouring mines | Any time |
| -3 | Mine | Only when `result` is 2 with reason `MINE`; then every mine shows as -3 |

While a game is ongoing, or after a win or a non-mine loss, the board view must never reveal a mine. On a win, mines stay -2.

### Sequencing

1. User presses Start. Board opens the socket. On open, board sends HELLO.
2. Bot sends READY within the handshake timeout (default 5 s). Otherwise the run aborts with a UI error; no games are counted.
3. Board sends STATE for game 1 (all -2, `moves` 0, `last` null).
4. Bot sends MOVE. Board validates it, applies it, and sends the new STATE.
5. Repeat 4 until `result` is not 0. That final STATE is sent once; the bot must not answer it.
6. Board immediately sends STATE for the next game (new `game`, new `seed`). The bot tells games apart by `game`, not by timing.
7. After the last game's final STATE, board sends SUMMARY and closes the socket after 500 ms.

In animated mode the board waits the chosen delay before sending each STATE, so the bot never sees the delay as its own time.

### Errors, timeouts and limits

- A rejected MOVE gets ERROR, then the same unchanged STATE again, so a bot loop of read STATE, send MOVE never stalls.
- `WRONG_GAME`: MOVE names a game other than the current one. A late MOVE for a finished game gets this too.
- `NOT_YOUR_TURN`: a second MOVE arrives before the board has sent the STATE answering the first. It is rejected and not applied.
- Error limit: 20 consecutive ERRORs in one game end it as a loss, reason `ERROR_LIMIT`. Any accepted move resets the count.
- Move timeout: the clock starts when a STATE with `result` 0 is sent. No MOVE within the limit (default 5000 ms, settable 100 ms to 60 s) ends the game as a loss, reason `TIMEOUT`, and the run continues with the next game.
- Disconnect: if the socket closes mid-run, the current game is a loss with reason `DISCONNECT`, the run stops, and the UI shows a partial summary. No reconnect.
- Non-JSON frames get `BAD_MESSAGE` and count toward the error limit.

### Example session

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
