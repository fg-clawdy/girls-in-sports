import { config } from "dotenv";
config();

import { getPrisma } from "./src/lib/prisma";
import { handleIngestClip } from "./src/lib/handlers/ingest-clip";

async function main() {
  const prisma = getPrisma();

  // Clean up stale child clips
  await prisma.asset.deleteMany({
    where: { parentAssetId: "cmpogl8770000agp9juww2j7q" }
  });
  console.log("Deleted stale child clips");

  // Reset source asset to UPLOADED
  await prisma.asset.update({
    where: { id: "cmpogl8770000agp9juww2j7q" },
    data: { status: "UPLOADED" }
  });
  console.log("Asset status reset to UPLOADED");

  console.log("\nStarting handleIngestClip...");
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

  // Check source asset status
  const source = await prisma.asset.findUnique({
    where: { id: "cmpogl8770000agp9juww2j7q" },
    select: { status: true }
  });
  console.log("\nSource asset status:", source?.status);

  await prisma.$disconnect();
}

main().catch(console.error);
