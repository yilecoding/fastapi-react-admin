"""SK 和 Webhook 签名密钥共用的加解密（`OPEN_SECRET_KEY`）"""

from backend.common.exception import errors
from backend.common.i18n import t
from backend.core.conf import settings
from backend.utils.encrypt import AESCipher


def cipher() -> AESCipher:
    """取加密器。

    🔴 **没配密钥就拒绝，不静默存明文**（同 AI 供应商密钥）：「存了但没加密」在界面上和
    「存了且加密了」完全一样，等发现时密钥已经在库里躺了很久。
    """
    key = settings.OPEN_SECRET_KEY
    if not key:
        raise errors.ServerError(msg=t('error.open.secret_key_missing'))
    try:
        return AESCipher(key)
    except ValueError as e:
        raise errors.ServerError(msg=t('error.open.secret_key_invalid')) from e


def encrypt(plain: str) -> str:
    return cipher().encrypt(plain).hex()


def decrypt(cipher_hex: str) -> str:
    return cipher().decrypt(bytes.fromhex(cipher_hex))
