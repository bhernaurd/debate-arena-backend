import assert from 'node:assert/strict';
import test from 'node:test';

import { createAccountAuthRuntime } from '../lib/accountAuthRuntime.js';

test('account auth runtime factory is available without enabling Android web auth', () => {
    assert.equal(typeof createAccountAuthRuntime, 'function');
});
