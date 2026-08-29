import json

from pathlib import Path

API_PACKAGE = Path(__file__).resolve().parents[2] / 'package.json'
ROOT_PACKAGE = API_PACKAGE.parents[2] / 'package.json'


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise AssertionError(f'duplicate JSON key: {key}')
        result[key] = value
    return result


def test_api_package_scripts_are_unique_and_reset_rebuilds_database() -> None:
    package = json.loads(API_PACKAGE.read_text(encoding='utf-8'), object_pairs_hook=_reject_duplicate_keys)
    scripts = package['scripts']

    assert 'db:init:auto' not in scripts
    assert "['fba','init','--auto']" in scripts['db:reset']


def test_root_package_exposes_only_the_two_database_lifecycle_commands() -> None:
    package = json.loads(ROOT_PACKAGE.read_text(encoding='utf-8'), object_pairs_hook=_reject_duplicate_keys)
    scripts = package['scripts']

    assert scripts['db:init'] == 'pnpm --filter api db:init'
    assert scripts['db:reset'] == 'pnpm --filter api db:reset'
    assert 'db:init:auto' not in scripts
