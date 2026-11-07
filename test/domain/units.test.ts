import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeInPacks, toBase, type ItemUnits } from '../../src/domain/units.ts';
import { OpError } from '../../src/ops/errors.ts';

const UOMS = new Map([
  ['each', { dimension: 'count', toSi: '1' }],
  ['g', { dimension: 'mass', toSi: '0.001' }],
  ['kg', { dimension: 'mass', toSi: '1' }],
  ['lb', { dimension: 'mass', toSi: '0.45359237' }],
  ['L', { dimension: 'volume', toSi: '1' }],
  ['mL', { dimension: 'volume', toSi: '0.001' }],
]);

const solvent: ItemUnits = {
  baseUom: 'L', uoms: UOMS, conversions: [],
  packs: [{ id: 'p1', name: '200 L drum', baseQty: '200' }],
};
const malt: ItemUnits = {
  baseUom: 'kg', uoms: UOMS, conversions: [],
  packs: [{ id: 's', name: '25 kg sack', baseQty: '25' }, { id: 'pal', name: 'pallet', baseQty: '1000' }],
};
const caustic: ItemUnits = {
  baseUom: 'kg', uoms: UOMS, conversions: [{ from: 'L', to: 'kg', factor: '1.52' }], packs: [],
};

test('packs convert to base units', () => {
  assert.equal(toBase('3', { pack: '200 L drum' }, solvent), '600');
  assert.equal(toBase('3', { pack: 'p1' }, solvent), '600');
  assert.equal(toBase('2', { pack: 'PALLET' }, malt), '2000');
});

test('units of the same dimension convert', () => {
  assert.equal(toBase('500', { uom: 'g' }, malt), '0.5');
  assert.equal(toBase('100', { uom: 'lb' }, malt), '45.359237');
  assert.equal(toBase('250', { uom: 'mL' }, solvent), '0.25');
  assert.equal(toBase('12', {}, malt), '12');
});

test('item conversions bridge dimensions both ways', () => {
  assert.equal(toBase('10', { uom: 'L' }, caustic), '15.2');
  const causticByVolume: ItemUnits = { ...caustic, baseUom: 'L' };
  assert.equal(toBase('15.2', { uom: 'kg' }, causticByVolume), '10');
});

test('impossible conversions and unknown packs are errors', () => {
  assert.throws(() => toBase('1', { uom: 'L' }, malt), (e: unknown) => e instanceof OpError && /item_conversion_set/.test(e.message));
  assert.throws(() => toBase('1', { pack: 'crate' }, malt), (e: unknown) => e instanceof OpError && /Unknown pack/.test(e.message));
  assert.throws(() => toBase('1', { uom: 'kg', pack: '25 kg sack' }, malt), OpError);
});

test('quantities are described in packs, largest first', () => {
  assert.equal(describeInPacks('720', solvent.packs, 'L'), '3 x 200 L drum + 120 L');
  assert.equal(describeInPacks('1050', malt.packs, 'kg'), '1 x pallet + 2 x 25 kg sack');
  assert.equal(describeInPacks('62.5', [], 'L'), '62.5 L');
  assert.equal(describeInPacks('0', malt.packs, 'kg'), '0 kg');
});
