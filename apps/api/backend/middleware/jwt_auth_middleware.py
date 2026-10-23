from typing import Any

from fastapi import Request, Response
from fastapi.security.utils import get_authorization_scheme_param
from starlette.authentication import AuthCredentials, AuthenticationBackend
from starlette.authentication import AuthenticationError as StarletteAuthenticationError
from starlette.requests import HTTPConnection

from backend.app.admin.schema.user import GetUserInfoWithRelationDetail
from backend.common.context import ctx
from backend.common.exception.errors import TokenError
from backend.common.log import log
from backend.common.security.data_scope import set_current_user
from backend.common.security.jwt import jwt_authentication
from backend.core.conf import settings
from backend.utils.serializers import MsgSpecJSONResponse


class AuthenticationError(StarletteAuthenticationError):
    """重写内部认证错误类"""

    def __init__(
        self,
        *,
        code: int | None = None,
        msg: str | None = None,
        headers: dict[str, Any] | None = None,
        data: Any = None,
    ) -> None:
        """
        初始化认证错误类

        :param code: 错误码
        :param msg: 错误信息
        :param headers: 响应头
        :param data: 响应体的 data（会话结束原因 `{'reason': ...}`，见 `TokenError.data`）
        :return:
        """
        self.code = code
        self.msg = msg
        self.headers = headers
        self.data = data


class JwtAuthMiddleware(AuthenticationBackend):
    """JWT 认证中间件"""

    @staticmethod
    def auth_exception_handler(conn: HTTPConnection, exc: AuthenticationError) -> Response:
        """
        覆盖内部认证错误处理

        :param conn: HTTP 连接对象
        :param exc: 认证错误对象
        :return:
        """
        content = {'code': exc.code, 'msg': exc.msg, 'data': exc.data}
        ctx.__request_authentication_exception__ = content
        return MsgSpecJSONResponse(content=content, status_code=exc.code)

    @staticmethod
    def extract_token(request: Request) -> str | None:
        """
        从请求中提取 Bearer Token

        :param request: FastAPI 请求对象
        :return:
        """
        authorization = request.headers.get('Authorization')
        if not authorization:
            return None

        path = request.url.path
        if path in settings.TOKEN_REQUEST_PATH_EXCLUDE:
            return None
        for pattern in settings.TOKEN_REQUEST_PATH_EXCLUDE_PATTERN:
            if pattern.match(path):
                return None

        scheme, token = get_authorization_scheme_param(authorization)
        if scheme.lower() != 'bearer':
            return None

        return token

    @staticmethod
    def client_idle(request: Request) -> int | None:
        """客户端自报的「用户多少秒没操作了」（请求头 `X-Client-Idle`）

        空闲超时按**人有没有在操作**算，不按请求算 —— 后台轮询（在线用户页 10 秒一次、监控页、
        导出任务）会让「按请求算」永远不过期（#138）。web 端给每个请求带上这个头；
        不带的端（移动端、桌面主进程）按「刚操作过」算。

        这是客户端自报的值：空闲超时防的是「人走开了、浏览器还开着」，不是防攻击者 ——
        拿着凭据的人本来就能自己发请求保活。看不懂的值一律当没带。

        :param request: FastAPI 请求对象
        :return: 秒数；没带 / 不合法时 None
        """
        raw = request.headers.get('X-Client-Idle')
        if raw is None or not raw.isdigit():
            return None
        return int(raw)

    async def authenticate(self, request: Request) -> tuple[AuthCredentials, GetUserInfoWithRelationDetail] | None:
        """
        认证请求

        :param request: FastAPI 请求对象
        :return:
        """
        token = self.extract_token(request)
        if token is None:
            return None

        try:
            user = await jwt_authentication(token, client_idle=self.client_idle(request))
        except TokenError as exc:
            if settings.TOKEN_REQUEST_UNDERLYING_SECURITY:
                raise AuthenticationError(code=exc.code, msg=exc.detail, headers=exc.headers, data=exc.data)
            ctx.__request_jwt_authentication_exception__ = exc
            return None
        except Exception as e:
            log.exception(f'JWT 授权异常：{e}')
            raise AuthenticationError(code=getattr(e, 'code', 500), msg=getattr(e, 'msg', 'Internal Server Error'))

        # 🔴 把用户放进 ContextVar，DAO 层的数据权限过滤靠它
        # （`common/security/data_scope.py`）。必须在**用户已经解析出来之后**才设 ——
        # 解析过程本身要查用户表，提前设了就会自己过滤掉自己。
        set_current_user(user)

        # 请注意，此返回使用非标准模式，所以在认证通过时，将丢失某些标准特性
        # 标准返回模式请查看：https://www.starlette.io/authentication/
        return AuthCredentials(['authenticated']), user
