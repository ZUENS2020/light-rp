from __future__ import annotations

from pathlib import Path


def package_root() -> Path:
    return Path(__file__).resolve().parent


def package_prompts_dir() -> Path:
    return package_root() / "prompts"


def package_example_world() -> Path:
    return package_root() / "data" / "example"


def repo_example_world() -> Path:
    return package_root().parents[1] / "worlds" / "_example"


def find_example_world() -> Path:
    repo = repo_example_world()
    if (repo / "WORLD.md").is_file():
        return repo
    pkg = package_example_world()
    if (pkg / "WORLD.md").is_file():
        return pkg
    raise FileNotFoundError("bundled example world is missing (WORLD.md)")


def default_home() -> Path:
    return Path.home() / ".lightrp"


def default_worlds_dir() -> Path:
    return default_home() / "worlds"


def default_user_prompts_dir() -> Path:
    return default_home() / "prompts"


def default_config_path() -> Path:
    return default_home() / "config.yaml"
