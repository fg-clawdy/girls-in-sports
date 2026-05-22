import { prisma } from "./src/lib/prisma";

async function main() {
  const eventId = "cmpdgj7rj0000h0p91wx5cjri";
  
  const event = await prisma.event.findUnique({
    where: { id: eventId },
  });
  console.log("Event:", JSON.stringify(event, null, 2));
  
  const tier = event?.qualityTier ?? "PROFESSIONAL";
  console.log("Tier:", tier);
  
  const clips = await prisma.asset.findMany({
    where: {
      eventId,
      OR: [
        { type: "CLIP" },
        { type: "SOURCE_VIDEO", status: "SCORED" },
      ],
      status: "SCORED",
    },
    include: {
      clipScore: true,
      assetTags: true,
    },
  });
  
  console.log("Clips count:", clips.length);
  
  for (const clip of clips) {
    const m = clip.clipScore?.momentScore ?? 0;
    const p = clip.clipScore?.productionScore ?? 0;
    console.log(`Clip ${clip.id}: type=${clip.type}, status=${clip.status}, moment=${m}, production=${p}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
