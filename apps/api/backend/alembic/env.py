import asyncio
import os

from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from backend.common.model import MappedBase
from backend.core import path_conf
from backend.core.path_conf import BASE_PATH
from backend.database.db import get_database_url

# 🔴 **必须 import 应用入口，否则 autogenerate 会生成一份「删掉所有表」的迁移。**
#
# `MappedBase.metadata` 只有在模型模块被 import 之后才有内容，而这个文件原来只
# import 了 `MappedBase` 本身 —— metadata 是空的。alembic 拿「空 metadata」和
# 「有 23 张表的数据库」做 diff，结论就是「把 23 张表全 drop 掉」。
# 而 `alembic revision --autogenerate` 不会问你，它只会安静地写出那份文件。
#
# 不逐个 import 模型模块（那份清单一定会漏 —— 新增 app / 插件时没人记得来改）：
# `backend.main` 会把路由 → service → crud → model 整条链拉进来，
# 和 `create_all()` 看到的表**完全一致**（这一点有测试对账：
# `test_model_matches_migrations`）。
#
# noqa: F401 —— 它就是为副作用而 import 的。
import backend.main  # noqa: F401, E402

if not os.path.exists(path_conf.ALEMBIC_VERSION_DIR):
    os.makedirs(path_conf.ALEMBIC_VERSION_DIR)

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# Interpret the config file for Python logging.
# This line sets up loggers basically.
if config.config_file_name is not None:
    fileConfig(BASE_PATH / config.config_file_name)

# add your model's MetaData object here
# for 'autogenerate' support
target_metadata = MappedBase.metadata

# other values from the config, defined by the needs of env.py,
# can be acquired:
# my_important_option = config.get_main_option("my_important_option")
# ... etc.
config.set_main_option(
    'sqlalchemy.url',
    get_database_url().render_as_string(hide_password=False).replace('%', '%%'),
)


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.  By skipping the Engine creation
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.

    """
    url = config.get_main_option('sqlalchemy.url')
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={'paramstyle': 'named'},
        compare_type=True,
        compare_server_default=True,
        transaction_per_migration=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    def process_revision_directives(context, revision, directives) -> None:  # ruff:ignore[missing-type-function-argument]
        """当迁移无变化时，不生成迁移记录"""
        if config.cmd_opts.autogenerate:
            script = directives[0]
            if script.upgrade_ops.is_empty():
                directives[:] = []
                print('\nNo changes in model detected')

    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        compare_server_default=True,
        transaction_per_migration=True,
        process_revision_directives=process_revision_directives,
    )

    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    """In this scenario we need to create an Engine
    and associate a connection with the context.

    """

    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix='sqlalchemy.',
        poolclass=pool.NullPool,
    )

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""

    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
