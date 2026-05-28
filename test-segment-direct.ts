import { analyzeAndSegment } from "./src/lib/scene-detection-service";
import { ActivityTag } from "./src/lib/activity-tags";

async function main() {
  console.log("Testing analyzeAndSegment with threshold=25...");
  const start = Date.now();
  const result = await analyzeAndSegment(
    "cmpogl8770000agp9juww2j7q",
    "/tmp/gis/cmpogl8770000agp9juww2j7q/source",
    "cmplzj6t8000q3ep96urov6ei",
    ["sports"] as ActivityTag[],
    "4544e835-35c7-42f2-9249-ffbc7fa7b149"
  );
  console.log("Result:", JSON.stringify(result, null, 2));
  console.log("Took:", Date.now() - start, "ms");
}
main().catch(console.error);
