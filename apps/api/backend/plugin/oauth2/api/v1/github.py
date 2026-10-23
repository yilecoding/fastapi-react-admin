import json
import uuid

from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, Request, Response
from fastapi_oauth20 import FastAPIOAuth20, GitHubOAuth20
from pyrate_limiter import Duration, Rate
from starlette.responses import RedirectResponse

from backend.common.response.response_schema import ResponseSchemaModel, response_base
from backend.core.conf import settings
from backend.database.db import CurrentSessionTransaction
from backend.database.redis import redis_client
from backend.plugin.oauth2.enums import UserSocialAuthType, UserSocialType
from backend.plugin.oauth2.service.oauth2_service import oauth2_service
from backend.utils.limiter import RateLimiter

router = APIRouter()

github_client = GitHubOAuth20(settings.OAUTH2_GITHUB_CLIENT_ID, settings.OAUTH2_GITHUB_CLIENT_SECRET)


@router.get('', summary='获取 Github 授权链接')
async def get_github_oauth2_url() -> ResponseSchemaModel[str]:
    state = str(uuid.uuid4())

    await redis_client.set(
        f'{settings.OAUTH2_STATE_REDIS_PREFIX}:{state}',
        json.dumps({'type': UserSocialAuthType.login.value}),
        ex=settings.OAUTH2_STATE_EXPIRE_SECONDS,
    )

    auth_url = await github_client.get_authorization_url(redirect_uri=settings.OAUTH2_GITHUB_REDIRECT_URI, state=state)
    return response_base.success(data=auth_url)


@router.get(
    '/callback',
    summary='Github 授权自动重定向',
    description='Github 授权后，自动重定向到当前地址并获取用户信息，通过用户信息自动创建系统用户',
    dependencies=[Depends(RateLimiter(Rate(5, Duration.MINUTE)))],
)
async def github_oauth2_callback(  # ruff:ignore[missing-return-type-undocumented-public-function]
    db: CurrentSessionTransaction,
    request: Request,
    response: Response,
    background_tasks: BackgroundTasks,
    oauth2: Annotated[
        FastAPIOAuth20,
        Depends(FastAPIOAuth20(github_client, redirect_uri=settings.OAUTH2_GITHUB_REDIRECT_URI)),
    ],
):
    token_data, state = oauth2
    access_token = token_data['access_token']
    user = await github_client.get_userinfo(access_token)
    data = await oauth2_service.login_or_binding(
        db=db,
        request=request,
        response=response,
        background_tasks=background_tasks,
        user=user,
        social=UserSocialType.github,
        state=state,
    )

    # 绑定流程
    if data is None:
        return RedirectResponse(url=settings.OAUTH2_FRONTEND_BINDING_REDIRECT_URI)

    # 登录流程
    # 令牌不进 URL（会进浏览器历史和反代日志）：前端落地页用 refresh cookie 静默恢复会话（#138）
    redirect = RedirectResponse(url=settings.OAUTH2_FRONTEND_LOGIN_REDIRECT_URI)
    # 🔴 refresh cookie 是 service 设在注入的 `response` 上的，而这里**直接返回了另一个 Response** ——
    # FastAPI 只在「返回的不是 Response」时才把注入那份的头合并进去（`fastapi/routing.py`）。
    # 不搬过来，第三方登录的人从来拿不到 refresh cookie：access token 一过期（30 分钟）就被登出
    for cookie in response.headers.getlist('set-cookie'):
        redirect.headers.append('set-cookie', cookie)
    return redirect
