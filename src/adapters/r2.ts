export class R2Fs {
  private changes = new Map<string, { text: string; contentType: string } | null>();
  constructor(
    private bucket: R2Bucket,
    private prefix: string,
    private staged = false,
  ) {}

  stage(): R2Fs {
    return new R2Fs(this.bucket, this.prefix, true);
  }

  journal(): Array<[string, { text: string; contentType: string } | null]> {
    return [...this.changes];
  }

  async replay(journal: ReturnType<R2Fs["journal"]>): Promise<void> {
    for (const [path, value] of journal) {
      if (value) await this.put(path, value.text, value.contentType);
      else await this.del(path);
    }
  }

  key(rel: string): string {
    return `${this.prefix.replace(/\/$/, "")}/${rel.replace(/^\//, "")}`;
  }

  async get(rel: string): Promise<string | null> {
    if (this.changes.has(rel)) return this.changes.get(rel)?.text ?? null;
    try {
      const obj = await this.bucket.get(this.key(rel));
      return obj ? await obj.text() : null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/unspecified error/i.test(message)) throw err;
      const obj = await this.bucket.get(this.key(rel));
      return obj ? await obj.text() : null;
    }
  }

  async put(rel: string, text: string, contentType = "text/plain; charset=utf-8"): Promise<void> {
    if (this.staged) {
      this.changes.set(rel, { text, contentType });
      return;
    }
    await this.bucket.put(this.key(rel), text, { httpMetadata: { contentType } });
  }

  async del(rel: string): Promise<void> {
    if (this.staged) {
      this.changes.set(rel, null);
      return;
    }
    await this.bucket.delete(this.key(rel));
  }

  async list(relPrefix = ""): Promise<string[]> {
    const prefix = this.key(relPrefix);
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, cursor });
      for (const obj of page.objects) {
        names.push(obj.key.slice(this.prefix.replace(/\/$/, "").length + 1));
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const visible = new Set(names);
    for (const [path, value] of this.changes) {
      if (!path.startsWith(relPrefix)) continue;
      if (value) visible.add(path);
      else visible.delete(path);
    }
    return [...visible].sort();
  }
}

export function workspaceFs(bucket: R2Bucket, id: string): R2Fs {
  return new R2Fs(bucket, `v2/workspaces/${id}`);
}

export async function listWorkspaceIds(bucket: R2Bucket): Promise<string[]> {
  const page = await bucket.list({ prefix: "v2/workspaces/", delimiter: "/" });
  const ids = (page.delimitedPrefixes || [])
    .map((p) => p.replace(/^v2\/workspaces\//, "").replace(/\/$/, ""))
    .filter(Boolean);
  return [...new Set(ids)].sort();
}
