"""参数配置加「文件上传」组：分片阈值 / 每片大小可在界面配置（#139）

Revision ID: r0000000fileconf
Revises: q0000000mysqldt
Create Date: 2026-10-23 16:00:00

不动表结构，只补 `sys_config` 的三行（同种子 `plugin/config/sql/*/init*.sql`）。不补的话升级上来的库没有这一组，
参数配置页上看不到这两项，`upload-policy` 一直下发 `.env` 的值 —— 功能部署了、界面上没有入口。
"""

from alembic import op

from backend.utils.data_migration import delete_by_key, insert_if_absent, seeded_pk_mode
from backend.utils.timezone import timezone

# revision identifiers, used by Alembic.
revision = 'r0000000fileconf'
down_revision = 'q0000000mysqldt'
branch_labels = None
depends_on = None

#: 照抄种子里那几个 ID（三个方言同一套），升级上来的库和新建的库收敛。
#: 值的单位是 MiB（见 `dynamic_config.load_file_config`）
_ROWS = (
    (2224875016875409408, '状态', 'FILE_CONFIG_STATUS', '1', None),
    (
        2224875016875409409,
        '分片阈值（MiB）',
        'FILE_CHUNK_THRESHOLD',
        '16',
        '不小于这个大小的文件分片上传；须小于反代的 client_max_body_size',
    ),
    (2224875016875409410, '分片大小（MiB）', 'FILE_CHUNK_SIZE', '8', '只影响新开始的上传；.env 同名项的单位是字节'),
)


def upgrade() -> None:
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
                'type': 'FILE',
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
