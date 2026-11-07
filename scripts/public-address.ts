import net from 'node:net';

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const V6_BLOCKED: [string, number][] = [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7],
  ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

function v6ToBigInt(ip: string): bigint {
  let s = ip.toLowerCase();
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = v4ToInt(v4[1]!);
    s = s.replace(v4[1]!, `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`);
  }
  const [head, tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g || '0', 16)), 0n);
}

function inV4(ip: string, [base, bits]: [string, number]): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((v4ToInt(ip) & mask) >>> 0) === ((v4ToInt(base) & mask) >>> 0);
}

function inV6(ip: bigint, [base, bits]: [string, number]): boolean {
  const shift = BigInt(128 - bits);
  return ip >> shift === v6ToBigInt(base) >> shift;
}

// True only for addresses on the public internet: never loopback, private, link-local
// (including the cloud metadata server 169.254.169.254), CGNAT, documentation or multicast ranges.
export function isPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return !V4_BLOCKED.some((r) => inV4(ip, r));
  if (net.isIPv6(ip)) {
    const n = v6ToBigInt(ip);
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]!);
    return !V6_BLOCKED.some((r) => inV6(n, r));
  }
  return false;
}
