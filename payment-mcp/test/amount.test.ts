import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, AmountError, cmp, fromUnits, toUnits } from '../src/amount.ts';

test('toUnits converts Postgres numeric strings exactly', () => {
  assert.equal(toUnits('4232.000000', 6), 4_232_000_000n);
  assert.equal(toUnits('0.000001', 6), 1n);
  assert.equal(toUnits('4174.2', 6), 4_174_200_000n);
  assert.equal(toUnits('7', 0), 7n);
  assert.equal(toUnits('1.5', 24), 1_500_000_000_000_000_000_000_000n);
});

test('toUnits refuses to round', () => {
  assert.throws(() => toUnits('1.0000001', 6), AmountError);
  assert.doesNotThrow(() => toUnits('1.0000000', 6)); // trailing zeros are fine
});

test('toUnits refuses malformed or negative input', () => {
  for (const bad of ['', '-1', '1e3', '01', '1.', '.5', 'NaN', '1,000', ' 1 2']) {
    assert.throws(() => toUnits(bad, 6), AmountError, bad);
  }
});

test('fromUnits round-trips', () => {
  assert.equal(fromUnits(4_232_000_000n, 6), '4232');
  assert.equal(fromUnits(1n, 6), '0.000001');
  assert.equal(fromUnits(0n, 6), '0');
  assert.equal(fromUnits(toUnits('12.34', 6), 6), '12.34');
});

test('cmp and add are exact', () => {
  assert.equal(cmp('4232.000000', '4300'), -1);
  assert.equal(cmp('4300.000000', '4300'), 0);
  assert.equal(cmp('4300.000001', '4300'), 1);
  assert.equal(add('0.1', '0.2'), '0.3');
  assert.equal(add(), '0');
});
