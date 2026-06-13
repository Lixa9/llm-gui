import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import { timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';
import { getConfig } from './config';
import { getDb, generateId } from './db/index';
import { logger } from './logger';
import type { Role, SessionPayload } from './types';

// JWKS cache — createRemoteJWKSet handles caching internally
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let _discoveredEndpoints: { authorization_endpoint: string; token_endpoint: string; end_session_endpoint?: string } | null = null;
let _discoveredAt = 0;
const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1 hour

const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function isLoginLocked(username: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT locked_until FROM login_lockouts WHERE username=?').get(username) as { locked_until: number } | undefined;
  if (!row) return false;
  if (row.locked_until === 0) return false;
  if (row.locked_until > Date.now()) return true;
  db.prepare('DELETE FROM login_lockouts WHERE username=?').run(username);
  return false;
}

function recordLoginFailure(username: string): void {
  const db = getDb();
  const row = db.prepare('SELECT attempts FROM login_lockouts WHERE username=?').get(username) as { attempts: number } | undefined;
  const attempts = (row?.attempts ?? 0) + 1;
  let lockedUntil = 0;
  if (attempts >= LOGIN_MAX_ATTEMPTS) {
    lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
    logger.warn('Local login locked out', { username });
    db.prepare('INSERT INTO login_lockouts (username, attempts, locked_until) VALUES (?, 0, ?) ON CONFLICT(username) DO UPDATE SET attempts=0, locked_until=excluded.locked_until').run(username, lockedUntil);
  } else {
    db.prepare('INSERT INTO login_lockouts (username, attempts, locked_until) VALUES (?, ?, 0) ON CONFLICT(username) DO UPDATE SET attempts=excluded.attempts').run(username, attempts);
  }
}

function clearLoginFailures(username: string): void {
  const db = getDb();
  db.prepare('DELETE FROM login_lockouts WHERE username=?').run(username);
}

async function discover() {
  if (_discoveredEndpoints && Date.now() - _discoveredAt < DISCOVERY_TTL_MS) return _discoveredEndpoints;
  const cfg = getConfig().oidc;
  if (!cfg) throw new Error('OIDC is not configured');
  const res = await fetch(`${cfg.issuer}/.well-known/openid-configuration`);
  const data = await res.json() as { jwks_uri: string; authorization_endpoint: string; token_endpoint: string; end_session_endpoint?: string };
  _jwks = createRemoteJWKSet(new URL(data.jwks_uri));
  _discoveredEndpoints = {
    authorization_endpoint: data.authorization_endpoint,
    token_endpoint: data.token_endpoint,
    end_session_endpoint: data.end_session_endpoint,
  };
  _discoveredAt = Date.now();
  return _discoveredEndpoints;
}

function resolveRole(groups: string[]): Role {
  const cfg = getConfig();
  for (const mapping of cfg.rbac.mappings) {
    if (groups.includes(mapping.oidc_group)) return mapping.role;
  }
  const role = cfg.rbac.default_role;
  if (role === 'admin' || role === 'user') return role;
  return 'user';
}

async function signSession(payload: Omit<SessionPayload, 'exp' | 'iat' | 'jti'>): Promise<string> {
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

export function isLocalAuthEnabled(): boolean {
  const v = process.env.LOCAL_AUTH?.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
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

  const oidc = cfg.oidc;
  if (!oidc) return c.html('<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem"><h2>SSO unavailable</h2><p>OIDC is not configured.</p><a href="/">← Back</a></body></html>', 503);
  
  const redirectUri = `${cfg.app.base_url.replace(/\/$/, '')}/api/auth/callback`;
  const params = new URLSearchParams({
    client_id: oidc.client_id,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: oidc.scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  return c.redirect(`${endpoints.authorization_endpoint}?${params}`);
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

  if (!code) return c.redirect('/#/chat?auth_error=1');

  const pkceRaw = getCookie(c, 'oidc_pkce');
  if (!pkceRaw) return c.text('Missing PKCE cookie', 400);

  let verifier: string;
  let state: string;
  try {
    const parsed = JSON.parse(pkceRaw) as { verifier: string; state: string };
    verifier = parsed.verifier;
    state = parsed.state;
  } catch {
    logger.warn('Failed to parse PKCE cookie', { pkceRaw });
    return c.text('Invalid PKCE cookie', 400);
  }
  if (!verifier || !state || !returnedState || !timingSafeStringEqual(state, returnedState)) {
    return c.text('State mismatch', 400);
  }

  deleteCookie(c, 'oidc_pkce', { path: '/' });

  let endpoints: Awaited<ReturnType<typeof discover>>;
  try {
    endpoints = await discover();
  } catch {
    return c.redirect('/#/chat?auth_error=1');
  }
  const oidc = cfg.oidc;
  if (!oidc) return c.redirect('/#/chat?auth_error=1');

  const redirectUri = `${cfg.app.base_url.replace(/\/$/, '')}/api/auth/callback`;

  // Exchange code for tokens
  let tokens: { id_token: string; access_token: string };
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (oidc.client_secret) {
      headers['Authorization'] = `Basic ${Buffer.from(`${encodeURIComponent(oidc.client_id)}:${encodeURIComponent(oidc.client_secret)}`).toString('base64')}`;
    }

    const tokenRes = await fetch(endpoints.token_endpoint, {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        client_id: oidc.client_id,
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => '');
      logger.error('Token exchange failed', { status: tokenRes.status, error: errText });
      return c.redirect('/#/chat?auth_error=1');
    }

    tokens = await tokenRes.json() as { id_token: string; access_token: string };
  } catch (e) {
    logger.error('OIDC token exchange connection failed', { error: String(e) });
    return c.redirect('/#/chat?auth_error=1');
  }

  // Verify ID token
  if (!_jwks) return c.text('JWKS not loaded', 500);
  
  let idPayload;
  try {
    const verified = await jwtVerify(tokens.id_token, _jwks, {
      issuer: oidc.issuer,
      audience: oidc.client_id,
      clockTolerance: 30, // allow 30 seconds clock drift between server and IDP
    });
    idPayload = verified.payload;
  } catch (e) {
    logger.error('ID token verification failed', { error: String(e) });
    return c.redirect('/#/chat?auth_error=1');
  }

  const sub = idPayload.sub;
  if (!sub) {
    logger.error('OIDC token missing sub claim');
    return c.redirect('/#/chat?auth_error=1');
  }
  const email = (idPayload['email'] as string) ?? '';
  const name = (idPayload['name'] as string) ?? (idPayload['preferred_username'] as string) ?? email;
  const groups = (idPayload[cfg.rbac.group_claim] as string[]) ?? [];

  // Resolve role strictly from OIDC groups
  const role: Role = resolveRole(groups);

  // Upsert user
  const db = getDb();
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
  return c.json({ enabled: isLocalAuthEnabled() });
});

authRouter.post('/local', async (c) => {
  if (!isLocalAuthEnabled()) return c.json({ error: 'Local auth disabled' }, 403);

  const body = await c.req.json() as { username?: string; password?: string };
  if (!body.username || !body.password) {
    return c.json({ error: 'Missing credentials' }, 400);
  }

  if (isLoginLocked(body.username)) {
    return c.json({ error: 'Too many failed attempts. Try again later.' }, 429);
  }

  logger.info('login attempt', { method: 'local', username: body.username });

  const validUsername = timingSafeStringEqual(body.username, 'admin');
  const validPassword = timingSafeStringEqual(body.password, 'admin');
  if (!validUsername || !validPassword) {
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
  ).run(sub, '', 'admin');

  const sessionToken = await signSession({ sub, email: '', name: 'admin', role: 'admin', method: 'local' });
  setCookie(c, 'session', sessionToken, {
    httpOnly: true,
    secure: isSecureCookieRequired(),
    sameSite: 'Lax',
    path: '/',
    maxAge: 86400,
  });

  logger.info('login success', { method: 'local' });
  return c.json({ ok: true });
});

authRouter.get('/me', async (c) => {
  const token = getCookie(c, 'session');
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  const payload = await verifySession(token);
  if (!payload) return c.json({ error: 'Unauthorized' }, 401);
  return c.json({ sub: payload.sub, email: payload.email, name: payload.name, role: payload.role });
});

async function authenticate(c: Context): Promise<SessionPayload | null> {
  const token = getCookie(c, 'session');
  if (!token) return null;
  const payload = await verifySession(token);
  if (!payload) return null;
  c.set('user', payload);
  return payload;
}

// Middleware
export async function requireAuth(c: Context, next: Next): Promise<Response | void> {
  const payload = await authenticate(c);
  if (!payload) return c.json({ error: 'Unauthorized' }, 401);
  return next();
}

export function requireRole(role: Role) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const payload = await authenticate(c);
    if (!payload) return c.json({ error: 'Unauthorized' }, 401);
    if (payload.role !== role) return c.json({ error: 'Forbidden' }, 403);
    return next();
  };
}
