import { PrismaClient, JobType, JobStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://sensei:dojomojo@localhost:5432/girlsinsports';

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });
  const redis = new IORedis(REDIS_URL);

  const videoIds = [
    'cmpnjz0240006g0p9ql47it09', // 10904.mp4, 14.7s
    'cmplzp4s6000r3ep9gywuo1wn', // 10910.mp4, 7.7s
    'cmpnjyvxl0004g0p9m4k25hsh', // 10907.mp4, 5.1s
  ];

  const ingestQueue = new Queue('INGEST_CLIP', { connection: redis });

  for (const videoId of videoIds) {
    const video = await prisma.asset.findUnique({
      where: { id: videoId },
      select: { id: true, immichAssetId: true, filePath: true, status: true },
    });
    if (!video) {
      console.log(`Video ${videoId} not found`);
      continue;
    }

    // Reset to UPLOADED so it can be re-ingested
    await prisma.asset.update({
      where: { id: videoId },
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

  await prisma.$disconnect();
  await redis.quit();
  console.log('Done');
}

main().catch(err => { console.error(err); process.exit(1); });
