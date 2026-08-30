from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.background import BackgroundTasks

from backend.app.admin.model import data_scope_rule, role_data_scope, role_menu, user_role
from backend.core.conf import settings
from backend.database.redis import redis_client


class UserCacheManager:
    """用户缓存管理

    🔴 所有 `clear_*` 都要求传入 `background_tasks`，且真正的 Redis 删除
    只登记为后台任务，**不在这里直接 await**。

    原因（issue #34）：这些方法都是从 `CurrentSessionTransaction` 端点内调用的，
    而那类端点的事务提交发生在 handler 函数体返回之后（`get_db_transaction` 的
    `async with async_db_session.begin()` 在依赖退出时才 commit）。如果这里直接
    `await redis_client.delete(...)`，删除会发生在**提交之前**——命中这个窗口的
    并发请求用另一个会话查库读到的还是旧数据，会把旧快照连同完整 TTL 重新写回
    Redis，之后即便我们的事务提交了，也没有人再清一次，缓存会锁死在旧值上
    直到 TTL 到期（默认 `TOKEN_EXPIRE_SECONDS` = 1 天）。

    FastAPI 的 `BackgroundTasks` 保证在响应对象送回 ASGI 服务器**之前**才执行——
    而依赖的退出栈（含事务提交）在响应对象组装完成之后、发送之前就已经关闭，
    所以背景任务里做的事必然发生在 commit 之后。这比"两侧都清一次"更彻底：
    不需要额外补一次提交后的清理，天生就晚于提交。
    """

    @staticmethod
    def clear(background_tasks: BackgroundTasks, user_ids: Sequence[int]) -> None:
        """
        登记「提交后」清理用户缓存

        :param background_tasks: FastAPI 后台任务（由端点注入，逐层传下来）
        :param user_ids: 用户 ID 列表
        :return:
        """
        if user_ids:
            keys = [f'{settings.JWT_USER_REDIS_PREFIX}:{user_id}' for user_id in user_ids]
            # 🔴 不能直接 `background_tasks.add_task(redis_client.delete, *keys)`。
            # redis-py 的命令方法是靠元类/注册表动态生成的，`asyncio.iscoroutinefunction`
            # 认不出它是协程函数（`inspect.iscoroutinefunction(redis_client.delete)`
            # 实测为 False）。Starlette 的 `BackgroundTask` 靠这个检测判断要不要
            # `await`——检测失败就当成同步函数扔进线程池执行，而"执行"一个 async
            # 函数只是**创建**了一个协程对象、没有人 await 它，Redis 命令**根本不会
            # 发出去**，且只有一条 "coroutine was never awaited" 的警告，没有任何
            # 报错或异常。包一层显式的 `async def` 就没有这个问题（有实测：加了这层
            # 之后 `is_async_callable` 才返回 True，端到端测试里 key 才真的被删）。

            async def _delete() -> None:
                await redis_client.delete(*keys)

            background_tasks.add_task(_delete)

    async def clear_by_role_id(self, db: AsyncSession, background_tasks: BackgroundTasks, role_ids: list[int]) -> None:
        """
        通过角色 ID 清理用户缓存

        :param db: 数据库会话
        :param background_tasks: FastAPI 后台任务
        :param role_ids: 角色 ID 列表
        :return:
        """
        stmt = select(user_role.c.user_id).where(user_role.c.role_id.in_(role_ids)).distinct()
        result = await db.execute(stmt)
        user_ids = result.scalars().all()

        self.clear(background_tasks, user_ids)

    async def clear_by_menu_id(self, db: AsyncSession, background_tasks: BackgroundTasks, menu_ids: list[int]) -> None:
        """
        通过菜单 ID 清理用户缓存

        :param db: 数据库会话
        :param background_tasks: FastAPI 后台任务
        :param menu_ids: 菜单 ID 列表
        :return:
        """
        stmt = (
            select(user_role.c.user_id)
            .join(role_menu, user_role.c.role_id == role_menu.c.role_id)
            .where(role_menu.c.menu_id.in_(menu_ids))
            .distinct()
        )
        result = await db.execute(stmt)
        user_ids = result.scalars().all()

        self.clear(background_tasks, user_ids)

    async def clear_by_data_scope_id(
        self, db: AsyncSession, background_tasks: BackgroundTasks, scope_ids: list[int]
    ) -> None:
        """
        通过数据范围 ID 清理用户缓存

        :param db: 数据库会话
        :param background_tasks: FastAPI 后台任务
        :param scope_ids: 数据范围 ID 列表
        :return:
        """
        stmt = (
            select(user_role.c.user_id)
            .join(role_data_scope, user_role.c.role_id == role_data_scope.c.role_id)
            .where(role_data_scope.c.data_scope_id.in_(scope_ids))
            .distinct()
        )
        result = await db.execute(stmt)
        user_ids = result.scalars().all()

        self.clear(background_tasks, user_ids)

    async def clear_by_data_rule_id(
        self, db: AsyncSession, background_tasks: BackgroundTasks, rule_ids: list[int]
    ) -> None:
        """
        通过数据规则 ID 清理用户缓存

        :param db: 数据库会话
        :param background_tasks: FastAPI 后台任务
        :param rule_ids: 数据规则 ID 列表
        :return:
        """
        stmt = (
            select(user_role.c.user_id)
            .join(role_data_scope, user_role.c.role_id == role_data_scope.c.role_id)
            .join(data_scope_rule, role_data_scope.c.data_scope_id == data_scope_rule.c.data_scope_id)
            .where(data_scope_rule.c.data_rule_id.in_(rule_ids))
            .distinct()
        )
        result = await db.execute(stmt)
        user_ids = result.scalars().all()

        self.clear(background_tasks, user_ids)


user_cache_manager: UserCacheManager = UserCacheManager()
