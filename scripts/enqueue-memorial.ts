import { config } from "dotenv";
config();

import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { getQueue } from "../src/lib/queues";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const eventId = process.argv[2] || "cmplzj6t8000q3ep96urov6ei";

  const jobs = await prisma.job.findMany({
    where: {
      type: "SCORE_CLIP",
      status: "QUEUED",
      payload: {
        path: ["eventId"],
        equals: eventId,
      },
    },
  });

  console.log(`Found ${jobs.length} QUEUED SCORE_CLIP jobs for event ${eventId}`);

  for (const job of jobs) {
    const queue = getQueue("SCORE_CLIP");
    const existing = await queue.getJob(job.id);
    if (existing && (await existing.isWaiting() || await existing.isDelayed() || await existing.isActive())) {
      console.log(`  SKIP ${job.id} — already in BullMQ`);
      continue;
    }

    let payload = job.payload;
    if (typeof payload === "string") {
      try { payload = JSON.parse(payload); } catch { payload = {}; }
    }

    await queue.add("SCORE_CLIP", { dbJobId: job.id, payload }, { jobId: job.id });
    console.log(`  ENQUEUED ${job.id} → BullMQ`);
  }

  await prisma.$disconnect();
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
