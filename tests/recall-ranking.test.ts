import { describe, it, expect } from 'vitest';
import { Store } from '../src/server/store';
import { createTestD1 } from './d1';
import { objectiveEvidenceFragments } from '../src/server/knowledge';
import { queryTerms, rrf } from '../src/server/memory';

describe('recall ranking hybrid-v2', () => {
  it('keeps a BM25 hit ahead of recent same-person memories for a named query', async () => {
    const d = createTestD1(),
      s = new Store(d.db, 'ranking-test');
    try {
      const w = await s.createWorld('ranking'),
        story = await s.createStory({ worldId: w.id }),
        branchId = story.branchId,
        session = await s.createSession({ branchId });
      const add = async (i: number, text: string) => {
        const e = (
          await s.appendTurn({
            branchId,
            sessionId: session.id,
            requestId: `r-${i}`,
            messages: [{ role: 'assistant', text }],
          })
        ).events[0]!;
        return s.propose(branchId, {
          kind: 'episode',
          subject: 'Caroline',
          predicate: `event-${i}`,
          value: '',
          text,
          evidence: [{ sourceId: e.sourceId, start: 0, end: Array.from(text).length, quote: text }],
        });
      };
      const target = await add(0, 'Caroline went to a LGBTQ support group yesterday.');
      for (let i = 1; i <= 45; i++)
        await add(i, `Caroline talked about painting number ${i} with her friend.`);
      const query = 'When did Caroline go to the LGBTQ support group?';
      const rank = async (ranking: 'v1' | 'hybrid-v2') =>
        (
          await s.recall(branchId, query, { ranking, maxGraphMs: 0, maxTokens: 20000 })
        ).items.findIndex((item) => item.memory.id === target.id);
      const v1 = await rank('v1'),
        v2 = await rank('hybrid-v2');
      expect(v2).toBe(0);
      expect(v1 === -1 || v1 > v2).toBe(true);
    } finally {
      d.close?.();
    }
  });
  it('drops function words from ranking terms and weights RRF arms', () => {
    expect(queryTerms('When did Caroline go to the support group?')).toEqual([
      'caroline',
      'go',
      'support',
      'group',
    ]);
    const scores = rrf([['a'], ['b']], 60, [1, 0.4]);
    expect(scores.get('a')!.score).toBeGreaterThan(scores.get('b')!.score);
  });
});
describe('English apostrophes', () => {
  it('do not mask the rest of a dialogue line as quoted speech', () => {
    const q = "Evan: It's a 1968 Kustom K-200A vintage guitar and I got it as a gift.";
    expect(objectiveEvidenceFragments(q, q).join('')).toContain('1968 Kustom K-200A');
  });
  it('still masks real single-quoted speech', () => {
    const q = "Sam said 'the code is 42' to Evan.";
    expect(objectiveEvidenceFragments(q, q).join('')).not.toContain('42');
  });
});
