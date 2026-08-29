interface Env {
  BUCKET: R2Bucket;
  ASSETS?: Fetcher;
  DB: D1Database;
  GENERATE_QUEUE: Queue;
  LLM_BASE_URL: string;
  LLM_MODEL: string;
  NVIDIA_API_KEY: string;
  NMEM_API_URL?: string;
  NMEM_API_KEY?: string;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<unknown>;
}

interface Queue {
  send(message: unknown): Promise<void>;
}

interface MessageBatch<Body = unknown> {
  readonly messages: Message<Body>[];
}

interface Message<Body = unknown> {
  readonly body: Body;
  ack(): void;
  retry(): void;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
