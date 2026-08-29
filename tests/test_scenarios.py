from __future__ import annotations

from lightrp.scenarios_harness import load_scenario, run_scenario, scenarios_dir


def test_all_scenarios_dry_run() -> None:
    root = scenarios_dir()
    assert root.is_dir()
    paths = sorted(root.glob("*.yaml"))
    assert paths, "expected scenario yaml files"
    for path in paths:
        errors = run_scenario(load_scenario(path))
        assert not errors, f"{path.name}: {errors}"


def test_memory_promise_fixture_persists() -> None:
    path = scenarios_dir() / "memory_promise.yaml"
    errors = run_scenario(load_scenario(path))
    assert not errors
