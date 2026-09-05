import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  // Browser interaction tests mock every API. Never initialize remote bindings
  // or load production credentials for that frontend-only server.
  plugins: [react(), ...(process.env.LIGHTRP_TEST === "1" ? [] : [cloudflare()])],
  server: {
    port: 5173,
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), ".."],
    },
  },
});
