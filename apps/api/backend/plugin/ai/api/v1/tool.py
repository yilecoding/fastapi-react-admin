from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from backend.common.pagination import DependsPagination, PageData, paging_data
from backend.common.response.response_schema import ResponseSchemaModel, response_base
from backend.common.security.jwt import DependsJwtAuth
from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession
from backend.plugin.ai.core.dispatcher import tool_dispatcher
from backend.plugin.ai.crud.crud_tool_invocation import ai_tool_invocation_dao
from backend.plugin.ai.schema.conversation import GetToolDetail, GetToolInvocationDetail

router = APIRouter()


@router.get('', summary='获取我能调用的工具清单', dependencies=[DependsJwtAuth])
async def get_my_tools(request: Request) -> ResponseSchemaModel[list[GetToolDetail]]:
    """返回的是**当前用户**能调用的那些。

    这个接口存在的理由不只是展示：排查"为什么 AI 说它没有这个能力"时，
    第一步就是看这里有没有那个工具——分不清是"没注册"、"域没开"还是"没权限"
    的话，这类问题只能靠猜。
    """
    tools = tool_dispatcher.visible_tools(request.user, await tool_dispatcher.off_plugins())
    data = [
        GetToolDetail(
            name=spec.name,
            description=spec.description,
            domain=spec.domain,
            perm=spec.perm,
            mutating=spec.mutating,
            parameters=spec.parameters,
        )
        for spec in tools
    ]
    return response_base.success(data=data)


@router.get(
    '/logs',
    summary='分页获取 AI 工具调用日志',
    dependencies=[Depends(RequestPermission('ai:log:list')), DependsRBAC, DependsPagination],
)
async def get_tool_logs(
    db: CurrentSession,
    tool_name: Annotated[str | None, Query(description='工具名')] = None,
    status: Annotated[
        int | None, Query(description='状态（0：成功、1：失败、2：无权限、3：待确认、4：已取消）')
    ] = None,
    start_time: Annotated[datetime | None, Query(description='调用时间起')] = None,
    end_time: Annotated[datetime | None, Query(description='调用时间止')] = None,
) -> ResponseSchemaModel[PageData[GetToolInvocationDetail]]:
    select = await ai_tool_invocation_dao.get_select(
        tool_name=tool_name, status=status, start_time=start_time, end_time=end_time
    )
    page_data = await paging_data(db, select)
    return response_base.success(data=page_data)
