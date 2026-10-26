from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from fastapi.security import HTTPBasicCredentials
from pyrate_limiter import Duration, Rate
from starlette.background import BackgroundTasks

from backend.app.admin.schema.token import GetLoginToken, GetNewToken, GetSwaggerToken
from backend.app.admin.schema.user import AuthLoginParam, AuthPhoneCaptchaParam, AuthPhoneLoginParam
from backend.app.admin.service.auth_service import auth_service
from backend.common.response.response_schema import ResponseModel, ResponseSchemaModel, response_base
from backend.common.security.jwt import DependsJwtAuth
from backend.core.conf import settings
from backend.database.db import CurrentSession, CurrentSessionTransaction
from backend.utils.limiter import RateLimiter

router = APIRouter()


# 🔴 **swagger 调试口只在非 prod 注册。**
#
# 它和 /auth/login 的差距不是「少了个验证码」那么简单，四条叠在一起是一条完整的
# 静默持久化通道：
#   - 无验证码、（原来）无限流
#   - **不写登录日志** —— 成功失败都不写，事后查不到
#   - 这类会话的端是 `SessionClient.swagger`，monitor/online.py 把它们
#     **排除出「在线用户」列表** —— 管理员既看不见，也无法强制下线
#   - 收 HTTP Basic / query param，凭据会进 nginx access log 和浏览器历史
#
# prod 下 `check_env()` 已经把 FASTAPI_OPENAPI_URL 置 None，Swagger UI 本就打不开，
# 这个口在 prod 没有任何存在意义。
#
# 用「不注册」而不是「handler 里返回 403」：路由不存在 → 依赖不解析 → 攻击面为零，
# 且 404 与「这个 API 不存在」一致，不确认功能存在。
if settings.ENVIRONMENT != 'prod':

    @router.post(
        '/login/swagger',
        summary='swagger 调试专用',
        description='用于快捷获取 token 进行 swagger 认证（仅非生产环境注册）',
        dependencies=[Depends(RateLimiter(Rate(5, Duration.MINUTE)))],
    )
    async def login_swagger(
        db: CurrentSessionTransaction, obj: Annotated[HTTPBasicCredentials, Depends()]
    ) -> GetSwaggerToken:
        token, user = await auth_service.swagger_login(db=db, obj=obj)
        return GetSwaggerToken(access_token=token, user=user)  # type: ignore


@router.post(
    '/login',
    summary='用户登录',
    description='json 格式登录, 仅支持在第三方api工具调试, 例如: postman',
    dependencies=[Depends(RateLimiter(Rate(5, Duration.MINUTE)))],
)
async def login(
    db: CurrentSessionTransaction,
    request: Request,
    response: Response,
    obj: AuthLoginParam,
    background_tasks: BackgroundTasks,
) -> ResponseSchemaModel[GetLoginToken]:
    data = await auth_service.login(
        db=db, request=request, response=response, obj=obj, background_tasks=background_tasks
    )
    return response_base.success(data=data)


@router.post(
    '/phone/captcha',
    summary='手机验证码登录：发送验证码',
    description='图形验证码开着时要带 uuid + captcha。没注册 / 没验证过的号也返回成功（不真发）—— 防号码枚举',
    dependencies=[Depends(RateLimiter(Rate(5, Duration.MINUTE)))],
)
async def send_phone_login_captcha(db: CurrentSession, obj: AuthPhoneCaptchaParam) -> ResponseModel:
    await auth_service.send_phone_captcha(db=db, obj=obj)
    return response_base.success()


@router.post(
    '/phone/login',
    summary='手机验证码登录',
    dependencies=[Depends(RateLimiter(Rate(5, Duration.MINUTE)))],
)
async def phone_login(
    db: CurrentSessionTransaction,
    request: Request,
    response: Response,
    obj: AuthPhoneLoginParam,
    background_tasks: BackgroundTasks,
) -> ResponseSchemaModel[GetLoginToken]:
    data = await auth_service.phone_login(
        db=db, request=request, response=response, obj=obj, background_tasks=background_tasks
    )
    return response_base.success(data=data)


@router.get('/codes', summary='获取所有授权码', description='适配 vben admin v5', dependencies=[DependsJwtAuth])
async def get_codes(db: CurrentSession, request: Request) -> ResponseSchemaModel[list[str]]:
    codes = await auth_service.get_codes(db=db, request=request)
    return response_base.success(data=codes)


@router.post('/refresh', summary='刷新 token')
async def refresh_token(db: CurrentSession, request: Request, response: Response) -> ResponseSchemaModel[GetNewToken]:
    data = await auth_service.refresh_token(db=db, request=request, response=response)
    return response_base.success(data=data)


@router.post('/heartbeat', summary='会话心跳', dependencies=[DependsJwtAuth])
async def heartbeat() -> ResponseModel:
    """
    什么都不做：续活跃这件事在 JWT 中间件里已经做完了（`session_store.check`，按 `X-Client-Idle`）。

    给「一直在看页面、但不发请求」的人用。空闲只看记录下来的最后活跃（#138），
    没有这一下的话，读一份长文档读了两小时的人，下一次点击会被当成空闲踢出去。
    前端只在用户最近有操作时才发（`auth/activity.ts`）
    """
    return response_base.success()


@router.post('/logout', summary='用户登出')
async def logout(request: Request, response: Response) -> ResponseModel:
    await auth_service.logout(request=request, response=response)
    return response_base.success()
