#!/usr/bin/env node
import { open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluateFeedback, parseStrictJSON } from '../server/feedbackEvaluation.js';

const USAGE = 'Usage: node scripts/evaluate-feedback.js --cases CASES --candidate CANDIDATE [--baseline BASELINE] [--out OUTPUT]';
const MAX_BYTES = 10 * 1024 * 1024;

function argumentsOf(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!['--cases', '--candidate', '--baseline', '--out'].includes(flag)) throw new Error('Unknown flag: ' + flag);
    if (out[flag]) throw new Error('Duplicate flag: ' + flag);
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Flag ' + flag + ' requires a path argument.');
    out[flag] = resolve(args[i + 1]);
  }
  if (!out['--cases'] || !out['--candidate']) throw new Error('The --cases and --candidate arguments are required.');
  if (out['--out'] && ['--cases', '--candidate', '--baseline'].some((flag) => out[flag] === out['--out'])) throw new Error('The output path must not overwrite an input file.');
  return out;
}

async function readJSON(path) {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Invalid input file: each file must be a regular file no larger than 10 MiB.');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw new Error('Invalid input file: each file must be no larger than 10 MiB.');
    return parseStrictJSON(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
  } finally { await handle.close(); }
}

try {
  if (process.argv.length === 3 && process.argv[2] === '--help') process.stdout.write(USAGE + '\n');
  else {
    const args = argumentsOf(process.argv.slice(2));
    const cases = await readJSON(args['--cases']);
    const candidate = await readJSON(args['--candidate']);
    const baseline = args['--baseline'] ? await readJSON(args['--baseline']) : null;
    const result = JSON.stringify(evaluateFeedback(cases, candidate, baseline), null, 2) + '\n';
    if (args['--out']) await writeFile(args['--out'], result, { mode: 0o600 });
    else process.stdout.write(result);
  }
} catch (error) {
  process.stderr.write(String(error.message || error) + '\n' + USAGE + '\n');
  process.exitCode = 1;
}
