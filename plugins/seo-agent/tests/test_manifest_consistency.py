"""Manifest and count consistency for the merged S.E.O Agent plugin.

The plugin ships three manifests (Claude, Codex, Cursor), a marketplace entry at
the repository root, a Python toolchain with its own pyproject, and an
orchestrator skill that enumerates its sub-skills in prose. Those numbers drift
apart the moment someone adds a skill and updates only one of them, and a wrong
count in a user-visible description is a bug we have shipped before.

This module locks them together:

* every manifest carries the same version, and so does pyproject and every skill
* the counts claimed in prose equal what is actually on disk
* the orchestrator's Sub-Skills list equals the skills/ directory
* the marketplace entry points at this plugin

Layout note: unlike the standalone upstream, marketplace.json lives at the
repository root (one marketplace, one plugin), and the plugin has no CITATION.cff
or manual installers -- it is installed through the marketplace.
"""

from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = PLUGIN_ROOT.parent.parent

PLUGIN_JSON = PLUGIN_ROOT / ".claude-plugin" / "plugin.json"
CODEX_JSON = PLUGIN_ROOT / ".codex-plugin" / "plugin.json"
CURSOR_JSON = PLUGIN_ROOT / ".cursor-plugin" / "plugin.json"
MARKETPLACE_JSON = REPO_ROOT / ".claude-plugin" / "marketplace.json"
PYPROJECT = PLUGIN_ROOT / "pyproject.toml"
ORCHESTRATOR = PLUGIN_ROOT / "skills" / "seo" / "SKILL.md"
SKILLS_DIR = PLUGIN_ROOT / "skills"
AGENTS_DIR = PLUGIN_ROOT / "agents"


def _json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _skill_dirs() -> list[str]:
    return sorted(p.name for p in SKILLS_DIR.iterdir() if (p / "SKILL.md").is_file())


def _agent_files() -> list[str]:
    return sorted(p.stem for p in AGENTS_DIR.glob("*.md"))


# --------------------------------------------------------------------- version


def test_every_manifest_carries_the_same_version():
    version = _json(PLUGIN_JSON)["version"]
    assert re.fullmatch(r"\d+\.\d+\.\d+", version), f"bad version {version!r}"
    for path in (CODEX_JSON, CURSOR_JSON):
        assert _json(path)["version"] == version, (
            f"{path.name} is {_json(path)['version']}, plugin.json is {version}"
        )


def test_pyproject_version_matches_plugin_json():
    version = _json(PLUGIN_JSON)["version"]
    pyproject = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    assert pyproject["project"]["version"] == version


def test_skill_metadata_versions_match_plugin_json():
    version = _json(PLUGIN_JSON)["version"]
    drift = []
    for skill in SKILLS_DIR.iterdir():
        skill_md = skill / "SKILL.md"
        if not skill_md.is_file():
            continue
        match = re.search(r"^\s*version:\s*[\"']?([\d.]+)", skill_md.read_text(encoding="utf-8"), re.M)
        if match and match.group(1) != version:
            drift.append(f"{skill.name}: {match.group(1)}")
    assert not drift, "Skill metadata.version drift: " + ", ".join(drift)


# ---------------------------------------------------------------------- counts


def test_plugin_json_skill_count_matches_disk():
    description = _json(PLUGIN_JSON)["description"]
    match = re.search(r"(\d+)\s+skills", description)
    assert match, f"plugin.json description claims no skill count: {description!r}"
    claimed, actual = int(match.group(1)), len(_skill_dirs())
    assert claimed == actual, (
        f"plugin.json claims {claimed} skills but skills/ holds {actual}"
    )


def test_plugin_json_subagent_count_matches_disk():
    description = _json(PLUGIN_JSON)["description"]
    match = re.search(r"(\d+)\s+sub-agents", description)
    assert match, f"plugin.json description claims no sub-agent count: {description!r}"
    claimed, actual = int(match.group(1)), len(_agent_files())
    assert claimed == actual, (
        f"plugin.json claims {claimed} sub-agents but agents/ holds {actual}"
    )


def test_orchestrator_sub_skills_list_matches_disk():
    """The orchestrator enumerates every sibling skill, and only those."""
    text = ORCHESTRATOR.read_text(encoding="utf-8")
    section = text[text.index("## Sub-Skills"):]
    section = section[: section.index("### Optional Extensions")]
    listed = set(re.findall(r"^\d+\.\s+\*\*([a-z0-9-]+)\*\*", section, re.M))
    on_disk = set(_skill_dirs()) - {"seo"}
    assert listed == on_disk, (
        "Sub-Skills list != skills/ dir. "
        f"Missing from list: {sorted(on_disk - listed)}. "
        f"Listed but absent: {sorted(listed - on_disk)}"
    )


def test_orchestrator_claims_the_same_counts_as_plugin_json():
    description = _json(PLUGIN_JSON)["description"]
    skills = int(re.search(r"(\d+)\s+skills", description).group(1))
    agents = int(re.search(r"(\d+)\s+sub-agents", description).group(1))
    text = ORCHESTRATOR.read_text(encoding="utf-8")
    match = re.search(r"Orchestrates (\d+) sub-skills and (\d+) sub-agents", text)
    assert match, "orchestrator does not state 'Orchestrates N sub-skills and M sub-agents'"
    # The orchestrator does not orchestrate itself, so it lists one fewer skill.
    assert int(match.group(1)) == skills - 1, (
        f"orchestrator says {match.group(1)} sub-skills; plugin.json implies {skills - 1}"
    )
    assert int(match.group(2)) == agents


# ----------------------------------------------------------------- marketplace


def test_marketplace_entry_points_at_this_plugin():
    marketplace = _json(MARKETPLACE_JSON)
    entries = [p for p in marketplace["plugins"] if p["name"] == _json(PLUGIN_JSON)["name"]]
    assert entries, "marketplace.json has no entry for this plugin"
    entry = entries[0]
    source = entry["source"].strip("./")
    assert (REPO_ROOT / source / ".claude-plugin" / "plugin.json").is_file(), (
        f"marketplace source {entry['source']!r} does not resolve to the plugin"
    )


def test_marketplace_description_is_not_stale():
    """The marketplace blurb must not still advertise the pre-merge skill set."""
    entry = [
        p for p in _json(MARKETPLACE_JSON)["plugins"]
        if p["name"] == _json(PLUGIN_JSON)["name"]
    ][0]
    description = entry["description"]
    match = re.search(r"(\d+)\s+skills", description)
    assert match, f"marketplace description claims no skill count: {description!r}"
    assert int(match.group(1)) == len(_skill_dirs())


# ------------------------------------------------------------------- user docs


def test_readme_states_the_canonical_counts():
    readme = (PLUGIN_ROOT / "README.md").read_text(encoding="utf-8")
    skills = len(_skill_dirs())
    agents = len(_agent_files())
    assert f"{skills} skills" in readme, f"README does not state '{skills} skills'"
    assert f"{agents} sub-agents" in readme, f"README does not state '{agents} sub-agents'"
