import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import process from "node:process";

const root = process.cwd();
const ignored = new Set([".git", "node_modules", ".wrangler", "dist", "coverage", "playwright-report", "test-results"]);
const forbiddenNames = new Set([
  "pyproject.toml",
  "requirements.txt",
  "requirements-dev.txt",
  "Pipfile",
  "poetry.lock",
]);
const commandPattern = /(?:^|[\s"'])python(?:3(?:\.\d+)?)?(?:[\s"']|$)|\bpytest\b|\bpip(?:3)?\s+(?:install|sync)\b/i;
const textExtensions = new Set([
  ".json",
  ".jsonc",
  ".md",
  ".yaml",
  ".yml",
  ".toml",
  ".sh",
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
]);
const failures: string[] = [];

async function scan(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    const rel = relative(root, path);
    if (entry.isDirectory()) {
      await scan(path);
      continue;
    }
    if (entry.name.endsWith(".py") || forbiddenNames.has(entry.name)) failures.push(rel);
    if (rel !== "scripts/assert-no-python.ts" && textExtensions.has(extname(entry.name))) {
      const text = await readFile(path, "utf8");
      if (commandPattern.test(text)) failures.push(`${rel} (Python execution reference)`);
    }
  }
}

await scan(root);
if (failures.length) {
  process.stderr.write(`Python paths remain:\n${[...new Set(failures)].map((file) => `- ${file}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("No Python source, configuration, or execution paths found.\n");
