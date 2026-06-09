import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3"

import { PrismaClient } from "../../../generated/prisma/client"

const databaseUrl = process.env.DATABASE_URL ?? "file:./dev.db"

declare global {
  var __emailkitSandboxPrisma: PrismaClient | undefined
}

export const prisma =
  globalThis.__emailkitSandboxPrisma ??
  new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: databaseUrl }),
  })

if (process.env.NODE_ENV !== "production") {
  globalThis.__emailkitSandboxPrisma = prisma
}
