import { settingsSchema, type ModelSettings } from '../shared/api';
import { HERMES_RP_PREAMBLE } from '../shared/narrative-preamble';
import { HERMES_NARRATIVE_GUIDANCE } from '../shared/hermes-rp';
export { settingsSchema, type ModelSettings } from '../shared/api';
export const defaults = (mode: string): ModelSettings =>
  settingsSchema.parse({
    mode,
    narrativePreamble: HERMES_RP_PREAMBLE,
    systemPrompt: HERMES_NARRATIVE_GUIDANCE,
  });
