const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");
const { PrismaClient, JobType } = require("@prisma/client");
const { Queue } = require("bullmq");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

async function main() {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error("Usage: node sync-one.js <jobId>");
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_URL || "postgresql://sensei:dojomojo@localhost:5432/girlsinsports";
  const pool = new Pool({ connectionString: dbUrl });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) {
    console.error(`Job ${jobId} not found`);
    await prisma.$disconnect();
    process.exit(1);
  }

  const queue = new Queue(job.type, { connection: { url: REDIS_URL } });
  await queue.add(job.type, { dbJobId: job.id, payload: job.payload }, { jobId: job.id });
  console.log(`Synced ${jobId} to BullMQ`);
  await queue.close();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
