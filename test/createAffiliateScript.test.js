import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(
  fileURLToPath(import.meta.url)
);
const repositoryRoot = path.resolve(testDirectory, '..');
const scriptPath = path.join(
  repositoryRoot,
  'scripts',
  'createAffiliate.js'
);

test('createAffiliate treats --test as a presence-only flag instead of coercing the string "false" to true', () => {
  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      '--name',
      'Safety Test',
      '--code',
      'SAFETYTEST',
      '--since',
      '2026-08-14',
      '--test',
      'false',
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: '',
      },
    }
  );

  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /--test is a presence-only flag/
  );
});
