import sqlalchemy as sa

from sqlalchemy.orm import Mapped, mapped_column

from backend.common.model import Base, UniversalStr, id_key


class Dept(Base):
    """部门表"""

    __tablename__ = 'sys_dept'
    # 唯一性建在 `code` 上而不是 `name` 上：
    #
    # 原来是 (name, deleted) 全局唯一，于是整棵树里只能有一个「测试组」——
    # 而「技术中心/测试组」和「质量中心/测试组」在真实组织里是常态。
    # 名字的同级唯一性挪到服务层（dept_service.create/update）做，**不建库约束**：
    # parent_id 可空，而各方言对「唯一索引里的 NULL」语义相反
    # （SQL Server 认为多个 NULL 相等、MySQL/PG 认为互不相等），
    # 建了会得到一条只在某一种库上生效的约束 —— 那比没有更难查。
    __table_args__ = (
        sa.UniqueConstraint('code', 'deleted', name='uk_sys_dept_code_deleted'),
        {'comment': '部门表'},
    )

    id: Mapped[id_key] = mapped_column(init=False)
    code: Mapped[str] = mapped_column(UniversalStr(32), comment='部门编码')
    name: Mapped[str] = mapped_column(UniversalStr(64), comment='部门名称')
    sort: Mapped[int] = mapped_column(default=0, comment='排序')
    leader: Mapped[str | None] = mapped_column(UniversalStr(32), default=None, comment='负责人')
    phone: Mapped[str | None] = mapped_column(UniversalStr(11), default=None, comment='手机')
    email: Mapped[str | None] = mapped_column(UniversalStr(64), default=None, comment='邮箱')
    status: Mapped[int] = mapped_column(default=1, comment='部门状态(0停用 1正常)')

    # 父级部门
    parent_id: Mapped[int | None] = mapped_column(sa.BigInteger, default=None, index=True, comment='父部门ID')
