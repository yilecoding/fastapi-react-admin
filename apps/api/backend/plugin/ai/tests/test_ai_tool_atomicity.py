"""#315: failed tools must not commit partial business writes or deferred effects."""

import asyncio

from types import SimpleNamespace
from typing import Any

import pytest

from sqlalchemy import Integer, String, select
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.plugin.ai.core.dispatcher import tool_dispatcher
from backend.plugin.ai.core.ports import RunContext, ToolCallRequest
from backend.plugin.ai.core.registry import _REGISTRY, ai_tool, load_builtin_tools


class Base(DeclarativeBase):
    pass


class Probe(Base):
    __tablename__ = 'ai_atomicity_probe'
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    value: Mapped[str] = mapped_column(String(32))


@pytest.mark.parametrize('failure', ['business', 'flush', 'none'])
def test_tool_failure_rolls_back_only_its_own_writes(failure: str) -> None:
    load_builtin_tools()
    effects = []
    name = 'atomicity_probe'

    async def preview() -> str:  # ruff: ignore[unused-async]
        return 'transaction probe'

    @ai_tool(name=name, description='transaction regression probe', domain='system', mutating=True, preview=preview)
    async def probe(ctx: Any) -> str:
        ctx.db.add(Probe(id=2, value='tool write'))
        await ctx.db.flush()
        ctx.background_tasks.add_task(effects.append, 'tool effect')
        if failure == 'business':
            raise RuntimeError('failure after write')
        if failure == 'flush':
            ctx.db.add(Probe(id=2, value='duplicate'))
            await ctx.db.flush()
        return 'saved'

    async def run():
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            async with create_database_async_session(engine)() as db:
                db.add(Probe(id=1, value='outer write'))
                user = SimpleNamespace(id=1, is_superuser=True, is_staff=True, roles=[])
                ctx = RunContext(user=user, conversation_id=1, db=db, provider=None)
                outcome = await tool_dispatcher.dispatch(ToolCallRequest('probe', name, {}), ctx, pre_approved=True)
                await db.commit()
                await ctx.background_tasks()
                rows = list((await db.scalars(select(Probe.id).order_by(Probe.id))).all())
                return outcome, rows
        finally:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.drop_all)
            await engine.dispose()

    try:
        outcome, rows = asyncio.run(run())
        if failure == 'none':
            assert outcome.kind == 'ok', outcome.payload
            assert rows == [1, 2]
            assert effects == ['tool effect']
        else:
            assert outcome.kind == 'failed', outcome.payload
            assert rows == [1], 'failed tool writes survived the outer commit'
            assert effects == [], 'failed tool scheduled an external side effect'
    finally:
        _REGISTRY.pop(name, None)
