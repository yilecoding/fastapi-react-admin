"""审批流接口

🔴 审批中心那批（发起 / 待办 / 详情 / 动作）**只挂 `DependsJwtAuth`，不挂权限码**。
avc-bp 踩过：审批中心挂了权限码，普通员工进不去，只好另补一条业务侧的自助撤回通道。
它们读的都是「我参与的」，用户 ID 取自 `request.user.id`；能不能做某个动作由能力信封判定。
另外 `rbac_verify` 对非 GET 请求要求 `is_staff`，挂了 `DependsRBAC` 的话非员工账号
连「同意」都点不了。

定义管理和实例监控是管理端，照常挂权限码 + `DependsRBAC`。
"""

import json

from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Path, Query, Request, UploadFile

from backend.app.admin.service.file_service import file_service
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.response.response_schema import ResponseModel, response_base
from backend.common.security.jwt import DependsJwtAuth
from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession, CurrentSessionTransaction
from backend.plugin.workflow.engine.flow import index_nodes
from backend.plugin.workflow.engine.form import form_rules, is_bigint_id
from backend.plugin.workflow.engine.simulate import simulate
from backend.plugin.workflow.enums import FORM_BIZ_TYPE
from backend.plugin.workflow.model import WfDefinition, WfDefinitionVersion
from backend.plugin.workflow.schema.workflow import (
    ActionParam,
    CreateDefinitionParam,
    DraftParam,
    HandoverParam,
    PreviewParam,
    SetDefinitionStatusParam,
    StartParam,
    UpdateDefinitionParam,
)
from backend.plugin.workflow.service import ai_review_service, definition_service, query_service, runtime_service
from backend.plugin.workflow.service.runtime_service import Actor

router = APIRouter()

Page = Annotated[int, Query(ge=1, description='页码')]
Size = Annotated[int, Query(ge=1, le=100, description='每页数量')]
Keyword = Annotated[str | None, Query(max_length=64, description='标题 / 摘要关键字')]
Pk = Annotated[int, Path(description='ID')]


def _actor(request: Request) -> Actor:
    return Actor.from_user(request.user)


def _form_only(d: WfDefinition) -> None:
    """发起页 / 预告只给表单审批：业务审批从业务页面发起。不拦的话，任何登录用户都能对一个业务流程试算，
    借此拿到角色成员名单和各部门负责人（独立审查发现）"""
    if d.biz_type != FORM_BIZ_TYPE:
        raise errors.NotFoundError(msg=t('error.workflow.definition_not_startable'))


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
    _form_only(d)
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


@router.post('/startable/{code}/preview', summary='发起页：按当前表单试算审批流程', dependencies=[DependsJwtAuth])
async def preview_start(
    request: Request, db: CurrentSession, code: Annotated[str, Path(max_length=64)], obj: PreviewParam
) -> ResponseModel:
    d, v = await runtime_service.published_definition(db, code)
    _form_only(d)
    model = json.loads(v.model_json)
    actor = _actor(request)
    # 联动先算一遍：条件分支常按「请假天数」走，而天数是从日期区间算出来的
    form_data, _ = form_rules(json.loads(v.form_json), obj.form)
    steps = await simulate(
        db,
        model,
        form_data=form_data,
        initiator_id=actor.id,
        initiator_dept_id=actor.dept_id,
        selected=obj.selected,
        start_from=index_nodes(model)[model['root']['id']].after,
    )
    return response_base.success(data={'steps': steps})


@router.post('/files', summary='上传审批附件', dependencies=[DependsJwtAuth])
async def upload_attachment(
    request: Request, db: CurrentSessionTransaction, file: Annotated[UploadFile, File(description='文件')]
) -> ResponseModel:
    """审批里的附件上传。

    `/sys/files/upload` 挂着 `sys:file:upload`，而且 RBAC 拒绝非员工账号的 POST ——
    普通员工在审批里传不了附件。这里只要登录，复用同一套文件服务（同样的类型 / 大小 /
    路径穿越校验、私有存储）。挂到单子上时服务端再核一次「是不是你自己传的」
    （`runtime_service._check_attachments`）。
    """
    f = await file_service.upload(db=db, file=file, user_id=request.user.id)
    return response_base.success(
        data={'id': f.id, 'name': f.original_name, 'size': f.size, 'ext': f.ext, 'content_type': f.content_type}
    )


@router.post('/instances', summary='发起审批', dependencies=[DependsJwtAuth])
async def start_instance(request: Request, db: CurrentSession, obj: StartParam) -> ResponseModel:
    data = await runtime_service.start_form(
        db,
        code=obj.code,
        actor=_actor(request),
        form_data=obj.form,
        selected=obj.selected,
        key=obj.key,
        urgent=obj.urgent,
        keep_draft=obj.keep_draft,
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
        target_node_id=obj.target_node_id,
        task_id=obj.task_id,
        resume=obj.resume,
        sign_mode=obj.sign_mode,
        selected=obj.selected,
    )
    return response_base.success(data=data)


@router.get('/instances/{pk}/ai-review', summary='AI 预审结果', dependencies=[DependsJwtAuth])
async def get_ai_review(request: Request, db: CurrentSession, pk: Pk) -> ResponseModel:
    # 单开一个接口而不是塞进详情：预审中要轮询，不该每 3 秒重取整张单（含预告试算）
    return response_base.success(data=await ai_review_service.get_for(db, pk, _actor(request)))


@router.post('/instances/{pk}/ai-review/retry', summary='重试 AI 预审', dependencies=[DependsJwtAuth])
async def retry_ai_review(request: Request, db: CurrentSession, pk: Pk) -> ResponseModel:
    await ai_review_service.retry(db, pk, _actor(request))
    return response_base.success()


@router.put('/instances/{pk}/read', summary='办理人已读', dependencies=[DependsJwtAuth])
async def mark_task_read(request: Request, db: CurrentSessionTransaction, pk: Pk) -> ResponseModel:
    await query_service.mark_task_read(db, pk, request.user.id)
    return response_base.success()


# ── 发起草稿（只读写自己的，用户 ID 取自 request.user）────────────────────────

Code = Annotated[str, Path(max_length=64, description='流程定义编码')]


@router.get('/drafts', summary='我的发起草稿', dependencies=[DependsJwtAuth])
async def get_drafts(request: Request, db: CurrentSession) -> ResponseModel:
    return response_base.success(data=await query_service.drafts(db, request.user.id))


@router.get('/drafts/{code}', summary='取一份发起草稿', dependencies=[DependsJwtAuth])
async def get_draft(request: Request, db: CurrentSession, code: Code) -> ResponseModel:
    return response_base.success(data=await query_service.get_draft(db, request.user.id, code))


@router.put('/drafts/{code}', summary='存发起草稿', dependencies=[DependsJwtAuth])
async def put_draft(request: Request, db: CurrentSessionTransaction, code: Code, obj: DraftParam) -> ResponseModel:
    await query_service.save_draft(db, request.user.id, code, obj.form)
    return response_base.success()


@router.delete('/drafts/{code}', summary='丢弃发起草稿', dependencies=[DependsJwtAuth])
async def delete_draft(request: Request, db: CurrentSessionTransaction, code: Code) -> ResponseModel:
    await query_service.delete_draft(db, request.user.id, code)
    return response_base.success()


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
    if ids is not None:
        # 传了 ids 就只按 ids 回查：全部不合法时返回空，而不是退化成「不筛」把前 20 个人都给出去
        id_list = [int(x) for x in ids.split(',') if is_bigint_id(x.strip())]
        if not id_list:
            return response_base.success(data=[])
        return response_base.success(data=await query_service.directory_users(db, keyword=None, ids=id_list))
    return response_base.success(data=await query_service.directory_users(db, keyword=keyword, ids=None))


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
    definition_id: Annotated[int | None, Query(description='流程定义 ID')] = None,
    initiator: Annotated[str | None, Query(max_length=64, description='发起人姓名 / 用户名')] = None,
    start_time: Annotated[datetime | None, Query(description='发起时间起')] = None,
    end_time: Annotated[datetime | None, Query(description='发起时间止')] = None,
    page: Page = 1,
    size: Size = 20,
) -> ResponseModel:
    return response_base.success(
        data=await query_service.monitor(
            db,
            keyword=keyword,
            status=status,
            definition_id=definition_id,
            initiator=initiator,
            start_time=start_time,
            end_time=end_time,
            page=page,
            size=size,
        )
    )


@router.get(
    '/handover',
    summary='离职交接：手上有在办待办的人（含已停用的账号）',
    dependencies=[Depends(RequestPermission('workflow:instance:reassign')), DependsRBAC],
)
async def get_handover(db: CurrentSession) -> ResponseModel:
    return response_base.success(data=await runtime_service.handover_holders(db))


@router.post(
    '/handover',
    summary='离职交接：把一个人手上所有在办的待办交给另一个人',
    dependencies=[Depends(RequestPermission('workflow:instance:reassign')), DependsRBAC],
)
async def do_handover(request: Request, db: CurrentSession, obj: HandoverParam) -> ResponseModel:
    data = await runtime_service.handover(
        db, from_user_id=obj.from_user_id, to_user_id=obj.to_user_id, actor=_actor(request), key=obj.key
    )
    return response_base.success(data=data)


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
    nos = await definition_service.version_numbers(db, [d.current_version_id for d in rows if d.current_version_id])
    return response_base.success(
        data=[{**_definition_row(d), 'version_no': nos.get(d.current_version_id)} for d in rows]
    )


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
    v, issues, created = await definition_service.publish(db, pk, request.user.id)
    # 有 ERROR 不发布，但这是「校验没过」不是「请求出错」—— 照样 200，issues 带回去让设计器高亮节点
    return response_base.success(
        data={
            'published': v is not None,
            # False = 草稿和当前版本一样，没有出新版本
            'new_version': created,
            'version': _version_row(v) if v else None,
            'issues': issues,
        }
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
