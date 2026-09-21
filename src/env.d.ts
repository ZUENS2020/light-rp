/** Worker secrets not declared in wrangler.jsonc (set via `wrangler secret put`). */
interface Env {
  /** Command Code GOAT Provider API key (OpenAI-compatible). */
  COMMANDCODE_API_KEY?: string;
}
