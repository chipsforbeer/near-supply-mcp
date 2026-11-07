import { test } from 'node:test';
import assert from 'node:assert/strict';

test('node runs typescript tests', () => {
  const n: number = 2;
  assert.equal(n + 2, 4);
});
