import { describe, expect, it } from 'vitest';
import { hermesCharacterProfile, HERMES_NARRATIVE_GUIDANCE } from '../src/shared/hermes-rp';
import { settingsSchema } from '../src/shared/api';
import { defaults } from '../src/server/settings';

describe('Hermes narrative design adaptation', () => {
  it('uses only explicit card profile fields and honors clearing before aliases', () => {
    const raw = {
      data: {
        name: '男巫',
        gender: '',
        Sex: '男性',
        Behavior: '敲桌两下',
        speech: '称玩家{{user}}',
        likes: ['茶', 123],
        backstory: '来自港口',
        secretExtension: { untouched: true },
      },
    };
    const before = JSON.stringify(raw);
    expect(hermesCharacterProfile(raw)).toEqual({
      behavior: '敲桌两下',
      speech: '称玩家{{user}}',
      likes: ['茶'],
      backstory: '来自港口',
    });
    expect(JSON.stringify(raw)).toBe(before);
    expect(hermesCharacterProfile({ name: 'female male', description: '战士' })).toEqual({});
  });
  it('defaults new instructions while preserving frozen, custom and explicitly empty settings', () => {
    expect(defaults('openai').systemPrompt).toBe(HERMES_NARRATIVE_GUIDANCE);
    expect(settingsSchema.parse({}).systemPrompt).toBe(
      '你是统一叙事者。维护人物动机、各自知情边界和世界规则，不替玩家决定行为。',
    );
    expect(settingsSchema.parse({ systemPrompt: '' }).systemPrompt).toBe('');
    expect(settingsSchema.parse({ systemPrompt: '旧任务指引' }).systemPrompt).toBe('旧任务指引');
  });
});
