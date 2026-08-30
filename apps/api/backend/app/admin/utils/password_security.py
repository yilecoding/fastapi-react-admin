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
#
# 🔴 只放 admin / test——**不要**把公开演示账号也塞进这一份。
# 这份集合是 `registrar.py: _verify_production_database()` 的拒绝启动名单，
# 不是"已知种子密码"的通用登记表；公开演示账号要的是"永远保持 123456"，
# 跟这份名单的语义（"还在用默认密码，改掉再启动"）正好相反。
# 之前两者混在一起，8 个演示账号一齐进了这份 frozenset，实测直接把生产库
# 启动锁死：`_verify_production_database()` 一查到它们就拒绝启动，
# 而这些账号的密码本来就设计成永远不会被改掉——见下面 `SEEDED_DEMO_PASSWORD_HASHES`
# 的说明。两份集合的并集才是 `test_seeded_password_hashes_cover_every_seeded_account`
# 要扫的"种子里出现的所有 123456 hash"，别只改一份漏了那条测试。
SEEDED_PASSWORD_HASHES: frozenset[str] = frozenset({
    '$2b$12$8y2eNucX19VjmZ3tYhBLcOsBwy9w1IjBQE4SSqwMDL5bGQVp2wqS.',  # admin
    '$2b$12$BMiXsNQAgTx7aNc7kVgnwedXGyUxPEHRnJMFbiikbqHgVoT3y14Za',  # test
})

# 组织架构演示账号（种子 SQL 里补的部门经理/员工/财务/访客几个角色对应的账号），
# 密码同样是 123456，**故意永远不重置**——公开演示要的就是"随便一个账号都能
# 直接登录切换视角"。`fba init` 不处理这批账号，见 cli.py 里 `_set_admin_password`
# 只认 admin/test 两个名字。
#
# 🔴 刻意**不**并进 `SEEDED_PASSWORD_HASHES`：那份是给 prod 启动检查当拒绝名单用的，
# 这批账号命中了就会把生产库启动锁死（实测：新加 8 个演示账号后重启 api 容器，
# 连续崩溃重启 12 次，`web`/`beat` 因为在等 api 健康一直卡在 Created，
# 公开演示站点整个 502）。这份集合只用于种子 hash 的覆盖面对账测试，
# 不参与 `_verify_production_database()` 的查询。
SEEDED_DEMO_PASSWORD_HASHES: frozenset[str] = frozenset({
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


async def validate_password_strength(db: AsyncSession, new_password: str) -> None:
    """
    只验证密码强度（长度/数字/字母/特殊字符），不查历史复用。

    🔴 **拆出这个函数是因为「新建用户」和「改密/重置密码」不是同一件事**：
    改密/重置密码时目标用户已经存在，能查 `sys_user_password_history`；
    新建用户时雪花 ID 要等 `db.flush()` 之后才有，压根没有 `user_id` 可传，
    历史复用检查这时候无意义（新用户没有历史）。以前 `create()` 完全没调用
    密码强度校验（只有 `reset_password`/`update_password` 两条路径挂了
    `validate_new_password()`），意味着建号接口对密码强度是不设防的——
    前端 `user/form.tsx` 的 `z.string().min(6)` 只是前端自己的一厢情愿，
    直接打接口（比如批量导入）完全绕得过去。

    :param db: 数据库会话
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


async def validate_new_password(db: AsyncSession, user_id: int, new_password: str) -> None:
    """
    验证新密码：强度 + 历史复用，给「用户已存在」的改密/重置密码场景用。
    新建用户场景（没有 `user_id`）请直接调 `validate_password_strength()`。

    :param db: 数据库会话
    :param user_id: 用户ID
    :param new_password: 新密码
    :return:
    """
    await validate_password_strength(db, new_password)

    password_history = await user_password_history_dao.get_by_user_id(db, user_id)

    for hist in password_history[: settings.USER_PASSWORD_HISTORY_CHECK_COUNT]:
        if password_verify(new_password, hist.password):
            raise errors.RequestError(msg=t('error.password.reused', count=settings.USER_PASSWORD_HISTORY_CHECK_COUNT))
