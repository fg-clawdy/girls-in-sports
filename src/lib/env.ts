import { z } from "zod";

const envSchema = z.object({
  IMMICH_API_URL: z.string().url().default("http://localhost:2283"),
  IMMICH_API_KEY: z.string().min(1, "IMMICH_API_KEY is required"),
  VENICE_API_KEY: z.string().min(1, "VENICE_API_KEY is required"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().email().optional(),
  SHARE_JWT_SECRET: z.string().min(16, "SHARE_JWT_SECRET must be at least 16 characters").optional(),
  NEXTAUTH_SECRET: z.string().optional(),
  NEXT_PUBLIC_APP_URL: z.string().url().optional().default("http://localhost:3010"),
});

let parsedEnv: z.infer<typeof envSchema> | null = null;

export function getEnv() {
  if (!parsedEnv) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      const issues = result.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`
      );
      throw new Error(`Environment validation failed:\n${issues.join("\n")}`);
    }
    parsedEnv = result.data;
  }
  return parsedEnv;
}
