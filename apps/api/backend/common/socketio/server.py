import urllib.parse
import uuid

import socketio

from starlette_context import request_cycle_context

from backend.common.log import log
from backend.common.security.jwt import jwt_authentication, jwt_decode
from backend.core.conf import settings
from backend.database.redis import redis_client

# 创建 Socket.IO 服务器实例
sio = socketio.AsyncServer(
    client_manager=socketio.AsyncRedisManager(
        f'redis://:{urllib.parse.quote(settings.REDIS_PASSWORD)}@{settings.REDIS_HOST}:{settings.REDIS_PORT}/{settings.REDIS_DATABASE}',
        redis_options={
            'socket_timeout': None,
            'socket_connect_timeout': settings.REDIS_TIMEOUT,
        },
    ),
    async_mode='asgi',
    cors_allowed_origins=settings.CORS_ALLOWED_ORIGINS,
    cors_credentials=True,
    namespaces=['/ws'],
)


def user_room(user_id: int) -> str:
    """某个用户的专属房间名（同一个人多端登录会有多个 sid，全在这个房间里）"""
    return f'user:{user_id}'


@sio.event
async def connect(sid, environ, auth) -> bool:
    """Socket 连接事件"""
    if not auth:
        log.error('WebSocket 连接失败：无授权')
        return False

    token = auth.get('token')
    if not token:
        log.error('WebSocket 连接失败：授权失败，请检查')
        return False

    # 免授权直连
    if token == settings.WS_NO_AUTH_MARKER:
        session_uuid = auth.get('session_uuid')
        if not session_uuid:
            log.error('WebSocket 连接失败：免授权直连要带 session_uuid')
            return False
        if settings.ENVIRONMENT == 'prod':
            log.error('WebSocket 连接失败：生产环境禁止免授权直连')
            return False
        await redis_client.set(f'{settings.TOKEN_ONLINE_REDIS_PREFIX}:sid:{sid}', session_uuid)
        await redis_client.sadd(f'{settings.TOKEN_ONLINE_REDIS_PREFIX}:session:{session_uuid}', sid)
        await redis_client.sadd(settings.TOKEN_ONLINE_REDIS_PREFIX, session_uuid)
        return True

    try:
        with request_cycle_context({settings.TRACE_ID_REQUEST_HEADER_KEY: uuid.uuid4().hex}):
            # 握手不算「用户在操作」：页面挂着自动重连不该把一个空闲的会话续上
            user = await jwt_authentication(token, touch=False)
    except Exception as e:
        log.info(f'WebSocket 连接失败：{e!s}')
        return False

    # 🔴 会话 ID 从令牌里取，不信前端报上来的 `auth.session_uuid`（#138）。
    # 原来用的是前端那一份：刷新之后前端存的还是旧 ID（那时每次刷新都换 ID），
    # 于是在线用户页把**正连着的**会话显示成离线；而且任何人报一个别人的会话 ID 就能把它标成在线
    session_uuid = jwt_decode(token).session_uuid

    # 定向推送的落点。没有房间的话 `sio.emit()` 只能广播给所有连接 ——
    # 「只发给某个人」这件事在传输层就没有地方可落，会被迫在业务层
    # 把内容广播出去再让前端自己过滤（等于把权限判断交给客户端）。
    # 广播型通知（公告）不需要它，但预留成本只有这一行。
    await sio.enter_room(sid, user_room(user.id))

    await redis_client.set(f'{settings.TOKEN_ONLINE_REDIS_PREFIX}:sid:{sid}', session_uuid)
    await redis_client.sadd(f'{settings.TOKEN_ONLINE_REDIS_PREFIX}:session:{session_uuid}', sid)
    await redis_client.sadd(settings.TOKEN_ONLINE_REDIS_PREFIX, session_uuid)
    return True


@sio.event
async def disconnect(sid) -> None:
    """Socket 断开连接事件"""
    session_uuid = await redis_client.get(f'{settings.TOKEN_ONLINE_REDIS_PREFIX}:sid:{sid}')
    if not session_uuid:
        return

    session_key = f'{settings.TOKEN_ONLINE_REDIS_PREFIX}:session:{session_uuid}'
    await redis_client.delete(f'{settings.TOKEN_ONLINE_REDIS_PREFIX}:sid:{sid}')
    await redis_client.srem(session_key, sid)
    if await redis_client.scard(session_key) == 0:
        await redis_client.delete(session_key)
        await redis_client.srem(settings.TOKEN_ONLINE_REDIS_PREFIX, session_uuid)
