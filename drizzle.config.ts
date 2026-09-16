import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "drizzle-kit";

// Locate (or lazily create) the local D1 SQLite file that wrangler/miniflare keeps
// under .wrangler, so drizzle-kit can run against the same database as `vite dev`.
function findSqliteFile(basePath: string): string | undefined {
  return fs
    .readdirSync(basePath, { encoding: "utf-8", recursive: true })
    .find((f) => f.endsWith(".sqlite"));
}

function getLocalD1Url(): string | null {
  const basePath = path.resolve(".wrangler");
  if (!fs.existsSync(basePath)) {
    console.error(
      "WARNING: .wrangler directory not found (expected in CI). Run `npm run dev` once to create the local D1 database.",
    );
    return null;
  }
  let dbFile = findSqliteFile(basePath);
  if (!dbFile) {
    const wrangler = fs.readFileSync(path.resolve("wrangler.jsonc"), "utf-8");
    const databaseName = /"database_name"\s*:\s*"([^"]+)"/.exec(wrangler)?.[1];
    if (!databaseName) {
      throw new Error(
        "Could not find database_name in wrangler.jsonc d1_databases configuration",
      );
    }
    console.log(`Initializing local D1 database: ${databaseName}...`);
    execSync(
      `npx wrangler d1 execute ${databaseName} --local --command "SELECT 1;"`,
      { stdio: "pipe" },
    );
    dbFile = findSqliteFile(basePath);
    if (!dbFile) {
      throw new Error(
        "Failed to initialize local D1 database. The sqlite file was not created.",
      );
    }
  }
  return path.resolve(basePath, dbFile);
}

const localUrl = getLocalD1Url();

export default defineConfig({
  dialect: "sqlite",
  // The raw SQLite barrel (not ../schema, the provider-aware one, which imports
  // cloudflare:workers and can't load under drizzle-kit's node runtime).
  schema: "./src/db/d1/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: localUrl || "", // Empty fallback for CI/non-dev environments
  },
});
