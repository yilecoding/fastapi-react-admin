from typing import Annotated
from urllib.parse import urlencode

from fastapi import APIRouter, BackgroundTasks, Depends, Request, Response
from fastapi_oauth20 import FastAPIOAuth20, GoogleOAuth20
from pyrate_limiter import Duration, Rate
from starlette.responses import RedirectResponse

from backend.app.admin.schema.mfa import MfaChallenge
from backend.common.exception import errors
from backend.common.response.response_schema import ResponseSchemaModel, response_base
from backend.core.conf import settings
from backend.database.db import CurrentSessionTransaction
from backend.plugin.oauth2.enums import UserSocialType
from backend.plugin.oauth2.service.oauth2_service import oauth2_service
from backend.plugin.oauth2.state_binding import (
    authorize_redirect,
    authorize_url,
    callback_failed,
    clear_state_cookie,
    require_state_cookie,
)
from backend.plugin.oauth2.utils import google_email_verified
from backend.utils.limiter import RateLimiter

router = APIRouter()

google_client = GoogleOAuth20(settings.OAUTH2_GOOGLE_CLIENT_ID, settings.OAUTH2_GOOGLE_CLIENT_SECRET)


@router.get('', summary='获取 google 授权链接')
async def get_google_oauth2_url() -> ResponseSchemaModel[str]:
    # 返回后端自己的 authorize 入口，cookie 在那一跳上下发（#227，见 state_binding.py）
    return response_base.success(data=authorize_url(settings.OAUTH2_GOOGLE_REDIRECT_URI))


@router.get('/authorize', summary='跳转到授权页（下发 state cookie）')
async def google_oauth2_authorize(request: Request, ticket: str | None = None) -> RedirectResponse:
    return await authorize_redirect(request, google_client, settings.OAUTH2_GOOGLE_REDIRECT_URI, ticket)


@router.get(
    '/callback',
    summary='google 授权自动重定向',
    description='google 授权后，自动重定向到当前地址并获取用户信息，通过用户信息自动创建系统用户',
    # require_state_cookie 必须排在前面：先比对 cookie，对不上就不去第三方换 token（#227）
    dependencies=[Depends(require_state_cookie), Depends(RateLimiter(Rate(5, Duration.MINUTE)))],
)
async def google_oauth2_callback(  # ruff:ignore[missing-return-type-undocumented-public-function]
    db: CurrentSessionTransaction,
    request: Request,
    response: Response,
    background_tasks: BackgroundTasks,
    oauth2: Annotated[
        FastAPIOAuth20,
        Depends(FastAPIOAuth20(google_client, redirect_uri=settings.OAUTH2_GOOGLE_REDIRECT_URI)),
    ],
):
    token_data, state = oauth2
    access_token = token_data['access_token']
    user = await google_client.get_userinfo(access_token)
    try:
        data = await oauth2_service.login_or_binding(
            db=db,
            request=request,
            response=response,
            background_tasks=background_tasks,
            user=user,
            social=UserSocialType.google,
            state=state,
            email_verified=google_email_verified(user),
        )
    except errors.BaseExceptionError as exc:
        return await callback_failed(request, db, exc)

    # 绑定流程
    if data is None:
        redirect = RedirectResponse(url=settings.OAUTH2_FRONTEND_BINDING_REDIRECT_URI)
        clear_state_cookie(redirect, request)
        return redirect

    # 二次验证（#181）：没开会话，把一次性令牌带回登录页接着做第二步。令牌 5 分钟、最多试 5 次、
    # 不配动态码用不了 —— 和 refresh token 不是一个量级，才能进 URL（那个不行，见下）
    if isinstance(data, MfaChallenge):
        query = urlencode({'mfa': data.mfa_token, 'setup': '1' if data.mfa_setup else '0'})
        redirect = RedirectResponse(url=f'{settings.OAUTH2_FRONTEND_LOGIN_REDIRECT_URI}?{query}')
        clear_state_cookie(redirect, request)
        return redirect

    # 登录流程
    # 令牌不进 URL（会进浏览器历史和反代日志）：前端落地页用 refresh cookie 静默恢复会话（#138）
    redirect = RedirectResponse(url=settings.OAUTH2_FRONTEND_LOGIN_REDIRECT_URI)
    # 🔴 refresh cookie 是 service 设在注入的 `response` 上的，而这里**直接返回了另一个 Response** ——
    # FastAPI 只在「返回的不是 Response」时才把注入那份的头合并进去（`fastapi/routing.py`）。
    # 不搬过来，第三方登录的人从来拿不到 refresh cookie：access token 一过期（30 分钟）就被登出
    for cookie in response.headers.getlist('set-cookie'):
        redirect.headers.append('set-cookie', cookie)
    clear_state_cookie(redirect, request)
    return redirect
