import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { authenticate } from '../src/server/auth';
import type { AppEnv, Env } from '../src/server/env';
const app = new Hono<AppEnv>();
app.use('*', authenticate);
app.onError((e) =>
  Response.json({ error: e.message }, { status: 'status' in e ? (e.status as number) : 500 }),
);
app.all('*', (c) => c.json({ owner: c.get('ownerId') }));
describe('server-derived owner identity', () => {
  it('allows local preview only on loopback and ignores client owner IDs', async () => {
    const env = { AUTH_MODE: 'local' } as Env;
    const ok = await app.request('http://127.0.0.1:8787/api?ownerId=victim', {}, env);
    expect(await ok.json()).toEqual({ owner: 'local-owner' });
    expect((await app.request('https://public.example/api', {}, env)).status).toBe(403);
  });
  it('refuses cross-origin writes and fails closed without Access configuration', async () => {
    expect(
      (
        await app.request(
          'http://localhost/api',
          { method: 'POST', headers: { Origin: 'https://other.example' } },
          { AUTH_MODE: 'local' } as Env,
        )
      ).status,
    ).toBe(403);
    expect(
      (await app.request('https://app.example/api', {}, { AUTH_MODE: 'access' } as Env)).status,
    ).toBe(503);
    expect(
      (
        await app.request('https://app.example/api', {}, {
          AUTH_MODE: 'access',
          ACCESS_AUD: 'aud',
          ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
        } as Env)
      ).status,
    ).toBe(401);
  });
});
