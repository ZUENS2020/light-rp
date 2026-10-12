import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AppEnv } from './env';
import { ApiError } from './errors';
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const url = new URL(c.req.url);
  if (c.env.AUTH_MODE === 'local') {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      throw new ApiError(403, '本地身份模式仅允许回环地址', 'LOCAL_AUTH_ONLY');
    c.set('ownerId', 'local-owner');
  } else {
    const team = c.env.ACCESS_TEAM_DOMAIN;
    const aud = c.env.ACCESS_AUD;
    if (!team || !aud) throw new ApiError(503, '尚未配置 Cloudflare Access', 'AUTH_NOT_CONFIGURED');
    const teamUrl = team.startsWith('https://') ? team : `https://${team}`;
    const token = c.req.header('Cf-Access-Jwt-Assertion');
    if (!token) throw new ApiError(401, '请通过 Cloudflare Access 登录', 'UNAUTHORIZED');
    try {
      let keys = keySets.get(teamUrl);
      if (!keys) {
        keys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', teamUrl));
        keySets.set(teamUrl, keys);
      }
      const { payload } = await jwtVerify(token, keys, { issuer: teamUrl, audience: aud });
      const identity =
        payload.sub ||
        (typeof payload.common_name === 'string' && payload.common_name
          ? `service:${payload.common_name}`
          : null);
      if (!identity) throw new Error('missing identity');
      c.set('ownerId', identity);
    } catch {
      throw new ApiError(401, '登录凭证无效或已过期', 'UNAUTHORIZED');
    }
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('Origin');
    if (origin && origin !== url.origin)
      throw new ApiError(403, '请求来源不匹配', 'ORIGIN_MISMATCH');
  }
  await next();
};
