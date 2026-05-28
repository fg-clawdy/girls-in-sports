const { Queue } = require("bullmq");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

async function main() {
  const q = new Queue("INGEST_CLIP", { connection: { url: REDIS_URL } });
  const waiting = await q.getJobs(["waiting", "delayed", "paused"]);
  console.log(`Waiting jobs: ${waiting.length}`);
  for (const job of waiting.slice(0, 5)) {
    console.log(`  ${job.id}: payload=${JSON.stringify(job.data).slice(0, 80)}`);
  }
  
  const active = await q.getJobs(["active"]);
  console.log(`Active jobs: ${active.length}`);
  for (const job of active) {
    console.log(`  ${job.id}`);
  }
  
  await q.close();
}

main().catch(console.error);
