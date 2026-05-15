import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import bcryptjs from 'bcryptjs';
import * as argon2 from 'argon2';
import { timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';
import { getConfig } from './config';
import { getDb, generateId } from './db/index';
import { logger } from './logger';
import type { Role, SessionPayload } from './types';

// JWKS cache — createRemoteJWKSet handles caching internally
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let _discoveredEndpoints: { token_endpoint: string; end_session_endpoint?: string } | null = null;

// Brute-force protection for local login — keyed on username so IP rotation cannot bypass it
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();

function isLoginLocked(username: string): boolean {
  const entry = loginAttempts.get(username);
  if (!entry) return false;
  if (entry.lockedUntil === 0) return false;
  if (entry.lockedUntil > Date.now()) return true;
  loginAttempts.delete(username);
  return false;
}

function recordLoginFailure(username: string): void {
  const entry = loginAttempts.get(username) ?? { count: 0, lockedUntil: 0 };
  entry.count++;
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
    entry.count = 0;
    logger.warn('Local login locked out', { username });
  }
  loginAttempts.set(username, entry);
}

function clearLoginFailures(username: string): void {
  loginAttempts.delete(username);
}

async function discover() {
  if (_discoveredEndpoints) return _discoveredEndpoints;
  const cfg = getConfig().oidc;
  if (!cfg) throw new Error('OIDC is not configured');
  const res = await fetch(`${cfg.issuer}/.well-known/openid-configuration`);
  const data = await res.json() as { jwks_uri: string; token_endpoint: string; end_session_endpoint?: string };
  _jwks = createRemoteJWKSet(new URL(data.jwks_uri));
  _discoveredEndpoints = {
    token_endpoint: data.token_endpoint,
    end_session_endpoint: data.end_session_endpoint,
  };
  return _discoveredEndpoints;
}

function resolveRole(groups: string[]): Role {
  const cfg = getConfig();
  for (const mapping of cfg.rbac.mappings) {
    if (groups.includes(mapping.oidc_group)) return mapping.role;
  }
  return cfg.rbac.default_role;
}

async function signSession(payload: Omit<SessionPayload, 'exp' | 'iat'>): Promise<string> {
  const jti = generateId();
  const expiresAt = Date.now() + 86400 * 1000;
  const db = getDb();
  db.prepare('INSERT INTO sessions (id, sub, expires_at) VALUES (?, ?, ?)').run(jti, payload.sub, expiresAt);

  const secret = new TextEncoder().encode(getConfig().app.secret_key);
  return new SignJWT({ ...payload, jti } as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(secret);
}

function localAuthCredentials(): { username: string; password: string } | null {
  const username = process.env.LOCAL_ADMIN_USERNAME;
  const password = process.env.LOCAL_ADMIN_PASSWORD;
  if (username && password) return { username, password };
  return null;
}

async function checkLocalPassword(input: string, stored: string): Promise<boolean> {
  // Detect bcrypt / argon2 hashes by their prefix
  if (stored.startsWith('$2b$') || stored.startsWith('$2a$')) {
    return bcryptjs.compare(input, stored);
  }
  if (stored.startsWith('$argon2')) {
    return argon2.verify(stored, input);
  }
  // Plain text — timing-safe comparison
  const a = Buffer.from(input);
  const b = Buffer.from(stored);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isSecureCookieRequired(): boolean {
  return getConfig().app.base_url.startsWith('https://');
}

async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const secret = new TextEncoder().encode(getConfig().app.secret_key);
    const { payload } = await jwtVerify(token, secret);
    const jti = payload['jti'] as string | undefined;
    if (!jti) return null;
    const db = getDb();
    const row = db.prepare('SELECT id FROM sessions WHERE id=? AND expires_at>?').get(jti, Date.now());
    if (!row) return null;
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

export const authRouter = new Hono();

authRouter.get('/login', async (c) => {
  let endpoints: Awaited<ReturnType<typeof discover>>;
  try {
    endpoints = await discover();
  } catch (e) {
    logger.warn('OIDC discovery failed', { error: String(e) });
    return c.html(
      '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem">' +
      '<h2>SSO unavailable</h2><p>OIDC is not configured or the provider is unreachable.</p>' +
      '<a href="/">← Back</a></body></html>',
      503
    );
  }
  const cfg = getConfig();

  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString('base64url');
  const challengeBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = Buffer.from(challengeBytes).toString('base64url');
  const state = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');

  setCookie(c, 'oidc_pkce', JSON.stringify({ verifier, state }), {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: 600,
    path: '/',
  });

  const oidc = cfg.oidc!;
  const params = new URLSearchParams({
    client_id: oidc.client_id,
    response_type: 'code',
    redirect_uri: `${cfg.app.base_url}/api/auth/callback`,
    scope: oidc.scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  return c.redirect(`${oidc.issuer}/oauth2/authorize?${params}`);
});

authRouter.get('/callback', async (c) => {
  const cfg = getConfig();
  const code = c.req.query('code');
  const returnedState = c.req.query('state');
  const error = c.req.query('error');

  if (error) {
    logger.warn('OIDC callback error', { error });
    return c.redirect('/#/chat?auth_error=1');
  }

  const pkceRaw = getCookie(c, 'oidc_pkce');
  if (!pkceRaw) return c.text('Missing PKCE cookie', 400);

  const { verifier, state } = JSON.parse(pkceRaw) as { verifier: string; state: string };
  if (state !== returnedState) return c.text('State mismatch', 400);

  deleteCookie(c, 'oidc_pkce', { path: '/' });

  let endpoints: Awaited<ReturnType<typeof discover>>;
  try {
    endpoints = await discover();
  } catch {
    return c.redirect('/#/chat?auth_error=1');
  }
  const oidc = cfg.oidc!;

  // Exchange code for tokens
  const tokenRes = await fetch(endpoints.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: `${cfg.app.base_url}/api/auth/callback`,
      client_id: oidc.client_id,
      client_secret: oidc.client_secret,
      code_verifier: verifier,
    }),
  });

  if (!tokenRes.ok) {
    logger.error('Token exchange failed', { status: tokenRes.status });
    return c.redirect('/#/chat?auth_error=1');
  }

  const tokens = await tokenRes.json() as { id_token: string; access_token: string };

  // Verify ID token
  if (!_jwks) return c.text('JWKS not loaded', 500);
  const { payload: idPayload } = await jwtVerify(tokens.id_token, _jwks, {
    issuer: oidc.issuer,
    audience: oidc.client_id,
  });

  const sub = idPayload.sub!;
  const email = (idPayload['email'] as string) ?? '';
  const name = (idPayload['name'] as string) ?? (idPayload['preferred_username'] as string) ?? email;
  const groups = ((idPayload[cfg.rbac.group_claim] as string[]) ?? []);

  // Resolve role
  const db = getDb();
  const existingOverride = db.prepare(
    'SELECT role_override FROM users WHERE sub = ?'
  ).get(sub) as { role_override: string | null } | undefined;

  let role: Role;
  if (groups.some(g => cfg.rbac.mappings.some(m => m.oidc_group === g))) {
    role = resolveRole(groups);
  } else if (existingOverride?.role_override) {
    role = existingOverride.role_override as Role;
  } else {
    role = cfg.rbac.default_role;
  }

  // Upsert user
  db.prepare(
    `INSERT INTO users (sub, email, name) VALUES (?, ?, ?)
     ON CONFLICT(sub) DO UPDATE SET email=excluded.email, name=excluded.name`
  ).run(sub, email, name);

  const sessionToken = await signSession({ sub, email, name, role, method: 'oidc' });

  setCookie(c, 'session', sessionToken, {
    httpOnly: true,
    secure: isSecureCookieRequired(),
    sameSite: 'Lax',
    path: '/',
    maxAge: 86400,
  });

  logger.info('login success', { method: 'oidc', sub, email, name, role });
  return c.redirect('/');
});

export function purgeExpiredSessions(): void {
  const db = getDb();
  const { changes } = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  if (changes > 0) logger.info('Purged expired sessions', { count: changes });
}

authRouter.get('/logout', async (c) => {
  const token = getCookie(c, 'session');
  const payload = token ? await verifySession(token) : null;
  deleteCookie(c, 'session', { path: '/' });
  if (payload?.jti) getDb().prepare('DELETE FROM sessions WHERE id=?').run(payload.jti);
  logger.info('logout', { sub: payload?.sub, method: payload?.method });
  if (payload?.method === 'oidc') {
    const endpoints = await discover().catch(() => null);
    if (endpoints?.end_session_endpoint) {
      return c.redirect(endpoints.end_session_endpoint);
    }
  }
  return c.redirect('/');
});

authRouter.get('/local-enabled', (c) => {
  return c.json({ enabled: localAuthCredentials() !== null });
});

authRouter.post('/local', async (c) => {
  const creds = localAuthCredentials();
  if (!creds) return c.json({ error: 'Local auth disabled' }, 403);

  const body = await c.req.json() as { username?: string; password?: string };
  if (!body.username || !body.password) {
    return c.json({ error: 'Missing credentials' }, 400);
  }

  if (isLoginLocked(body.username)) {
    return c.json({ error: 'Too many failed attempts. Try again later.' }, 429);
  }

  logger.info('login attempt', { method: 'local', username: body.username });

  if (body.username !== creds.username) {
    recordLoginFailure(body.username);
    logger.warn('login failed', { method: 'local', reason: 'invalid credentials' });
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const valid = await checkLocalPassword(body.password, creds.password);
  if (!valid) {
    recordLoginFailure(body.username);
    logger.warn('login failed', { method: 'local', reason: 'invalid credentials' });
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  clearLoginFailures(body.username);

  const db = getDb();
  const sub = 'local:admin';
  db.prepare(
    `INSERT INTO users (sub, email, name) VALUES (?, ?, ?)
     ON CONFLICT(sub) DO UPDATE SET name=excluded.name`
  ).run(sub, '', creds.username);

  const sessionToken = await signSession({ sub, email: '', name: creds.username, role: 'admin', method: 'local' });
  setCookie(c, 'session', sessionToken, {
    httpOnly: true,
    secure: isSecureCookieRequired(),
    sameSite: 'Lax',
    path: '/',
    maxAge: 86400,
  });

  logger.info('login success', { method: 'local', username: creds.username });
  return c.json({ ok: true });
});

authRouter.get('/me', async (c) => {
  const token = getCookie(c, 'session');
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  const payload = await verifySession(token);
  if (!payload) return c.json({ error: 'Unauthorized' }, 401);
  return c.json({ sub: payload.sub, email: payload.email, name: payload.name, role: payload.role });
});

// Middleware
export async function requireAuth(c: Context, next: Next): Promise<Response | void> {
  const token = getCookie(c, 'session');
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  const payload = await verifySession(token);
  if (!payload) return c.json({ error: 'Unauthorized' }, 401);
  c.set('user', payload);
  return next();
}

export function requireRole(role: Role) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const token = getCookie(c, 'session');
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const payload = await verifySession(token);
    if (!payload) return c.json({ error: 'Unauthorized' }, 401);
    if (payload.role !== role) return c.json({ error: 'Forbidden' }, 403);
    c.set('user', payload);
    return next();
  };
}
