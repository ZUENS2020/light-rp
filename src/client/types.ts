import type { ModelSettings } from '../shared/api';
export type Data = Record<string, any>;
export interface Asset {
  id: string;
  kind: string;
  name: string;
  revision: number;
  data: Data;
}
export interface World {
  id: string;
  name: string;
}
export interface Story {
  id: string;
  worldId: string;
  title: string;
  characterIds?: string[];
  worldbookIds?: string[];
  playerCharacterId?: string;
  [key: string]: any;
}
export interface Branch {
  id: string;
  storyId: string;
  name: string;
  headSeq: number;
  projectionRevision: number;
  scene?: Data | string;
  parentBranchId?: string;
  parentId?: string;
  forkSeq?: number;
  [key: string]: any;
}
export interface ChatEvent {
  id: string;
  seq: number;
  role: string;
  text: string;
  createdAt?: string;
  sessionId?: string;
  sourceId?: string;
  actorId?: string;
  [key: string]: any;
}
export interface Snapshot {
  branch: Branch;
  sessions: Data[];
  events: ChatEvent[];
  eventsBeforeSeq?: number | null;
  hasEarlierEvents?: boolean;
  memories: Data[];
  procedures: Data[];
  experiences: Data[];
  capabilities: Data[];
  jobs: Data[];
  compression?: Data[];
  policy?: Data;
}
export type Settings = ModelSettings;
export interface Bootstrap {
  worlds: World[];
  stories: Story[];
  assets: Asset[];
  settings: Settings;
}
