const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");
const { PrismaClient } = require("@prisma/client");

async function main() {
  const dbUrl = process.env.DATABASE_URL || "postgresql://sensei:dojomojo@localhost:5432/girlsinsports";
  const pool = new Pool({ connectionString: dbUrl });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  // Reset asset status
  await prisma.asset.update({
    where: { id: "cmpogl8770000agp9juww2j7q" },
    data: { status: "UPLOADED" }
  });
  console.log("Asset status reset to UPLOADED");

  // Import and run the ingest handler
  const { handleIngestClip } = require("./src/lib/handlers/ingest-clip");

  console.log("Starting handleIngestClip...");
  const start = Date.now();
  try {
    await handleIngestClip({
      payload: {
        assetId: "cmpogl8770000agp9juww2j7q",
        immichAssetId: "4544e835-35c7-42f2-9249-ffbc7fa7b149",
        eventId: "cmplzj6t8000q3ep96urov6ei",
        activityTags: ["sports"]
      },
      jobId: "test-ingest-script"
    });
    console.log("✅ Completed in", Date.now() - start, "ms");
  } catch (err) {
    console.error("❌ FAILED:", err);
  }

  // Check child clips
  const children = await prisma.asset.findMany({
    where: { parentAssetId: "cmpogl8770000agp9juww2j7q" },
    select: { id: true, durationSeconds: true, startTimeMs: true, endTimeMs: true, status: true }
  });
  console.log("\nChild clips:", children.length);
  for (const c of children) {
    console.log(" ", c.id, c.durationSeconds, c.startTimeMs, c.endTimeMs, c.status);
  }

  await prisma.$disconnect();
}

main().catch(console.error);
