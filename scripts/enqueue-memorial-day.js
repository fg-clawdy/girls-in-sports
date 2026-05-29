const { PrismaClient, JobType, JobStatus } = require('@prisma/client');
const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

async function main() {
  const prisma = new PrismaClient();
  const redis = new IORedis(REDIS_URL);

  // SCORE_CLIP for orphaned UPLOADED clips
  const orphanedClips = await prisma.asset.findMany({
    where: {
      eventId: 'cmplzj6t8000q3ep96urov6ei',
      type: 'CLIP',
      status: 'UPLOADED',
      clipScore: null,
    },
    select: { id: true, immichAssetId: true, parentAssetId: true },
  });

  console.log(`Found ${orphanedClips.length} orphaned clips needing SCORE_CLIP`);

  const scoreQueue = new Queue('SCORE_CLIP', { connection: redis });
  for (const clip of orphanedClips) {
    const job = await prisma.job.create({
      data: {
        type: JobType.SCORE_CLIP,
        payload: {
          assetId: clip.id,
          immichAssetId: clip.immichAssetId,
          eventId: 'cmplzj6t8000q3ep96urov6ei',
          eventName: 'Memorial Day',
          activityTags: [],
        },
        status: JobStatus.QUEUED,
        attempts: 0,
        maxAttempts: 3,
      },
    });
    await scoreQueue.add(JobType.SCORE_CLIP, { dbJobId: job.id, payload: job.payload }, { jobId: job.id });
    console.log(`Enqueued SCORE_CLIP ${job.id} for clip ${clip.id}`);
  }

  // INGEST_CLIP for SOURCE_VIDEOs with 0 children
  const childlessVideos = await prisma.asset.findMany({
    where: {
      eventId: 'cmplzj6t8000q3ep96urov6ei',
      type: 'SOURCE_VIDEO',
    },
    select: { id: true, immichAssetId: true, filePath: true, status: true },
  });

  const ingestQueue = new Queue('INGEST_CLIP', { connection: redis });
  for (const video of childlessVideos) {
    const childCount = await prisma.asset.count({
      where: { parentAssetId: video.id, type: 'CLIP' },
    });
    if (childCount === 0) {
      await prisma.asset.update({
        where: { id: video.id },
        data: { status: 'UPLOADED' },
      });
      const job = await prisma.job.create({
        data: {
          type: JobType.INGEST_CLIP,
          payload: {
            assetId: video.id,
            immichAssetId: video.immichAssetId,
            eventId: 'cmplzj6t8000q3ep96urov6ei',
            eventName: 'Memorial Day',
            fileName: video.filePath,
            activityTags: [],
          },
          status: JobStatus.QUEUED,
          attempts: 0,
          maxAttempts: 3,
        },
      });
      await ingestQueue.add(JobType.INGEST_CLIP, { dbJobId: job.id, payload: job.payload }, { jobId: job.id });
      console.log(`Enqueued INGEST_CLIP ${job.id} for video ${video.id} (${video.filePath})`);
    }
  }

  await prisma.$disconnect();
  await redis.quit();
  console.log('Done');
}

main().catch(err => { console.error(err); process.exit(1); });
