import { settingsSchema, type ModelSettings } from '../shared/api';
export { settingsSchema, type ModelSettings } from '../shared/api';
export const defaults = (mode: string): ModelSettings => settingsSchema.parse({ mode });
