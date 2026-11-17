"""Menu URL schema validation without a database service."""

import pytest

from pydantic import ValidationError

from backend.app.admin.schema.menu import CreateMenuParam, UpdateMenuParam


def _body(menu_type: int, link: str) -> dict:
    return {
        'title': 'schema URL test',
        'name': 'SchemaUrlTest',
        'path': '/schema-url-test',
        'parent_id': None,
        'sort': 0,
        'icon': None,
        'type': menu_type,
        'perms': None,
        'status': 1,
        'display': 1,
        'link': link,
        'remark': None,
    }


@pytest.mark.parametrize('schema', [CreateMenuParam, UpdateMenuParam])
@pytest.mark.parametrize('link', ['/help', '/help?q=1#top'])
def test_embedded_schema_accepts_same_origin_root_relative_urls(schema, link):
    assert schema(**_body(3, link)).link == link


@pytest.mark.parametrize('schema', [CreateMenuParam, UpdateMenuParam])
@pytest.mark.parametrize('menu_type', [3, 4])
@pytest.mark.parametrize(
    'link',
    ['//attacker.example/path', 'help', r'/help\evil', 'javascript:alert(1)', 'mailto:a@example.com'],
)
def test_menu_schema_rejects_unsafe_or_ambiguous_urls(schema, menu_type, link):
    with pytest.raises(ValidationError):
        schema(**_body(menu_type, link))


def test_external_schema_still_requires_absolute_http_url():
    assert CreateMenuParam(**_body(4, 'https://example.com/help')).link == 'https://example.com/help'
    with pytest.raises(ValidationError):
        CreateMenuParam(**_body(4, '/help'))
