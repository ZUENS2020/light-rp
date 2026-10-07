import { settingsSchema, type ModelSettings } from '../shared/api';
import { HERMES_RP_PREAMBLE } from '../shared/narrative-preamble';
export { settingsSchema, type ModelSettings } from '../shared/api';
export const defaults = (mode: string): ModelSettings =>
  settingsSchema.parse({ mode, narrativePreamble: HERMES_RP_PREAMBLE });
