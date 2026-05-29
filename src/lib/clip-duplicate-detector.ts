export interface DuplicateGroup {
  type: "EXACT_DUPLICATE" | "OVERLAPPING_SEGMENT";
  parentAssetId: string;
  clips: Array<{
    id: string;
    startTimeMs: number;
    endTimeMs: number;
    tieredScore: number;
    clipType: string | null;
    durationSeconds: number | null;
    immichAssetId: string | null;
    parentImmichAssetId: string | null;
  }>;
  keepId?: string;
}

interface ClipInput {
  id: string;
  parentAssetId: string | null;
  startTimeMs: number | null;
  endTimeMs: number | null;
  tieredScore?: number;
  clipScore?: { clipType: string | null } | null;
  durationSeconds: number | null;
  immichAssetId: string | null;
  parentImmichAssetId?: string | null;
}

function overlapRatio(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const intersection = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  const union = Math.max(aEnd, bEnd) - Math.min(aStart, bStart);
  if (union === 0) return 0;
  return intersection / union;
}

function isExactDuplicate(a: ClipInput, b: ClipInput): boolean {
  if (a.startTimeMs == null || a.endTimeMs == null) return false;
  if (b.startTimeMs == null || b.endTimeMs == null) return false;
  return (
    Math.abs(a.startTimeMs - b.startTimeMs) <= 1000 &&
    Math.abs(a.endTimeMs - b.endTimeMs) <= 1000
  );
}

export function findDuplicateClips(clips: ClipInput[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  const processed = new Set<string>();

  const byParent = new Map<string | null, ClipInput[]>();
  for (const clip of clips) {
    const key = clip.parentAssetId ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(clip);
  }

  for (const entry of Array.from(byParent.entries())) {
    const [parentAssetId, group] = entry;
    if (group.length < 2) continue;

    const exactMap = new Map<string, ClipInput[]>();

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const pairKey = [a.id, b.id].sort().join("||");

        if (processed.has(pairKey)) continue;

        if (isExactDuplicate(a, b)) {
          const key = [
            Math.min(a.startTimeMs!, b.startTimeMs!),
            Math.max(a.endTimeMs!, b.endTimeMs!),
          ].join("-");
          if (!exactMap.has(key)) exactMap.set(key, []);
          if (!exactMap.get(key)!.find((c) => c.id === a.id)) exactMap.get(key)!.push(a);
          if (!exactMap.get(key)!.find((c) => c.id === b.id)) exactMap.get(key)!.push(b);
          processed.add(pairKey);
        } else if (
          a.startTimeMs != null &&
          a.endTimeMs != null &&
          b.startTimeMs != null &&
          b.endTimeMs != null
        ) {
          const ratio = overlapRatio(
            a.startTimeMs,
            a.endTimeMs,
            b.startTimeMs,
            b.endTimeMs
          );
          if (ratio > 0.3) {
            const clipEntries = (cs: ClipInput) => ({
              id: cs.id,
              startTimeMs: cs.startTimeMs!,
              endTimeMs: cs.endTimeMs!,
              tieredScore: cs.tieredScore ?? 0,
              clipType: cs.clipScore?.clipType ?? null,
              durationSeconds: cs.durationSeconds,
              immichAssetId: cs.immichAssetId,
              parentImmichAssetId: (cs.parentImmichAssetId ?? null) as string | null,
            });
            groups.push({
              type: "OVERLAPPING_SEGMENT",
              parentAssetId: parentAssetId ?? "",
              clips: [clipEntries(a), clipEntries(b)],
            });
            processed.add(pairKey);
          }
        }
      }
    }

    for (const entry of Array.from(exactMap.entries())) {
      const [, exactGroup] = entry;
      const sorted = [...exactGroup].sort((a, b) => (b.tieredScore ?? 0) - (a.tieredScore ?? 0));
      const keepId = sorted[0].id;
      groups.push({
        type: "EXACT_DUPLICATE",
        parentAssetId: parentAssetId ?? "",
        clips: sorted.map((cs) => ({
          id: cs.id,
          startTimeMs: cs.startTimeMs!,
          endTimeMs: cs.endTimeMs!,
          tieredScore: cs.tieredScore ?? 0,
          clipType: cs.clipScore?.clipType ?? null,
          durationSeconds: cs.durationSeconds,
          immichAssetId: cs.immichAssetId,
          parentImmichAssetId: (cs.parentImmichAssetId ?? null) as string | null,
        })),
        keepId,
      });
    }
  }

  return groups;
}
