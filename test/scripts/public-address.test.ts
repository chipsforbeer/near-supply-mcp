import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress } from '../../scripts/public-address.ts';

test('only public addresses pass', () => {
  for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.20.0.1', '192.168.1.1', '100.100.1.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '2001:db8::1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '9.9.9.9', '2606:4700::1111', '2a00:1450::200e']) assert.equal(isPublicAddress(ip), true, ip);
  assert.equal(isPublicAddress('not-an-ip'), false);
});
