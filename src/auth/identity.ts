import { devAuthEnabled } from '../config.js';

/** Who is calling, as App Service authentication (or the local dev shim) established it. */
export type Identity = {
  provider: 'google';
  /** Google's `sub`: stable for the account, never reused. Stored as app_user.identity_subject. */
  subject: string;
  name: string | null;
  email: string | null;
};

type Headers = { get(name: string): string | null };

type ClientPrincipal = { auth_typ: string; claims: { typ: string; val: string }[] };

const CLAIM = {
  subject: ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier', 'sub'],
  name: ['name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'],
  email: ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', 'email'],
};

function claim(principal: ClientPrincipal, types: string[]): string | null {
  for (const typ of types) {
    const found = principal.claims.find((c) => c.typ === typ)?.val;
    if (found) return found;
  }
  return null;
}

/**
 * In Azure: App Service authentication validates the X-ZUMO-AUTH session and
 * injects X-MS-CLIENT-PRINCIPAL* headers, which callers cannot set themselves.
 */
function fromAppService(headers: Headers): Identity | null {
  const idp = headers.get('x-ms-client-principal-idp');
  const encoded = headers.get('x-ms-client-principal');
  if (idp !== 'google' || !encoded) return null;
  const principal = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as ClientPrincipal;
  const subject = headers.get('x-ms-client-principal-id') ?? claim(principal, CLAIM.subject);
  if (!subject) return null;
  return { provider: 'google', subject, name: claim(principal, CLAIM.name), email: claim(principal, CLAIM.email) };
}

/**
 * Local development: `X-ZUMO-AUTH: dev:<base64url JSON {sub, name, email}>`,
 * so the app and tests can sign in as test users without Google.
 */
export function devSessionToken(identity: { sub: string; name?: string; email?: string }): string {
  return `dev:${Buffer.from(JSON.stringify(identity)).toString('base64url')}`;
}

function fromDevToken(headers: Headers): Identity | null {
  const token = headers.get('x-zumo-auth');
  if (!token?.startsWith('dev:')) return null;
  const { sub, name, email } = JSON.parse(Buffer.from(token.slice(4), 'base64url').toString('utf8')) as Record<string, unknown>;
  if (typeof sub !== 'string' || !sub) return null;
  return {
    provider: 'google',
    subject: `dev-${sub}`,
    name: typeof name === 'string' ? name : null,
    email: typeof email === 'string' ? email : null,
  };
}

export function identify(headers: Headers): Identity | null {
  return fromAppService(headers) ?? (devAuthEnabled() ? fromDevToken(headers) : null);
}
