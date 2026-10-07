/** Local, read-only bridge used solely for exporting the old R2 bucket. */
export default {
  async fetch(request: Request, env: { LEGACY: R2Bucket }) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      return new Response('Local read-only export only', { status: 403 });
    if (url.pathname === '/list') {
      const list = await env.LEGACY.list({
        cursor: url.searchParams.get('cursor') ?? undefined,
        limit: 500,
      });
      return Response.json({
        objects: list.objects.map((o) => ({ key: o.key, size: o.size, etag: o.etag })),
        cursor: list.truncated ? list.cursor : null,
      });
    }
    if (url.pathname === '/object') {
      const object = await env.LEGACY.get(url.searchParams.get('key') ?? '');
      return object
        ? new Response(object.body, {
            headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
          })
        : new Response('Not found', { status: 404 });
    }
    return new Response('Not found', { status: 404 });
  },
};
