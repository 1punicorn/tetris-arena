import { it, expect } from 'vitest';
import { createAccessPolicy } from '../src/server/access.js';

it('keeps loopback defaults and ignores forged forwarding headers', () => {
  const policy = createAccessPolicy(4317);
  expect(policy.checkHeaders('127.0.0.1:4317', 'http://127.0.0.1:4317', 'same-origin')).toBeNull();
  expect(policy.checkHeaders('attacker.test', undefined, undefined)).toBe('invalid_host');
  expect(policy.allowsPeer('10.0.0.9')).toBe(false);
});
it('validates the exact HTTPS origin and actual trusted proxy address', () => {
  const policy = createAccessPolicy(4317, {
    host: '10.0.0.2',
    publicOrigin: 'https://arena.example.com',
    publicAccess: true,
    trustedProxyIP: '10.0.0.1',
  });
  expect(
    policy.checkHeaders('arena.example.com', 'https://arena.example.com', 'same-origin'),
  ).toBeNull();
  expect(policy.checkHeaders('arena.example.com', 'http://arena.example.com', 'same-origin')).toBe(
    'invalid_origin',
  );
  expect(policy.checkHeaders('arena.example.com', 'https://attacker.test', 'same-site')).toBe(
    'invalid_origin',
  );
  expect(policy.checkHeaders('arena.example.com', undefined, 'cross-site')).toBe(
    'cross_site_request',
  );
  expect(policy.allowsPeer('::ffff:10.0.0.1')).toBe(true);
  expect(policy.allowsPeer('10.0.0.3')).toBe(false);
});
it('requires explicit deployment and access choices', () => {
  expect(() => createAccessPolicy(4317, { host: '10.0.0.2' })).toThrow('PUBLIC_ORIGIN');
  expect(() => createAccessPolicy(4317, { publicOrigin: 'https://arena.example.com' })).toThrow(
    'PUBLIC_USERNAME',
  );
  expect(() =>
    createAccessPolicy(4317, {
      publicOrigin: 'https://arena.example.com/path',
      publicAccess: true,
    }),
  ).toThrow('PUBLIC_ORIGIN');
  expect(() =>
    createAccessPolicy(4317, {
      host: '10.0.0.2',
      publicOrigin: 'https://arena.example.com',
      publicAccess: true,
    }),
  ).toThrow('TRUSTED_PROXY_IP');
});

it('allows external links without allowing cross-site API calls, frames or writes', () => {
  const policy = createAccessPolicy(4317);
  const navigation = { method: 'GET', mode: 'navigate', destination: 'document' };
  expect(policy.checkHeaders('localhost:4317', undefined, 'cross-site', navigation)).toBeNull();
  for (const context of [
    { method: 'POST', mode: 'navigate', destination: 'document' },
    { method: 'GET', mode: 'cors', destination: 'empty' },
    { method: 'GET', mode: 'navigate', destination: 'iframe' },
    { method: 'GET', mode: 'no-cors', destination: 'script' },
    { method: 'GET', mode: 'navigate' },
  ])
    expect(policy.checkHeaders('localhost:4317', undefined, 'cross-site', context)).toBe(
      'cross_site_request',
    );
  expect(
    policy.checkHeaders('localhost:4317', 'https://attacker.test', 'cross-site', navigation),
  ).toBe('invalid_origin');
  expect(policy.checkHeaders('attacker.test', undefined, 'cross-site', navigation)).toBe(
    'invalid_host',
  );
});
