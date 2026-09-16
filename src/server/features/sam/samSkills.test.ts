import { describe, expect, it } from "vitest";
import { buildSamSkillSource } from "@/server/features/sam/samSkills";

describe("buildSamSkillSource", () => {
  // Guards the real failure modes: a skill whose frontmatter breaks (build
  // throws), an internal repo-dev skill leaking into SAM, or the public set
  // silently shrinking because a glob or marking change dropped it.
  //
  // The list is deliberately narrower than .agents/skills. Skills marked
  // `metadata.requiresLocalRuntime` drive the plugin's bundled Python toolchain
  // (crawler, headless Chromium, local report files), which SAM has no way to
  // run inside the Worker. They ship in the Claude Code plugin only.
  it("serves exactly the public product skills", async () => {
    const source = buildSamSkillSource();
    const names = (await source.list()).map((skill) => skill.name);

    expect(names).toEqual([
      "seo-audit",
      "seo-backlinks",
      "seo-cluster",
      "seo-coach",
      "seo-competitor",
      "seo-keywords",
      "seo-landscape",
      "seo-link-prospecting",
      "seo-local",
      "seo-maps",
      "seo-project-setup",
    ]);

    const loaded = await source.load("seo-project-setup");
    expect(loaded?.body).toContain("Surface note: you are SAM");
  });
});
