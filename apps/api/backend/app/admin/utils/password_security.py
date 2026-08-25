from pwdlib import PasswordHash
from pwdlib.hashers.bcrypt import BcryptHasher
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_user_password_history import user_password_history_dao
from backend.common.exception import errors
from backend.common.i18n import t
from backend.core.conf import settings
from backend.utils.dynamic_config import load_user_security_config
from backend.utils.pattern_validate import is_has_letter, is_has_number, is_has_special_char

password_hash = PasswordHash((BcryptHasher(),))

# 🔴 种子 SQL 里 admin / test 两个账号的密码 hash（明文都是 123456）。
#
# 能拿它做一次**字符串比较**是因为 bcrypt 在这里用的是固定盐，
# 三个方言的种子文件里是同一个字面量常量 —— 所以「这个库还在用默认密码吗」
# 是零假阴性的判断，不用跑 bcrypt、不用猜。
#
# 用它而不是「改种子 SQL 把密码去掉」：种子被 conftest 和整套 E2E 依赖着
# （`PYTEST_PASSWORD = '123456'`），改掉代价远大于收益。
# 真正要挡的是「生产库还在用默认密码」，那件事在 prod 启动时查一次就够了。
SEEDED_PASSWORD_HASHES: frozenset[str] = frozenset({
    '$2b$12$8y2eNucX19VjmZ3tYhBLcOsBwy9w1IjBQE4SSqwMDL5bGQVp2wqS.',  # admin
    '$2b$12$BMiXsNQAgTx7aNc7kVgnwedXGyUxPEHRnJMFbiikbqHgVoT3y14Za',  # test
    # 组织架构演示账号（种子 SQL 里补的部门经理/员工/财务/访客几个角色对应的
    # 账号），密码同样是 123456，故意保留不重置——公开演示要的就是"随便一个
    # 账号都能直接登录切换视角"。`fba init` 不处理这批账号，见 cli.py 里
    # `_set_admin_password` 只认 admin/test 两个名字。
    '$2b$12$Pnvhzs0e1pJ8qyvB9Kkv1em/IpT.46XKEfPqoIoLR2ly8RVCVEcLS',  # zhangwei
    '$2b$12$7xeTTK8azV4xXUGpZY7kBef7pfDj6ilVE1Pkt6VReNH5xd8kCgVEi',  # lina
    '$2b$12$rCfJ7pCZp/CsGhfbBcU9YuXzfYb8xl8Xm7AqSG5u0fiyoetNGInQ.',  # wangfang
    '$2b$12$z958muAw9wAclhvxw6tzROV8vIR2COsPdakXXv4d7QF7litw1Wdl6',  # liuyang
    '$2b$12$wqmNVS86davwAaQWMA/kL.P1nU4CV3HAeLcq0XdMBRSbsY5N/KIoa',  # chenjing
    '$2b$12$aQ0gVSkO.pJi7iWXvx1UBujb9vnumYbTjhmoYlPgau/eo.t9oD0Pi',  # zhaolei
    '$2b$12$T06KtP5UZLuKbgEccyCBa.9bW9nIysTPn0WyX5Bc/B3cxwLvxW62W',  # sunqiang
    '$2b$12$PUJ3wLeG0VSqQoKdvu/NKuYcnyF4AgfZDES2UoktE3uAdTeergGB.',  # zhoumin
})


def get_hash_password(password: str, salt: bytes | None) -> str:
    """
    使用哈希算法加密密码

    :param password: 密码
    :param salt: 盐值
    :return:
    """
    return password_hash.hash(password, salt=salt)


def password_verify(plain_password: str, hashed_password: str) -> bool:
    """
    密码验证

    :param plain_password: 待验证的密码
    :param hashed_password: 哈希密码
    :return:
    """
    return password_hash.verify(plain_password, hashed_password)


async def validate_new_password(db: AsyncSession, user_id: int, new_password: str) -> None:
    """
    验证新密码

    :param db: 数据库会话
    :param user_id: 用户ID
    :param new_password: 新密码
    :return:
    """
    await load_user_security_config(db)

    if len(new_password) < settings.USER_PASSWORD_MIN_LENGTH:
        raise errors.RequestError(msg=t('error.password.min_length', min_length=settings.USER_PASSWORD_MIN_LENGTH))

    if len(new_password) > settings.USER_PASSWORD_MAX_LENGTH:
        raise errors.RequestError(msg=t('error.password.max_length', max_length=settings.USER_PASSWORD_MAX_LENGTH))

    if not is_has_number(new_password):
        raise errors.RequestError(msg=t('error.password.needs_digit'))

    if not is_has_letter(new_password):
        raise errors.RequestError(msg=t('error.password.needs_letter'))

    if settings.USER_PASSWORD_REQUIRE_SPECIAL_CHAR and not is_has_special_char(new_password):
        raise errors.RequestError(msg=t('error.password.needs_special_char'))

    password_history = await user_password_history_dao.get_by_user_id(db, user_id)

    for hist in password_history[: settings.USER_PASSWORD_HISTORY_CHECK_COUNT]:
        if password_verify(new_password, hist.password):
            raise errors.RequestError(
                msg=t('error.password.reused', count=settings.USER_PASSWORD_HISTORY_CHECK_COUNT)
            )
