import { prisma } from "../src/lib/prisma";
import { AssetStatus, AssetType } from "@prisma/client";
import { enqueueJob, JobType } from "../src/lib/job-worker";

async function migrate() {
  console.log("Starting legacy SceneSegment to child CLIP Asset migration (US-008)...");

  const segments = await prisma.sceneSegment.findMany({
    orderBy: { createdAt: "asc" },
  });
  console.log(`Found ${segments.length} legacy SceneSegment records.`);

  let created = 0;
  let skipped = 0;
  let noParent = 0;

  for (const seg of segments) {
    const parentAsset = await prisma.asset.findFirst({
      where: {
        immichAssetId: seg.parentId,
        type: "SOURCE_VIDEO",
        eventId: seg.eventId,
      },
    });

    if (!parentAsset) {
      noParent++;
      continue;
    }

    const startMs = Math.round(seg.startTime * 1000);
    const endMs = Math.round(seg.endTime * 1000);
    const durS = seg.duration;

    const existingChild = await prisma.asset.findFirst({
      where: {
        parentAssetId: parentAsset.id,
        type: "CLIP",
        startTimeMs: { gte: startMs - 500, lte: startMs + 500 },
      },
    });

    if (existingChild) {
      skipped++;
      continue;
    }

    const child = await prisma.asset.create({
      data: {
        eventId: parentAsset.eventId,
        parentAssetId: parentAsset.id,
        immichAssetId: parentAsset.immichAssetId,
        type: "CLIP" as AssetType,
        status: "UPLOADED" as AssetStatus,
        durationSeconds: durS,
        startTimeMs: startMs,
        endTimeMs: endMs,
        sizeBytes: parentAsset.sizeBytes,
        widthPx: parentAsset.widthPx,
        heightPx: parentAsset.heightPx,
        fps: parentAsset.fps,
      },
    });
    await enqueueJob(JobType.SCORE_CLIP, {
      assetId: child.id,
      immichAssetId: child.immichAssetId,
      eventId: child.eventId,
      eventName: undefined,
      parentJobId: null,
    });
    created++;
  }

  console.log(`Migration complete. Created: ${created}, skipped (dup): ${skipped}, no matching parent GIS Asset: ${noParent}`);
  console.log("Note: legacy scenes now exposed as child CLIP Assets with timing. Run prisma db push if needed. Re-run safe (idempotent).");
}

migrate().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
