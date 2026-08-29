import json
from pathlib import Path


API_PACKAGE = Path(__file__).resolve().parents[2] / 'package.json'


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

    assert scripts['db:reset'] == 'pnpm run db:init:auto'
    assert "['fba','init','--auto']" in scripts['db:init:auto']
