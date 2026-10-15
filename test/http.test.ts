import { afterEach, describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '@aderratech/contracts';
import { devSessionToken, identify } from '../src/auth/identity.js';
import { compatible } from '../src/http.js';

const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name.toLowerCase()] ?? null });

const principal = (claims: { typ: string; val: string }[]) =>
  Buffer.from(JSON.stringify({ auth_typ: 'google', claims, name_typ: 'name', role_typ: 'role' })).toString('base64');

afterEach(() => {
  delete process.env.ADERRA_DEV_AUTH;
  delete process.env.WEBSITE_INSTANCE_ID;
});

describe('identify', () => {
  it('reads the Google user from App Service authentication headers', () => {
    const identity = identify(headers({
      'x-ms-client-principal-idp': 'google',
      'x-ms-client-principal-id': '1098765432101234567890',
      'x-ms-client-principal': principal([{ typ: 'name', val: 'Sara Tesfaye' }]),
    }));
    expect(identity).toEqual({ provider: 'google', subject: '1098765432101234567890', name: 'Sara Tesfaye', email: null });
  });

  it('ignores other identity providers', () => {
    expect(identify(headers({ 'x-ms-client-principal-idp': 'aad', 'x-ms-client-principal': principal([]) }))).toBeNull();
  });

  it('accepts dev tokens only when dev auth is on and not in Azure', () => {
    const request = headers({ 'x-zumo-auth': devSessionToken({ sub: 'manager-1', name: 'Test manager' }) });
    expect(identify(request)).toBeNull();
    process.env.ADERRA_DEV_AUTH = '1';
    expect(identify(request)).toMatchObject({ subject: 'dev-manager-1', name: 'Test manager' });
    process.env.WEBSITE_INSTANCE_ID = 'azure-instance';
    expect(identify(request)).toBeNull();
  });
});

describe('compatible', () => {
  it('accepts this contract, refuses unknown or future ones and old builds', () => {
    expect(compatible(CONTRACT_VERSION, '10003')).toBe(true);
    expect(compatible(null, '10003')).toBe(false);
    expect(compatible('99.0.0', '10003')).toBe(false);
    expect(compatible(CONTRACT_VERSION, '0')).toBe(false);
  });
});
