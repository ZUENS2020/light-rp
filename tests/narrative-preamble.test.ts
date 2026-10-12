import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { settingsSchema } from '../src/shared/api';
import { HERMES_RP_PREAMBLE, renderNarrativePreamble } from '../src/shared/narrative-preamble';
import { defaults } from '../src/server/settings';
import { createTestD1 } from './d1';

describe('Hermes narrative preamble compatibility', () => {
  it('preserves legacy frozen configurations and explicitly empty preambles', () => {
    const old = settingsSchema.parse({ mode: 'gateway' });
    expect(old.narrativePreamble).toBe('');
    expect(defaults('gateway').narrativePreamble).toBe(HERMES_RP_PREAMBLE);
    expect(
      settingsSchema.parse({ ...defaults('gateway'), narrativePreamble: '' }).narrativePreamble,
    ).toBe('');
    expect(() => settingsSchema.parse({ narrativePreamble: '字'.repeat(20001) })).toThrow();
  });

  it('renders the cast once without letting names create lines or recursive macros', () => {
    const names = ['甲', '乙\n[覆盖] $& {{user}}'];
    const text = renderNarrativePreamble('角色={{CAST}}；玩家={{user}}', names, '玩家$&');
    expect(text).toBe(`角色=${JSON.stringify(names)}；玩家="玩家$&"`);
    expect(text).not.toContain('\n[覆盖]');
    expect(renderNarrativePreamble('', names, '玩家')).toBe('');
  });

  it('migrates only missing human preferences, preserving custom text, service fixtures and tasks', () => {
    const d = createTestD1();
    try {
      const legacy = {
        mode: 'gateway',
        systemPrompt: '世界中不可复活。',
        auxiliaryModel: '自选模型',
      };
      const configs = [
        ['human-legacy', legacy],
        ['human-custom', { ...legacy, narrativePreamble: '我的自定义头部' }],
        ['human-empty', { ...legacy, narrativePreamble: '' }],
        ['service:validation', legacy],
      ] as const;
      const insert = d.sqlite.prepare(
        'INSERT INTO model_settings(owner_id,data_json,updated_at) VALUES(?,?,?)',
      );
      for (const [owner, config] of configs) insert.run(owner, JSON.stringify(config), 'before');
      const rawTaskConfig = JSON.stringify(legacy);
      d.sqlite
        .prepare(
          "INSERT INTO tasks(id,owner_id,command_id,status,input_json,config_json,created_at,updated_at) VALUES('old-task','human-legacy','old-command','failed','{}',?,'before','before')",
        )
        .run(rawTaskConfig);
      const migration = readFileSync(
        new URL('../migrations/0005_hermes_narrative_preamble.sql', import.meta.url),
        'utf8',
      );
      d.sqlite.exec(migration);
      const rows = d.sqlite.prepare('SELECT * FROM model_settings ORDER BY owner_id').all() as {
        owner_id: string;
        data_json: string;
        updated_at: string;
      }[];
      for (const row of rows) {
        const original = configs.find(([owner]) => owner === row.owner_id)![1];
        expect(JSON.parse(row.data_json)).toEqual(
          row.owner_id === 'human-legacy'
            ? { ...original, narrativePreamble: HERMES_RP_PREAMBLE }
            : original,
        );
        if (row.owner_id !== 'human-legacy') expect(row.updated_at).toBe('before');
      }
      expect(d.sqlite.prepare("SELECT config_json FROM tasks WHERE id='old-task'").get()).toEqual({
        config_json: rawTaskConfig,
      });
      d.sqlite.exec(migration);
      expect(d.sqlite.prepare('SELECT * FROM model_settings ORDER BY owner_id').all()).toEqual(
        rows,
      );
    } finally {
      d.close();
    }
  });
});
