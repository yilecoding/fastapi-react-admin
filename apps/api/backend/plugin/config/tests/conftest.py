import pytest

from backend.core.conf import settings


@pytest.fixture(autouse=True)
def config_encryption_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """测试密钥只在配置插件测试内有效，不依赖开发者 .env。"""
    monkeypatch.setattr(settings, 'CONFIG_ENCRYPT_SECRET_KEY', 'ab' * 32)
