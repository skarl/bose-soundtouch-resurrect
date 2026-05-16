// Contract test for app/reshape.js — asserts reshape() output matches
// the shared fixtures byte-equivalently. The Python suite
// resolver/test_build.py reads the same fixtures and asserts make_bose()
// matches them too. Drift between the two implementations becomes a
// red CI build, not a silent runtime bug.
//
// Run locally:
//   node --test admin/test
//

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { classify, reshape } from '../app/reshape.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures');

async function readJson(path) {
  const text = await readFile(path, 'utf8');
  return JSON.parse(text);
}

const manifest = await readJson(join(FIXTURES_DIR, 'manifest.json'));

for (const entry of manifest) {
  const { sid, name, case: caseKind } = entry;

  test(`reshape(${sid}) [${caseKind}] matches fixture`, async () => {
    const tunein = await readJson(join(FIXTURES_DIR, `${sid}.tunein.json`));
    const expected = await readJson(join(FIXTURES_DIR, `${sid}.bose.json`));
    const actual = reshape(tunein, sid, name);
    assert.deepStrictEqual(actual, expected);
  });

  test(`classify(${sid}) returns kind=${caseKind}`, async () => {
    const tunein = await readJson(join(FIXTURES_DIR, `${sid}.tunein.json`));
    const verdict = classify(tunein);
    assert.equal(verdict.kind, caseKind);
    if (caseKind === 'playable') {
      assert.ok(Array.isArray(verdict.streams), 'expected streams array');
      assert.ok(verdict.streams.length > 0, 'expected at least one stream');
    } else {
      assert.equal(typeof verdict.reason, 'string');
    }
  });
}
