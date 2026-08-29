export { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (full, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : full,
  );
}

export function slugify(name: string): string {
  const text = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff-]+/g, "");
  return text || "workspace";
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sessionIdNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function workspaceIdOk(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(id);
}
