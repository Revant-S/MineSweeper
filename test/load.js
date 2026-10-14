'use strict';
// Extracts the engine, runner and human session from board.js (between their START/END
// markers) and evaluates them in this realm, so tests run with plain Node and no browser.
const fs = require('fs');
const path = require('path');

const BOARD = path.join(__dirname, '..', 'board.js');

function section(src, name) {
  const a = src.indexOf(`// ${name} START`);
  const b = src.indexOf(`// ${name} END`);
  if (a < 0 || b < 0 || b < a) throw new Error(`markers for ${name} not found in board.js`);
  return src.slice(a, b);
}

function source(name) {
  return section(fs.readFileSync(BOARD, 'utf8'), name);
}

function load() {
  const code = source('ENGINE') + '\n' + source('RUNNER') + '\n' + source('HUMAN');
  // eslint-disable-next-line no-new-func
  return new Function(`${code}
    return { COVERED, MINE, PRESETS, mulberry32, validateConfig, gameSeed, Game, Runner, HumanSession, PROTOCOL_VERSION };`)();
}

// Tiny test helper: named checks, a summary, and a non-zero exit code on failure.
function harness(title) {
  let passed = 0, failed = 0;
  console.log(`\n${title}`);
  return {
    check(name, fn) {
      try {
        fn();
        passed++;
        console.log(`  ok   ${name}`);
      } catch (e) {
        failed++;
        console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e}`);
      }
    },
    done() {
      console.log(`\n${passed} passed, ${failed} failed`);
      if (failed) process.exitCode = 1;
    },
  };
}

module.exports = { load, source, harness };
