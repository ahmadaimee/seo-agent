#!/usr/bin/env node
// Codex plugin installs copy the plugin directory and skip symlinks, so
// plugins/seo-agent/skills/* must be real files, not symlinks to .agents/skills/*.
// Run this after editing any of the skills listed below. `pnpm ci:check` runs
// this and diffs the result, so a stale copy fails CI instead of shipping.
//
// Only skills/ is synced. The rest of the plugin payload (agents/, scripts/,
// hooks/, extensions/, docs/, tests/) lives directly in plugins/seo-agent/ and
// is edited there.
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceDir = join(repoRoot, ".agents/skills");
const targetDir = join(repoRoot, "plugins/seo-agent/skills");

const skills = [
  "seo",
  "seo-audit",
  "seo-backlinks",
  "seo-cluster",
  "seo-coach",
  "seo-competitor",
  "seo-competitor-pages",
  "seo-content",
  "seo-content-brief",
  "seo-dataforseo",
  "seo-drift",
  "seo-ecommerce",
  "seo-flow",
  "seo-geo",
  "seo-google",
  "seo-hreflang",
  "seo-image-gen",
  "seo-images",
  "seo-keywords",
  "seo-landscape",
  "seo-link-prospecting",
  "seo-local",
  "seo-maps",
  "seo-page",
  "seo-plan",
  "seo-programmatic",
  "seo-project-setup",
  "seo-schema",
  "seo-sitemap",
  "seo-sxo",
  "seo-technical",
];

// Wipe and rebuild so a skill removed from the list above doesn't leave a
// stale copy behind.
rmSync(targetDir, { recursive: true, force: true });
for (const skill of skills) {
  cpSync(join(sourceDir, skill), join(targetDir, skill), {
    recursive: true,
    dereference: true,
  });
}

console.log(`Synced ${skills.length} skills into plugins/seo-agent/skills/`);
