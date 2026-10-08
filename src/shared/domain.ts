export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type MemoryKind =
  'canon' | 'belief' | 'relation' | 'episode' | 'observation' | 'experience' | 'procedure';
export type MemoryStatus =
  'active' | 'forgotten' | 'invalidated' | 'draft' | 'suspended' | 'retired';
export interface World {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}
export interface Story {
  id: string;
  ownerId: string;
  worldId: string;
  name: string;
  characterIds: string[];
  worldbookIds: string[];
  playerCharacterId: string | null;
  createdAt: string;
  updatedAt: string;
  branchId?: string;
}
export interface Branch {
  id: string;
  ownerId: string;
  storyId: string;
  name: string;
  parentBranchId: string | null;
  forkSeq: number;
  headSeq: number;
  revision: number;
  projectionRevision: number;
  scene: Record<string, Json>;
  createdAt: string;
}
export interface Session {
  id: string;
  ownerId: string;
  branchId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}
export interface SourceFence {
  sourceId: string;
  version: number;
  generation: number;
}
export interface TaskFence {
  taskId: string;
  attempt: number;
  cancelEpoch: number;
}
export interface WriteFence {
  ownerEpoch?: number;
  sourceFence?: SourceFence[];
}
export interface Event {
  id: string;
  ownerId: string;
  storyId: string;
  branchId: string;
  sessionId: string | null;
  sourceId: string;
  seq: number;
  role: string;
  speakerId: string | null;
  text: string;
  sceneTime: number;
  storyTime: string | null;
  knownBy: string[];
  createdAt: string;
  deleted: boolean;
}
export interface TurnMessage {
  role: 'user' | 'assistant' | 'system' | 'correction';
  text: string;
  speakerId?: string;
  knownBy?: string[];
  sceneTime?: number;
  storyTime?: string;
}
export interface AppendTurnInput {
  branchId: string;
  sessionId: string;
  requestId: string;
  expectedHead?: number;
  expectedProjectionRevision?: number;
  messages: TurnMessage[];
  scene?: Record<string, Json>;
  taskFence?: TaskFence;
  ownerEpoch?: number;
  sourceFence?: SourceFence[];
  resourceUpdates?: ResourceBinding[];
}
export interface AppendTurnResult {
  branch: Branch;
  events: Event[];
  replayed: boolean;
}
/** Offsets count Unicode code points, not UTF-16 code units. */
export interface Evidence {
  sourceId: string;
  sourceVersion?: number;
  sourceGeneration?: number;
  start: number;
  end: number;
  quote: string;
  spanId?: string;
}
export interface MemoryProposal extends WriteFence {
  id?: string;
  idempotencyKey?: string;
  kind: MemoryKind;
  subject: string;
  predicate: string;
  value: Json;
  text: string;
  evidence: Evidence[];
  knownBy?: string[];
  observerId?: string;
  authority?: number;
  confidence?: number;
  validFrom?: number | null;
  validTo?: number | null;
  originSeq?: number;
  status?: MemoryStatus;
  data?: Record<string, Json>;
  memoryKey?: string;
}
export interface Memory extends Omit<MemoryProposal, 'id' | 'evidence'> {
  id: string;
  memoryKey: string;
  ownerId: string;
  storyId: string;
  branchId: string;
  recordedSeq: number;
  recordedAt: string;
  revision: number;
  status: MemoryStatus;
  knownBy: string[];
  evidence: Evidence[];
  sourceIds: string[];
  supersedesId: string | null;
}
export interface MemoryOptions {
  asOfSeq?: number;
  sceneTime?: number;
  viewer?: 'director' | string;
  includeInactive?: boolean;
  kinds?: MemoryKind[];
  limit?: number;
}
export interface RecallOptions extends MemoryOptions {
  maxCandidates?: number;
  maxTokens?: number;
  graphSeeds?: number;
  graphHops?: number;
  graphFanout?: number;
  maxGraphNodes?: number;
  maxGraphMs?: number;
  vectorCandidates?: { id: string; score: number }[];
}
export interface RecallItem {
  memory: Memory;
  score: number;
  arms: string[];
  evidence: Evidence[];
}
export interface RecallResult {
  items: RecallItem[];
  tokens: number;
  visited: number;
  truncated: boolean;
  degraded: string[];
  cursor: number;
}
export interface ObservationInput {
  branchId: string;
  cursor: number;
  expectedMemoryIds: string[];
  proposals: MemoryProposal[];
  sourceFence?: SourceFence[];
  ownerEpoch?: number;
  extractorVersion?: string;
  /** Immutable historical inputs may be superseded normally, but never corrected or forgotten. */
  historicalMemoryIds?: string[];
  expectedProjectionRevision?: number;
  progress?: {
    scope: string;
    expectedRevision: number;
    state: Record<string, Json>;
  };
}
export type Outcome = 'success' | 'failure' | 'partial' | 'unknown' | 'unfinished';
export type FailureCategory =
  | 'method_counterexample'
  | 'precondition_mismatch'
  | 'execution_deviation'
  | 'stochastic_outcome'
  | 'unresolved'
  | 'precondition'
  | 'execution'
  | 'environment'
  | 'contradiction'
  | 'unsafe';
export interface ExperienceInput extends WriteFence {
  branchId: string;
  actorId: string;
  capability: string;
  conditions: Record<string, Json>;
  steps: string[];
  outcome: Outcome;
  failureCategory?: FailureCategory;
  evidence: Evidence[];
  originSeq?: number;
  text?: string;
}
export interface ProcedureUseInput extends WriteFence {
  usageKey?: string;
  branchId: string;
  procedureId: string;
  revisionId?: string;
  phase?: 'retrieved' | 'planned' | 'applied';
  outcome: Outcome;
  evidence: Evidence[];
  failureCategory?: FailureCategory;
  conditions?: Record<string, Json>;
}
export interface ResourceBinding {
  assetId: string;
  revision: number;
  kind: string;
}
export interface KnowledgeInput extends WriteFence {
  /** Server-only extraction/rebuild path; never overrides a visible author revocation. */
  automatic?: boolean;
  branchId: string;
  sourceId: string;
  characterId: string;
  quote?: string;
  spanId?: string;
  start?: number;
  end?: number;
  channel?: 'witnessed' | 'told' | 'rumor' | 'inferred' | 'author' | 'persona' | 'public';
  status?: 'grant' | 'revoke';
}
export interface CapabilityInput extends WriteFence {
  branchId: string;
  actorId: string;
  capability: string;
  status: 'available' | 'lost' | 'uncertain';
  data?: Record<string, Json>;
  evidence: Evidence[];
}
export interface Capability {
  id: string;
  actorId: string;
  capability: string;
  status: 'available' | 'lost' | 'uncertain';
  data: Record<string, Json>;
  evidence: Evidence[];
  recordedSeq: number;
  revisionId: string;
}
export interface ExportArchive {
  format: 'lightrp-story';
  version: 1;
  exportedAt: string;
  world: World;
  story: Story;
  branches: Branch[];
  sessions: Session[];
  events: Event[];
  sources: Record<string, unknown>[];
  memories: Memory[];
  grants: Record<string, unknown>[];
  /** Optional sections extend older V1 readers. All memory revisions are exported. */
  ownerEpoch?: number;
  lineage?: Record<string, unknown>[];
  turns?: Record<string, unknown>[];
  scenes?: Record<string, unknown>[];
  resourceBindings?: Record<string, unknown>[];
  assets?: Record<string, unknown>[];
  assetRevisions?: Record<string, unknown>[];
  sourceSpans?: Record<string, unknown>[];
  memoryHeads?: Record<string, unknown>[];
  memoryDependencies?: Record<string, unknown>[];
  memoryRows?: Record<string, unknown>[];
  capabilities?: Record<string, unknown>[];
  procedureUses?: Record<string, unknown>[];
  memoryCursors?: Record<string, unknown>[];
  memoryApplications?: Record<string, unknown>[];
  observationBatches?: Record<string, unknown>[];
  observationProgress?: Record<string, unknown>[];
  entities?: Record<string, unknown>[];
  entityAliases?: Record<string, unknown>[];
  tombstones?: Record<string, unknown>[];
  sourceDeletionMembers?: Record<string, unknown>[];
  attachments?: { key: string; kind: 'character-png'; included: false }[];
}
export interface QuerySpec {
  sql: string;
  params?: unknown[];
}
