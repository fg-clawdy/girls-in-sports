import { getPrisma } from "../src/lib/prisma";
import { getQueue } from "../src/lib/queues";

async function main() {
  const jobId = process.argv[2] || "cmptest_ingest_d32039f0";

  const prisma = getPrisma();
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) {
    console.error(`Job ${jobId} not found in DB`);
    process.exit(1);
  }

  const queue = getQueue(job.type);
  await queue.add(job.type, job.payload, {
    jobId: job.id,
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
  });
  console.log(`Synced job ${jobId} to BullMQ`);
}

main().catch(console.error);
