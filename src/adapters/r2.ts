export class R2Fs {
  constructor(
    private bucket: R2Bucket,
    private prefix: string,
  ) {}

  key(rel: string): string {
    return `${this.prefix.replace(/\/$/, "")}/${rel.replace(/^\//, "")}`;
  }

  async get(rel: string): Promise<string | null> {
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
    await this.bucket.put(this.key(rel), text, { httpMetadata: { contentType } });
  }

  async del(rel: string): Promise<void> {
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
    return names;
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

export function legacyWorkspaceFs(bucket: R2Bucket, id: string): R2Fs {
  return new R2Fs(bucket, `workspaces/${id}`);
}

export async function listLegacyWorkspaceIds(bucket: R2Bucket): Promise<string[]> {
  const page = await bucket.list({ prefix: "workspaces/", delimiter: "/" });
  return [
    ...new Set(
      (page.delimitedPrefixes || [])
        .map((prefix) => prefix.replace(/^workspaces\//, "").replace(/\/$/, ""))
        .filter(Boolean),
    ),
  ].sort();
}
