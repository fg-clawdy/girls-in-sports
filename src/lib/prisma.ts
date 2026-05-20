import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

let _prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!_prisma) {
    const dbUrl = process.env.DATABASE_URL || "postgresql://sensei:dojomojo@localhost:5432/girlsinsports";
    const pool = new Pool({ connectionString: dbUrl });
    const adapter = new PrismaPg(pool);
    _prisma = new PrismaClient({ adapter });
  }
  return _prisma;
}

// Lazy proxy — does NOT create PrismaClient until first property access.
// Critical: this module may be imported by worker.ts BEFORE dotenv.config() runs.
// The Pool must not be created until env vars are actually loaded.
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getPrisma();
    return (client as any)[prop];
  },
});
