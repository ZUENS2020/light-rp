/// <reference types="@cloudflare/vitest-plugin/types" />

import type { D1Migration } from "cloudflare:test";

declare module "vitest" {
  export interface ProvidedContext {
    D1_MIGRATIONS: D1Migration[];
  }
}
