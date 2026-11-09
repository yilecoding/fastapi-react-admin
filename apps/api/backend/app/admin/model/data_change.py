from datetime import datetime

import sqlalchemy as sa

from sqlalchemy.orm import Mapped, mapped_column

from backend.common.model import DataClassBase, TimeZone, UniversalStr, id_key


class DataChange(DataClassBase):
    """数据变更记录表（#260）：谁、什么时候、从哪来，把哪个对象的哪些字段从什么改成了什么

    一个事务 × 一个对象 = 一行（同一个请求里先改资料、再清手机验证，合成一行）。
    行由 `common/data_change/capture.py` 在业务事务**提交之前、同一个事务里**写，业务回滚就一行都没有。
    """

    __tablename__ = 'sys_data_change'
    __table_args__ = (
        # 「某个对象的变更记录」抽屉按它倒序翻页
        sa.Index('ix_sys_data_change_entity', 'entity_type', 'entity_id', 'created_time'),
        {'comment': '数据变更记录表'},
    )

    id: Mapped[id_key] = mapped_column(init=False)
    trace_id: Mapped[str] = mapped_column(UniversalStr(64), index=True, comment='请求跟踪 ID（和操作日志同一个）')
    entity_type: Mapped[str] = mapped_column(
        UniversalStr(32), comment='对象类型（user / dept / role / menu / config…）'
    )
    entity_id: Mapped[int | None] = mapped_column(sa.BigInteger, comment='对象 ID（批量汇总行为空）')
    entity_label: Mapped[str | None] = mapped_column(UniversalStr(256), comment='对象当时的名字（快照）')
    action: Mapped[str] = mapped_column(UniversalStr(16), comment='create / update / delete / bulk')
    changes: Mapped[list | None] = mapped_column(sa.JSON(), comment='字段变化（JSON 数组）')
    fields: Mapped[str] = mapped_column(UniversalStr(1024), comment='改了哪些字段（,a,b, 形式，按字段筛选用）')
    actor_id: Mapped[int | None] = mapped_column(sa.BigInteger, index=True, comment='操作人 ID（系统操作为空）')
    actor_name: Mapped[str | None] = mapped_column(UniversalStr(64), comment='操作人用户名（快照）')
    source: Mapped[str] = mapped_column(UniversalStr(16), comment='来源（web / ai / import / oauth2 / task / system）')
    source_ref: Mapped[str | None] = mapped_column(UniversalStr(128), comment='来源的引用（AI 工具调用 ID、任务名…）')
    ip: Mapped[str | None] = mapped_column(UniversalStr(64), comment='IP 地址')
    # index：清理任务按它做范围删除（同操作日志），列表也按它倒序
    created_time: Mapped[datetime] = mapped_column(TimeZone, index=True, comment='创建时间')
