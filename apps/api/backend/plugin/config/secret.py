"""参数密钥的存储格式。数据库只存带版本的密文，解密只发生在内部取用时。"""

from sqlalchemy import column, select, table, update
from sqlalchemy.engine import Connection

from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.secret_keys import is_secret_key_name
from backend.core.conf import settings
from backend.utils.encrypt import AESCipher

PREFIX = 'enc:v1:'


def _cipher() -> AESCipher:
    """独立密钥由部署提供；不生成临时密钥，也不退化为明文存储。"""
    try:
        key = bytes.fromhex(settings.CONFIG_ENCRYPT_SECRET_KEY)
        if len(key) not in (16, 24, 32):
            raise ValueError('invalid key length')
        return AESCipher(key)
    except ValueError:
        raise errors.ServerError(msg=t('error.config.encrypt_key_invalid')) from None


def encrypt_secret(value: str) -> str:
    """把调用方提交的新值作为明文加密；空值保持为空。"""
    return PREFIX + _cipher().encrypt(value).hex() if value else ''


def decrypt_secret(value: str) -> str:
    """只接受明确的密文格式；损坏的密文不能被当作旧明文使用。"""
    if not value:
        return ''
    if not value.startswith(PREFIX):
        raise errors.ServerError(msg=t('error.config.secret_decrypt_failed'))
    try:
        return _cipher().decrypt(value[len(PREFIX) :])
    except (ValueError, UnicodeError):
        raise errors.ServerError(msg=t('error.config.secret_decrypt_failed')) from None


def encrypt_legacy_configs(connection: Connection) -> int:
    """数据迁移：包含软删除行；先验证整批，再写入，重复执行不二次加密。"""
    configs = table('sys_config', column('id'), column('key'), column('value'))
    changes: list[tuple[int, str]] = []
    for row in connection.execute(select(configs)).mappings():
        value = row['value']
        if not is_secret_key_name(row['key']) or not value:
            continue
        if value.startswith(PREFIX):
            decrypt_secret(value)
        else:
            changes.append((row['id'], encrypt_secret(value)))
    for pk, value in changes:
        connection.execute(update(configs).where(configs.c.id == pk).values(value=value))
    return len(changes)
