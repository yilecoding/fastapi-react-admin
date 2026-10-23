from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, File, Path, Query, Request, UploadFile
from fastapi.responses import Response
from sqlalchemy import ColumnElement

from backend.app.admin.dataio import DEPT_EXPORT, DEPT_IMPORT
from backend.app.admin.model import Dept
from backend.app.admin.schema.data_import import (
    ImportCommitDetail,
    ImportCommitParam,
    ImportModeParam,
    ImportPreviewDetail,
)
from backend.app.admin.schema.dept import CreateDeptParam, GetDeptDetail, GetDeptTree, UpdateDeptParam
from backend.app.admin.schema.export_job import GetExportJobDetail, StartExportParam
from backend.app.admin.service.dept_service import dept_service
from backend.app.admin.service.export_service import export_service
from backend.app.admin.service.import_service import import_service
from backend.common.response.response_schema import ResponseModel, ResponseSchemaModel, response_base
from backend.common.security.permission import DataPermissionFilter, RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession, CurrentSessionTransaction
from backend.utils.excel_ops import read_table_upload, xlsx_attachment

router = APIRouter()


@router.get(
    '/import/template',
    summary='下载部门导入模板',
    dependencies=[Depends(RequestPermission('sys:dept:import')), DependsRBAC],
)
async def download_dept_import_template(db: CurrentSession) -> Response:
    raw, name = await import_service.template(db=db, spec=DEPT_IMPORT)
    return xlsx_attachment(raw, name)


@router.post(
    '/import/preview',
    summary='预览部门导入',
    dependencies=[Depends(RequestPermission('sys:dept:import')), DependsRBAC],
)
async def preview_dept_import(
    request: Request,
    db: CurrentSession,
    file: Annotated[UploadFile, File(description='xlsx 文件')],
    mode: Annotated[
        ImportModeParam, Query(description='导入模式（create：只新增、upsert：新增并更新、update：只更新）')
    ] = 'create',
) -> ResponseSchemaModel[ImportPreviewDetail]:
    raw = await read_table_upload(file)
    data = await import_service.preview(db=db, spec=DEPT_IMPORT, raw=raw, user=request.user, mode=mode)
    return response_base.success(data=data)


@router.post(
    '/import/commit',
    summary='提交部门导入',
    dependencies=[Depends(RequestPermission('sys:dept:import')), DependsRBAC],
)
async def commit_dept_import(
    request: Request, db: CurrentSession, background_tasks: BackgroundTasks, obj: ImportCommitParam
) -> ResponseSchemaModel[ImportCommitDetail]:
    # 不用 `CurrentSessionTransaction`：「全部成功才提交」要能整批回滚，事务由 service 自己收
    data = await import_service.commit(
        db=db, spec=DEPT_IMPORT, user=request.user, obj=obj, background_tasks=background_tasks
    )
    return response_base.success(data=data)


@router.post(
    '/export',
    summary='导出部门',
    dependencies=[Depends(RequestPermission('sys:dept:export')), DependsRBAC],
)
async def export_depts(
    request: Request, db: CurrentSession, obj: StartExportParam
) -> ResponseSchemaModel[GetExportJobDetail]:
    # 小批量当场生成完才返回（status=2，前端直接下载）；大批量返回排队（status=0），生成完发站内消息
    data = await export_service.start(db=db, request=request, spec=DEPT_EXPORT, obj=obj)
    return response_base.success(data=data)


@router.get(
    '/{pk}',
    summary='获取部门详情',
    dependencies=[
        Depends(RequestPermission('sys:dept:list')),
        DependsRBAC,
    ],
)
async def get_dept(
    db: CurrentSession, pk: Annotated[int, Path(description='部门 ID')]
) -> ResponseSchemaModel[GetDeptDetail]:
    data = await dept_service.get(db=db, pk=pk)
    return response_base.success(data=data)


@router.get(
    '',
    summary='获取部门树',
    dependencies=[
        Depends(RequestPermission('sys:dept:list')),
        DependsRBAC,
    ],
)
async def get_dept_tree(
    db: CurrentSession,
    data_filter: Annotated[ColumnElement[bool], Depends(DataPermissionFilter(Dept))],
    name: Annotated[str | None, Query(description='部门名称')] = None,
    code: Annotated[str | None, Query(description='部门编码')] = None,
    phone: Annotated[str | None, Query(description='联系电话')] = None,
    status: Annotated[int | None, Query(description='状态')] = None,
) -> ResponseSchemaModel[list[GetDeptTree]]:
    dept = await dept_service.get_tree(db=db, data_filter=data_filter, name=name, code=code, phone=phone, status=status)
    return response_base.success(data=dept)


@router.post(
    '',
    summary='创建部门',
    dependencies=[
        Depends(RequestPermission('sys:dept:add')),
        DependsRBAC,
    ],
)
async def create_dept(db: CurrentSessionTransaction, obj: CreateDeptParam) -> ResponseModel:
    await dept_service.create(db=db, obj=obj)
    return response_base.success()


@router.put(
    '/{pk}',
    summary='更新部门',
    dependencies=[
        Depends(RequestPermission('sys:dept:edit')),
        DependsRBAC,
    ],
)
async def update_dept(
    db: CurrentSessionTransaction,
    background_tasks: BackgroundTasks,
    pk: Annotated[int, Path(description='部门 ID')],
    obj: UpdateDeptParam,
) -> ResponseModel:
    count = await dept_service.update(db=db, background_tasks=background_tasks, pk=pk, obj=obj)
    if count > 0:
        return response_base.success()
    return response_base.fail()


@router.delete(
    '/{pk}',
    summary='删除部门',
    dependencies=[
        Depends(RequestPermission('sys:dept:del')),
        DependsRBAC,
    ],
)
async def delete_dept(db: CurrentSessionTransaction, pk: Annotated[int, Path(description='部门 ID')]) -> ResponseModel:
    count = await dept_service.delete(db=db, pk=pk)
    if count > 0:
        return response_base.success()
    return response_base.fail()
