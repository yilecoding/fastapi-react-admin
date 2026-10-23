"""会话模型（#138）：删 sys_user.is_multi_login · 参数配置加「会话策略」组

Revision ID: s0000000session
Revises: r0000000fileconf
Create Date: 2026-10-23 20:00:00

- `is_multi_login`（用户级「允许多端登录」开关）被「每端会话上限 + 超限策略」取代，还没发版，不留休眠字段
- `sys_config` 补 13 行（同种子 `plugin/config/sql/*/init*.sql`）。不补的话升级上来的库没有这一组，
  参数配置页上看不到，登录一直按 `.env` 的默认值走 —— 功能部署了、界面上没有入口
"""

import sqlalchemy as sa

from alembic import op

from backend.utils.data_migration import delete_by_key, insert_if_absent, seeded_pk_mode
from backend.utils.timezone import timezone

# revision identifiers, used by Alembic.
revision = 's0000000session'
down_revision = 'r0000000fileconf'
branch_labels = None
depends_on = None

#: 照抄种子里那几个 ID（三个方言同一套），升级上来的库和新建的库收敛
_ROWS = (
    (2224875016875409411, '状态', 'SESSION_CONFIG_STATUS', '1', None),
    (
        2224875016875409412,
        '网页端空闲超时（分钟）',
        'SESSION_WEB_IDLE_MINUTES',
        '120',
        '这么久没有操作就自动退出；只影响之后的登录',
    ),
    (2224875016875409413, '网页端最长登录（天）', 'SESSION_WEB_ABSOLUTE_DAYS', '7', '从登录那一刻起算，刷新不延长'),
    (2224875016875409414, '网页端会话上限', 'SESSION_WEB_MAX', '0', '同一账号在这一端最多几个会话，0 表示不限'),
    (
        2224875016875409415,
        '网页端超限策略',
        'SESSION_WEB_OVERFLOW',
        'evict_idle',
        'evict_idle 挤掉最久没活跃的；deny 拒绝新登录',
    ),
    (
        2224875016875409416,
        '桌面端空闲超时（分钟）',
        'SESSION_DESKTOP_IDLE_MINUTES',
        '120',
        '这么久没有操作就自动退出；只影响之后的登录',
    ),
    (2224875016875409417, '桌面端最长登录（天）', 'SESSION_DESKTOP_ABSOLUTE_DAYS', '7', '从登录那一刻起算，刷新不延长'),
    (2224875016875409418, '桌面端会话上限', 'SESSION_DESKTOP_MAX', '0', '同一账号在这一端最多几个会话，0 表示不限'),
    (
        2224875016875409419,
        '桌面端超限策略',
        'SESSION_DESKTOP_OVERFLOW',
        'evict_idle',
        'evict_idle 挤掉最久没活跃的；deny 拒绝新登录',
    ),
    (
        2224875016875409420,
        '移动端空闲超时（分钟）',
        'SESSION_MOBILE_IDLE_MINUTES',
        '43200',
        '这么久没有操作就自动退出；只影响之后的登录',
    ),
    (2224875016875409421, '移动端最长登录（天）', 'SESSION_MOBILE_ABSOLUTE_DAYS', '90', '从登录那一刻起算，刷新不延长'),
    (2224875016875409422, '移动端会话上限', 'SESSION_MOBILE_MAX', '1', '同一账号在这一端最多几个会话，0 表示不限'),
    (
        2224875016875409423,
        '移动端超限策略',
        'SESSION_MOBILE_OVERFLOW',
        'evict_idle',
        'evict_idle 挤掉最久没活跃的；deny 拒绝新登录',
    ),
)


def upgrade() -> None:
    op.drop_column('sys_user', 'is_multi_login')

    if not seeded_pk_mode():
        # 自增主键模式没有基础种子（同 k0000000openapp）
        return
    conn = op.get_bind()
    for pk, name, key, value, remark in _ROWS:
        # 按 `key` 判存在：有人已经在界面上手工加过同名键，就不再插第二条、也不覆盖他填的值
        insert_if_absent(
            conn,
            'sys_config',
            {'key': key},
            {
                'id': pk,
                'name': name,
                'type': 'SESSION',
                'value': value,
                'is_frontend': False,
                'remark': remark,
                'created_time': timezone.now(),
                'updated_time': None,
            },
        )


def downgrade() -> None:
    if seeded_pk_mode():
        # 连 id 一起对：upgrade 时按 key 跳过了的那条（别人手工加的）不是这条迁移的，降级不该删它
        for pk, _, key, _, _ in _ROWS:
            delete_by_key(op.get_bind(), 'sys_config', id=pk, key=key)

    # 回填存量行要 server_default；加完再去掉，和 create_all 建出来的表保持一致（模型侧是 Python 默认值）
    op.add_column(
        'sys_user',
        sa.Column(
            'is_multi_login', sa.Boolean(), nullable=False, server_default=sa.false(), comment='是否重复登陆(0否 1是)'
        ),
    )
    op.alter_column('sys_user', 'is_multi_login', server_default=None)
