import installerSkill from "../../../../.agents/skills/setup-seoagent/SKILL.md?raw";

// The copyable installer and internal skill share one source of truth.
export function getAgentSetupPrompt(origin: string) {
  const instructions = installerSkill
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .trim();
  return instructions.replaceAll("http://localhost:3001", origin);
}
