import type { ContextSelection, Memory } from '../shared/domain';

/** The only owner of optional memory expansion. Selection does not mutate memory state. */
export class ContextComposer {
  readonly selections: ContextSelection[] = [];
  readonly deduplications: ContextSelection[] = [];
  private revisions = new Set<string>();
  private spans = new Set<string>();
  private descendants = new Set<string>();
  constructor(private readonly records: Memory[] = []) {}
  private children(m: Memory, seen = new Set<string>()) {
    for (const id of Array.isArray(m.data?.children) ? m.data.children.map(String) : []) {
      if (seen.has(id)) continue;
      seen.add(id);
      this.descendants.add(`${m.subject}:${id}`);
      const child = this.records.find((r) => r.id === id);
      if (child) this.children(child, seen);
    }
  }
  preview(m: Memory, viewer: string, consumer: ContextSelection['consumer'], reason: string[]) {
    const archive = ['narrative-unit', 'narrative-segment'].includes(String(m.data?.recordType));
    if (archive) consumer = 'archive';
    const covered = this.coverage(m);
    const parent =
      archive &&
      this.selections.find(
        (s) =>
          s.viewer === viewer &&
          s.consumer === 'archive' &&
          covered.length > 0 &&
          covered.every((e) => this.coversRange(viewer, e.sourceId, e.start, e.end)),
      );
    if (
      this.revisions.has(`${viewer}:${m.id}`) ||
      this.descendants.has(`${viewer}:${m.id}`) ||
      parent
    ) {
      this.deduplications.push({
        revisionId: m.id,
        viewer,
        consumer,
        reason: [parent ? 'covered-by-parent' : 'revision-already-expanded', ...reason],
        historical: archive,
        covered: [],
        ...(parent ? { duplicateOf: parent.revisionId } : {}),
      });
      return null;
    }
    const evidence = m.evidence.filter(
      (e) => !this.spans.has(`${viewer}:${e.sourceId}:${e.start}:${e.end}`),
    );
    const { acquisitionProofs: _acquisitionProofs, ...publicData } = m.data ?? {};
    const content = JSON.stringify({
      id: m.id,
      kind: m.kind,
      subject: m.subject,
      predicate: m.predicate,
      value: m.value,
      authority: m.authority,
      validFrom: m.validFrom,
      validTo: m.validTo,
      observerId: m.observerId,
      text: m.text,
      knownBy: viewer === 'director' ? m.knownBy : m.knownBy.filter((id) => id === viewer),
      data:
        consumer === 'archive'
          ? {
              level: m.data?.level,
              title: m.data?.title,
              children: m.data?.children,
              references: m.data?.references,
            }
          : m.kind === 'procedure'
            ? {
                capability: m.data?.capability,
                conditions: m.data?.conditions,
                method: m.data?.method,
                steps: m.data?.steps,
                fallback: m.data?.fallback,
                limitations: m.data?.limitations,
              }
            : publicData,
      evidence: evidence.map((e) => ({
        sourceId: e.sourceId,
        start: e.start,
        end: e.end,
        ...(consumer === 'archive' ? {} : { quote: e.quote }),
      })),
    });
    return {
      content,
      accept: () => {
        this.revisions.add(`${viewer}:${m.id}`);
        if (consumer !== 'archive')
          for (const e of evidence) this.spans.add(`${viewer}:${e.sourceId}:${e.start}:${e.end}`);
        if (consumer === 'archive') this.children(m);
        this.selections.push({
          revisionId: m.id,
          viewer,
          consumer,
          reason,
          historical: consumer === 'archive',
          covered: consumer === 'archive' ? covered : [],
        });
      },
    };
  }
  private coverage(m: Memory) {
    return (Array.isArray(m.data?.coverage) ? m.data.coverage : []).filter(
      (e): e is { sourceId: string; start: number; end: number } =>
        !!e &&
        typeof e === 'object' &&
        !Array.isArray(e) &&
        typeof e.sourceId === 'string' &&
        typeof e.start === 'number' &&
        typeof e.end === 'number',
    );
  }
  private coversRange(viewer: string, sourceId: string, start: number, finish: number) {
    const spans = this.selections
      .filter((s) => s.viewer === viewer)
      .flatMap((s) => s.covered)
      .filter((e) => e.sourceId === sourceId)
      .sort((a, b) => a.start - b.start);
    let end = start;
    for (const e of spans) {
      if (e.end <= end) continue;
      if (e.start > end) return false;
      end = Math.max(end, e.end);
      if (end >= finish) return true;
    }
    return end >= finish;
  }
  reserveThread(revisionId: string, viewer: string) {
    const key = `${viewer}:${revisionId}`;
    if (this.revisions.has(key)) return false;
    this.revisions.add(key);
    this.selections.push({
      revisionId,
      viewer,
      consumer: 'thread',
      reason: ['unresolved-thread'],
      historical: false,
      covered: [],
    });
    return true;
  }
  covers(viewer: string, sourceId: string, length: number) {
    return this.coversRange(viewer, sourceId, 0, length);
  }
}
