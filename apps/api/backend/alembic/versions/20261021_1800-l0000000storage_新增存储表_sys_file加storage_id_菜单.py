"""新增存储表（sys_storage）、sys_file 加 storage_id 与 path 索引，补齐已存在库缺的菜单（#122）

Revision ID: l0000000storage
Revises: k0000000openapp
Create Date: 2026-10-21 18:00:00

`sys_file.storage_id` 可空、**存量行不回填**：NULL 就是「内置本地存储」（见 model/storage.py），
存量文件本来就都在那里。所以这条迁移对已有文件是零数据变更，也没有「回填一半失败」这种状态。

🔴 手写的建表要自己写 `autoincrement=False`：autogenerate 渲染不出模型侧的 Python 默认值，
SQL Server 上会把雪花主键建成 IDENTITY（alembic 分册）。
"""

import sqlalchemy as sa

from alembic import op

import backend.common.model

from backend.utils.data_migration import add_menu, delete_by_key, seeded_pk_mode

# revision identifiers, used by Alembic.
revision = 'l0000000storage'
down_revision = 'k0000000openapp'
branch_labels = None
depends_on = None

#: 和 `sql/*/init_snowflake_test_data.sql` 同一套 ID，升级上来的库和新建的库收敛到同一份数据。
#: (menu_id, name, title, path, icon, menu_type, perms, sort, display, parent_name)
_MENUS = [
    (2049629108253622304, 'SysStorage', '存储管理', '/system/storage', 'lucide:hard-drive', 1, None, 7, 1, 'System'),
    (2049629108253622305, 'QuerySysStorage', '查询', None, None, 2, 'sys:storage:list', 0, 0, 'SysStorage'),
    (2049629108253622306, 'AddSysStorage', '新增', None, None, 2, 'sys:storage:add', 1, 0, 'SysStorage'),
    (2049629108253622307, 'EditSysStorage', '修改', None, None, 2, 'sys:storage:edit', 2, 0, 'SysStorage'),
    (2049629108253622308, 'DeleteSysStorage', '删除', None, None, 2, 'sys:storage:del', 3, 0, 'SysStorage'),
]


def upgrade() -> None:
    op.create_table(
        'sys_storage',
        sa.Column('id', sa.BigInteger(), autoincrement=False, nullable=False, comment='雪花算法主键 ID'),
        sa.Column('name', backend.common.model.UniversalStr(length=64), nullable=False, comment='存储名称'),
        sa.Column('code', backend.common.model.UniversalStr(length=32), nullable=False, comment='存储编码'),
        sa.Column(
            'type',
            backend.common.model.UniversalStr(length=16),
            nullable=False,
            comment='存储类型（local：本地；s3：S3 兼容）',
        ),
        sa.Column(
            'root', backend.common.model.UniversalStr(length=512), nullable=False, comment='本地根目录 / 对象键前缀'
        ),
        sa.Column('endpoint', backend.common.model.UniversalStr(length=255), nullable=True, comment='S3 端点'),
        sa.Column('bucket', backend.common.model.UniversalStr(length=128), nullable=True, comment='S3 桶名'),
        sa.Column('region', backend.common.model.UniversalStr(length=64), nullable=True, comment='S3 区域'),
        sa.Column(
            'addressing',
            backend.common.model.UniversalStr(length=16),
            nullable=False,
            comment='寻址方式（auto / virtual：虚拟主机 / path：路径）',
        ),
        sa.Column(
            'access_key', backend.common.model.UniversalStr(length=128), nullable=True, comment='Access Key（明文）'
        ),
        sa.Column(
            'secret_cipher', backend.common.model.UniversalText(), nullable=True, comment='Secret Key 密文（AES）'
        ),
        sa.Column(
            'secret_hint', backend.common.model.UniversalStr(length=24), nullable=True, comment='Secret Key 前几位'
        ),
        sa.Column(
            'public_base_url',
            backend.common.model.UniversalStr(length=512),
            nullable=True,
            comment='公开访问地址前缀',
        ),
        sa.Column('is_default', sa.Boolean(), nullable=False, comment='是否默认存储（新上传落这里）'),
        sa.Column('status', sa.Integer(), nullable=False, comment='状态（0：停用、1：正常）'),
        sa.Column('remark', backend.common.model.UniversalText(), nullable=True, comment='备注'),
        sa.Column('created_time', backend.common.model.TimeZone(timezone=True), nullable=False, comment='创建时间'),
        sa.Column('updated_time', backend.common.model.TimeZone(timezone=True), nullable=True, comment='更新时间'),
        sa.Column(
            'deleted', sa.BigInteger(), server_default='0', nullable=False, comment='是否已删除（0：否；id：是）'
        ),
        sa.Column('deleted_time', backend.common.model.TimeZone(timezone=True), nullable=True, comment='删除时间'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('code', 'deleted', name='uk_sys_storage_code_deleted'),
        comment='系统存储表',
    )
    op.create_index(op.f('ix_sys_storage_id'), 'sys_storage', ['id'], unique=True)

    op.add_column(
        'sys_file',
        sa.Column('storage_id', sa.BigInteger(), nullable=True, comment='所属存储 ID（NULL：内置本地存储）'),
    )
    op.create_index(op.f('ix_sys_file_storage_id'), 'sys_file', ['storage_id'], unique=False)
    op.create_index('ix_sys_file_path', 'sys_file', ['path'], unique=False)

    if not seeded_pk_mode():
        # 自增主键模式没有基础种子（同 k0000000openapp）
        return
    conn = op.get_bind()
    for menu_id, name, title, path, icon, menu_type, perms, sort, display, parent in _MENUS:
        add_menu(
            conn,
            menu_id=menu_id,
            name=name,
            title=title,
            path=path,
            perms=perms,
            icon=icon,
            menu_type=menu_type,
            sort=sort,
            display=display,
            parent_name=parent,
        )


def downgrade() -> None:
    if seeded_pk_mode():
        conn = op.get_bind()
        # 倒序删：先叶子后目录，否则子项变孤儿被提到侧边栏根上
        for menu in reversed(_MENUS):
            delete_by_key(conn, 'sys_menu', name=menu[1])
    op.drop_index('ix_sys_file_path', table_name='sys_file')
    op.drop_index(op.f('ix_sys_file_storage_id'), table_name='sys_file')
    op.drop_column('sys_file', 'storage_id')
    op.drop_index(op.f('ix_sys_storage_id'), table_name='sys_storage')
    op.drop_table('sys_storage')
