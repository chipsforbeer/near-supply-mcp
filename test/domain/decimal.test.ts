import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, ceilCount, cmp, dec, div, mul, str, sub } from '../../src/domain/decimal.ts';

test('exact arithmetic without float errors', () => {
  assert.equal(str(add(dec('0.1'), dec('0.2'))), '0.3');
  assert.equal(str(mul(dec('0.1'), dec('0.2'))), '0.02');
  assert.equal(str(mul(mul(dec('40'), dec('9.8')), dec('1.12'))), '439.04');
  assert.equal(str(sub(dec('62.5'), dec('50'))), '12.5');
});

test('division rounds half away from zero at the requested places', () => {
  assert.equal(str(div(dec('1'), dec('3'))), '0.333333');
  assert.equal(str(div(dec('2'), dec('3'))), '0.666667');
  assert.equal(str(div(dec('-2'), dec('3'))), '-0.666667');
  assert.equal(str(div(dec('22.5'), dec('25')), 4), '0.9');
});

test('parsing accepts numbers and strings, rejects garbage', () => {
  assert.equal(str(dec(12)), '12');
  assert.equal(str(dec(' -0.500 ')), '-0.5');
  assert.throws(() => dec('1e3'));
  assert.throws(() => dec('abc'));
});

test('comparisons and counts', () => {
  assert.equal(cmp(dec('1.0'), dec('1')), 0);
  assert.equal(cmp(dec('0.9'), dec('1')), -1);
  assert.equal(ceilCount(dec('950'), dec('25')), 38n);
  assert.equal(ceilCount(dec('1000'), dec('25')), 40n);
  assert.equal(ceilCount(dec('0'), dec('25')), 0n);
});
