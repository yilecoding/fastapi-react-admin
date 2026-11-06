"""把 OAuth2 的 state 绑到发起授权的那个浏览器上（#227 后半：login CSRF）

原来 state 只是 Redis 里的一个裸 UUID，回调只校验「存在且没用过」。攻击者自己走一遍授权、
拿到自己的 `code` + `state`，把回调地址发给受害者 —— 受害者就被登录成**攻击者的账号**，
之后上传的文件、填的数据全落进攻击者手里。

修法是标准的「state 同时放进一个 cookie，回调时比对」。难点在 cookie 由谁下发：

- 授权链接原来是前端 **XHR** 拿的，开发环境前端 `localhost:8888` 跨站直连 `127.0.0.1:8088`，
  跨站 XHR 响应里的 `SameSite=Lax` cookie 浏览器不保证收（没实测；桌面端 `app://local` 下 refresh cookie
  走不通是实测过的同类问题，见 `packages/platform/src/api-client/client.ts`）—— 万一下发不到，
  回调必然对不上，所有人第三方登录失效
- 所以 cookie 改在一次**顶层跳转**上下发：`GET /oauth2/{github,google}/authorize`
  设 cookie 后 302 到第三方。顶层导航的响应可以设 Lax cookie，同站跨站都一样；
  回调是第三方 → 后端的顶层跳转，Lax cookie 会带上

接口形状不变：`GET /oauth2/github`、`GET /oauth2/me/binding` 照旧返回一个字符串 URL，
前端照旧 `location.href = url`，只是 URL 从「第三方授权页」换成了「后端的 authorize 入口」。
authorize 的地址由回调地址推出来（把末尾的 `/callback` 换成 `/authorize`）——
**cookie 设在哪个 host 上，回调就必须打到哪个 host**，同源推导是唯一不会对不上的办法。

⚠️ 绑定流程留了一个口子：绑定 state 带着 user_id、只能由已登录的人 XHR 取，
authorize 时没有登录态可以核对（顶层跳转带不了 Bearer 头）。所以绑定链接是**一次性**的
（第一个打开它的浏览器认领，之后再打开就失效），但攻击者若把自己**刚取到、还没打开**的绑定链接
在 3 分钟内骗受害者点开并完成第三方授权，受害者的第三方账号会绑到攻击者名下。
比修之前（回调地址任意转发都生效）窄得多，要彻底堵需要绑定入口能核对登录态，见 AGENTS.md。
"""

import json
import uuid

from urllib.parse import urlencode

from fastapi import Request, Response
from fastapi_oauth20.oauth20 import OAuth20Base
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import RedirectResponse

from backend.common.exception import errors
from backend.common.i18n import t
from backend.core.conf import settings
from backend.database.redis import redis_client
from backend.plugin.oauth2.enums import UserSocialAuthType

STATE_COOKIE_KEY = 'fba_oauth2_state'
STATE_COOKIE_PATH = f'{settings.FASTAPI_API_V1_PATH}/oauth2'


def _state_key(state: str) -> str:
    return f'{settings.OAUTH2_STATE_REDIS_PREFIX}:{state}'


def _claimed_key(state: str) -> str:
    return f'{settings.OAUTH2_STATE_REDIS_PREFIX}:claimed:{state}'


def _cookie_secure(request: Request) -> bool:
    if settings.COOKIE_SECURE is not None:
        return settings.COOKIE_SECURE
    return request.url.scheme == 'https'


def authorize_url(redirect_uri: str, ticket: str | None = None) -> str:
    """回调地址 → 同一个 host 上的 authorize 入口"""
    base = redirect_uri.removesuffix('/').removesuffix('/callback')
    return f'{base}/authorize' + (f'?ticket={ticket}' if ticket else '')


async def issue_state(payload: dict) -> str:
    state = str(uuid.uuid4())
    await redis_client.set(_state_key(state), json.dumps(payload), ex=settings.OAUTH2_STATE_EXPIRE_SECONDS)
    return state


async def resolve_authorize_state(ticket: str | None) -> str:
    """authorize 入口要用的 state

    - 没有 ticket：登录。现场签一个 login state
    - 有 ticket：绑定。ticket 就是 `GET /me/binding` 签好的那个 state，**只能认领一次**
    """
    if not ticket:
        return await issue_state({'type': UserSocialAuthType.login.value})
    if not await redis_client.get(_state_key(ticket)):
        raise errors.ForbiddenError(msg=t('error.oauth2.state_invalid_or_missing'))
    claimed = await redis_client.set(_claimed_key(ticket), '1', nx=True, ex=settings.OAUTH2_STATE_EXPIRE_SECONDS)
    if not claimed:
        raise errors.ForbiddenError(msg=t('error.oauth2.state_already_claimed'))
    return ticket


def set_state_cookie(response: Response, request: Request, state: str) -> None:
    response.set_cookie(
        key=STATE_COOKIE_KEY,
        value=state,
        max_age=settings.OAUTH2_STATE_EXPIRE_SECONDS,
        path=STATE_COOKIE_PATH,
        secure=_cookie_secure(request),
        httponly=True,
        samesite='lax',
    )


def clear_state_cookie(response: Response, request: Request) -> None:
    response.delete_cookie(
        key=STATE_COOKIE_KEY,
        path=STATE_COOKIE_PATH,
        secure=_cookie_secure(request),
        httponly=True,
        samesite='lax',
    )


def require_state_cookie(request: Request) -> None:
    """回调的前置依赖：URL 里的 state 必须等于这个浏览器在 authorize 时拿到的 cookie

    放在 `dependencies=[...]` 里，先于拿 code 换 token 的那个依赖执行 ——
    对不上就不去第三方换 token，也不碰 Redis 里的 state（别人的 state 不能被这次请求消耗掉）
    """
    state = request.query_params.get('state')
    cookie = request.cookies.get(STATE_COOKIE_KEY)
    if not state or not cookie or state != cookie:
        raise errors.ForbiddenError(msg=t('error.oauth2.state_not_bound'))


async def callback_failed(request: Request, db: AsyncSession, exc: errors.BaseExceptionError) -> RedirectResponse:
    """回调里业务层拒绝了这次登录 / 绑定：带着原因回前端落地页，而不是抛出去

    回调是「第三方 → 后端」的顶层跳转，抛出去 = 浏览器停在 API 域名上一页裸 JSON，回不到前端。
    #226 之后陌生账号默认不自动建号，这条从边角路径变成了每个新用户第一次社交登录的必经之路。

    🔴 必须先 rollback：处理函数跑在依赖的 exit stack **里面**，这里把异常吞掉，`CurrentSessionTransaction`
    看到的就是正常返回、照样 commit —— 抛错之前写了一半的东西会被提交
    """
    await db.rollback()
    query = urlencode({'error': exc.msg or ''})
    redirect = RedirectResponse(url=f'{settings.OAUTH2_FRONTEND_LOGIN_REDIRECT_URI}?{query}')
    clear_state_cookie(redirect, request)
    return redirect


async def authorize_redirect(
    request: Request, client: OAuth20Base, redirect_uri: str, ticket: str | None
) -> RedirectResponse:
    """authorize 入口：定 state → 下发 cookie → 302 到第三方授权页"""
    state = await resolve_authorize_state(ticket)
    provider_url = await client.get_authorization_url(redirect_uri=redirect_uri, state=state)
    redirect = RedirectResponse(url=provider_url)
    set_state_cookie(redirect, request, state)
    return redirect
