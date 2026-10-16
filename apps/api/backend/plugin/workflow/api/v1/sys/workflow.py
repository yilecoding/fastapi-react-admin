"""审批流接口

🔴 审批中心那批（发起 / 待办 / 详情 / 动作）**只挂 `DependsJwtAuth`，不挂权限码**。
avc-bp 踩过：审批中心挂了权限码，普通员工进不去，只好另补一条业务侧的自助撤回通道。
它们读的都是「我参与的」，用户 ID 取自 `request.user.id`；能不能做某个动作由能力信封判定。
另外 `rbac_verify` 对非 GET 请求要求 `is_staff`，挂了 `DependsRBAC` 的话非员工账号
连「同意」都点不了。

定义管理和实例监控是管理端，照常挂权限码 + `DependsRBAC`。
"""

import json

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Query, Request

from backend.common.response.response_schema import ResponseModel, response_base
from backend.common.security.jwt import DependsJwtAuth
from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession, CurrentSessionTransaction
from backend.plugin.workflow.engine.flow import index_nodes
from backend.plugin.workflow.model import WfDefinition, WfDefinitionVersion
from backend.plugin.workflow.schema.workflow import (
    ActionParam,
    CreateDefinitionParam,
    SetDefinitionStatusParam,
    StartParam,
    UpdateDefinitionParam,
)
from backend.plugin.workflow.service import definition_service, query_service, runtime_service
from backend.plugin.workflow.service.runtime_service import Actor

router = APIRouter()

Page = Annotated[int, Query(ge=1, description='页码')]
Size = Annotated[int, Query(ge=1, le=100, description='每页数量')]
Keyword = Annotated[str | None, Query(max_length=64, description='标题 / 摘要关键字')]
Pk = Annotated[int, Path(description='ID')]


def _actor(request: Request) -> Actor:
    return Actor.from_user(request.user)


def _definition_row(d: WfDefinition, *, with_draft: bool = False) -> dict[str, Any]:
    row: dict[str, Any] = {
        'id': d.id,
        'code': d.code,
        'name': d.name,
        'biz_type': d.biz_type,
        'category': d.category,
        'icon': d.icon,
        'description': d.description,
        'status': d.status,
        'current_version_id': d.current_version_id,
        'sort': d.sort,
        'created_time': d.created_time,
        'updated_time': d.updated_time,
    }
    if with_draft:
        row['form'] = json.loads(d.draft_form_json)
        row['model'] = json.loads(d.draft_model_json)
    return row


def _version_row(v: WfDefinitionVersion, *, with_json: bool = False) -> dict[str, Any]:
    row: dict[str, Any] = {
        'id': v.id,
        'version_no': v.version_no,
        'published_by': v.published_by,
        'created_time': v.created_time,
    }
    if with_json:
        row['form'] = json.loads(v.form_json)
        row['model'] = json.loads(v.model_json)
    return row


# ── 审批中心（只要登录）────────────────────────────────────────────────────


@router.get('/startable', summary='可发起的审批', dependencies=[DependsJwtAuth])
async def get_startable(db: CurrentSession) -> ResponseModel:
    rows = await definition_service.startable(db)
    return response_base.success(data=[_definition_row(d) for d in rows])


@router.get('/startable/{code}', summary='发起页：表单与要自选审批人的节点', dependencies=[DependsJwtAuth])
async def get_start_form(db: CurrentSession, code: Annotated[str, Path(max_length=64)]) -> ResponseModel:
    d, v = await runtime_service.published_definition(db, code)
    model = json.loads(v.model_json)
    select_nodes = [
        {'id': r.node['id'], 'name': r.node['name'], 'mode': r.node.get('mode') or 'any'}
        for r in index_nodes(model).values()
        if r.node['type'] == 'approval' and (r.node.get('assignee') or {}).get('kind') == 'select_on_start'
    ]
    return response_base.success(
        data={
            'definition': _definition_row(d),
            'version_id': v.id,
            'form': json.loads(v.form_json),
            'model': model,
            'select_nodes': select_nodes,
            'names': await query_service.model_names(db, model),
        }
    )


@router.post('/instances', summary='发起审批', dependencies=[DependsJwtAuth])
async def start_instance(request: Request, db: CurrentSession, obj: StartParam) -> ResponseModel:
    data = await runtime_service.start_form(
        db, code=obj.code, actor=_actor(request), form_data=obj.form, selected=obj.selected, key=obj.key
    )
    return response_base.success(data=data)


@router.get('/inbox/counts', summary='待办数 / 抄送未读数', dependencies=[DependsJwtAuth])
async def get_counts(request: Request, db: CurrentSession) -> ResponseModel:
    return response_base.success(data=await query_service.counts(db, request.user.id))


@router.get('/inbox/todo', summary='待我审批', dependencies=[DependsJwtAuth])
async def get_todo(
    request: Request, db: CurrentSession, keyword: Keyword = None, page: Page = 1, size: Size = 20
) -> ResponseModel:
    return response_base.success(
        data=await query_service.todo(db, request.user.id, keyword=keyword, page=page, size=size)
    )


@router.get('/inbox/done', summary='我已审批', dependencies=[DependsJwtAuth])
async def get_done(
    request: Request, db: CurrentSession, keyword: Keyword = None, page: Page = 1, size: Size = 20
) -> ResponseModel:
    return response_base.success(
        data=await query_service.done(db, request.user.id, keyword=keyword, page=page, size=size)
    )


@router.get('/inbox/initiated', summary='我发起的', dependencies=[DependsJwtAuth])
async def get_initiated(
    request: Request,
    db: CurrentSession,
    keyword: Keyword = None,
    status: Annotated[str | None, Query(max_length=16)] = None,
    page: Page = 1,
    size: Size = 20,
) -> ResponseModel:
    return response_base.success(
        data=await query_service.initiated(db, request.user.id, keyword=keyword, status=status, page=page, size=size)
    )


@router.get('/inbox/cc', summary='抄送我的', dependencies=[DependsJwtAuth])
async def get_cc(
    request: Request,
    db: CurrentSession,
    keyword: Keyword = None,
    unread: Annotated[bool | None, Query(description='只看未读 / 只看已读')] = None,
    page: Page = 1,
    size: Size = 20,
) -> ResponseModel:
    return response_base.success(
        data=await query_service.cc_me(db, request.user.id, keyword=keyword, unread=unread, page=page, size=size)
    )


@router.get('/instances/{pk}', summary='审批详情', dependencies=[DependsJwtAuth])
async def get_instance(request: Request, db: CurrentSession, pk: Pk) -> ResponseModel:
    return response_base.success(data=await query_service.detail(db, pk, _actor(request)))


@router.post('/instances/{pk}/actions', summary='执行审批动作', dependencies=[DependsJwtAuth])
async def do_action(request: Request, db: CurrentSession, pk: Pk, obj: ActionParam) -> ResponseModel:
    data = await runtime_service.act(
        db,
        instance_id=pk,
        action=obj.action,
        actor=_actor(request),
        key=obj.key,
        opinion=obj.opinion,
        target_user_ids=obj.target_user_ids,
        form_patch=obj.form,
    )
    return response_base.success(data=data)


@router.put('/instances/{pk}/cc-read', summary='抄送标记已读', dependencies=[DependsJwtAuth])
async def mark_cc_read(request: Request, db: CurrentSessionTransaction, pk: Pk) -> ResponseModel:
    await query_service.mark_cc_read(db, pk, request.user.id)
    return response_base.success()


@router.get('/directory/users', summary='通讯录：选人', dependencies=[DependsJwtAuth])
async def get_directory_users(
    db: CurrentSession,
    keyword: Keyword = None,
    ids: Annotated[str | None, Query(max_length=2200, description='逗号分隔的用户 ID（回显已选的人）')] = None,
) -> ResponseModel:
    id_list = [int(x) for x in (ids or '').split(',') if x.strip().isdigit()]
    return response_base.success(data=await query_service.directory_users(db, keyword=keyword, ids=id_list))


@router.get('/directory/depts', summary='通讯录：部门', dependencies=[DependsJwtAuth])
async def get_directory_depts(db: CurrentSession) -> ResponseModel:
    return response_base.success(data=await query_service.directory_depts(db))


@router.get(
    '/directory/roles',
    summary='通讯录：角色（设计器用）',
    dependencies=[Depends(RequestPermission('workflow:definition:list')), DependsRBAC],
)
async def get_directory_roles(db: CurrentSession) -> ResponseModel:
    return response_base.success(data=await query_service.directory_roles(db))


# ── 实例监控（管理端）──────────────────────────────────────────────────────


@router.get(
    '/monitor',
    summary='实例监控',
    dependencies=[Depends(RequestPermission(query_service.PERM_MONITOR)), DependsRBAC],
)
async def get_monitor(
    db: CurrentSession,
    keyword: Keyword = None,
    status: Annotated[str | None, Query(max_length=16)] = None,
    page: Page = 1,
    size: Size = 20,
) -> ResponseModel:
    return response_base.success(
        data=await query_service.monitor(db, keyword=keyword, status=status, page=page, size=size)
    )


# ── 流程定义（管理端）──────────────────────────────────────────────────────


@router.get(
    '/definitions',
    summary='流程定义列表',
    dependencies=[Depends(RequestPermission('workflow:definition:list')), DependsRBAC],
)
async def get_definitions(
    db: CurrentSession,
    name: Annotated[str | None, Query(max_length=64)] = None,
    status: Annotated[str | None, Query(max_length=16)] = None,
) -> ResponseModel:
    rows = await definition_service.list_all(db, name=name, status=status)
    return response_base.success(data=[_definition_row(d) for d in rows])


@router.get(
    '/definitions/{pk}',
    summary='流程定义详情（含草稿）',
    dependencies=[Depends(RequestPermission('workflow:definition:list')), DependsRBAC],
)
async def get_definition(db: CurrentSession, pk: Pk) -> ResponseModel:
    d = await definition_service.get(db, pk)
    return response_base.success(data=_definition_row(d, with_draft=True))


@router.post(
    '/definitions',
    summary='新建流程定义',
    dependencies=[Depends(RequestPermission('workflow:definition:add')), DependsRBAC],
)
async def create_definition(db: CurrentSessionTransaction, obj: CreateDefinitionParam) -> ResponseModel:
    d = await definition_service.create(db, obj)
    return response_base.success(data={'id': d.id})


@router.put(
    '/definitions/{pk}',
    summary='保存流程定义草稿',
    dependencies=[Depends(RequestPermission('workflow:definition:edit')), DependsRBAC],
)
async def update_definition(db: CurrentSessionTransaction, pk: Pk, obj: UpdateDefinitionParam) -> ResponseModel:
    await definition_service.update(db, pk, obj)
    return response_base.success()


@router.delete(
    '/definitions/{pk}',
    summary='删除流程定义',
    dependencies=[Depends(RequestPermission('workflow:definition:del')), DependsRBAC],
)
async def delete_definition(db: CurrentSessionTransaction, pk: Pk) -> ResponseModel:
    await definition_service.delete(db, pk)
    return response_base.success()


@router.post(
    '/definitions/{pk}/validate',
    summary='发布前校验草稿',
    dependencies=[Depends(RequestPermission('workflow:definition:list')), DependsRBAC],
)
async def validate_definition(db: CurrentSession, pk: Pk) -> ResponseModel:
    d = await definition_service.get(db, pk)
    return response_base.success(data={'issues': definition_service.check(d)})


@router.post(
    '/definitions/{pk}/publish',
    summary='发布流程定义',
    dependencies=[Depends(RequestPermission('workflow:definition:publish')), DependsRBAC],
)
async def publish_definition(request: Request, db: CurrentSessionTransaction, pk: Pk) -> ResponseModel:
    v, issues = await definition_service.publish(db, pk, request.user.id)
    # 有 ERROR 不发布，但这是「校验没过」不是「请求出错」—— 照样 200，issues 带回去让设计器高亮节点
    return response_base.success(
        data={'published': v is not None, 'version': _version_row(v) if v else None, 'issues': issues}
    )


@router.put(
    '/definitions/{pk}/status',
    summary='启用 / 停用流程定义',
    dependencies=[Depends(RequestPermission('workflow:definition:publish')), DependsRBAC],
)
async def set_definition_status(db: CurrentSessionTransaction, pk: Pk, obj: SetDefinitionStatusParam) -> ResponseModel:
    await definition_service.set_enabled(db, pk, enabled=obj.enabled)
    return response_base.success()


@router.get(
    '/definitions/{pk}/versions',
    summary='流程定义的版本历史',
    dependencies=[Depends(RequestPermission('workflow:definition:list')), DependsRBAC],
)
async def get_versions(db: CurrentSession, pk: Pk) -> ResponseModel:
    rows = await definition_service.versions(db, pk)
    return response_base.success(data=[_version_row(v) for v in rows])
