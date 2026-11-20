from starlette.requests import Request
from starlette.types import ASGIApp, Receive, Scope, Send

from backend.common.context import ctx
from backend.utils.request_parse import parse_ip_info, parse_user_agent_info


class StateMiddleware:
    """请求状态中间件

    纯 ASGI 写法，不继承 `BaseHTTPMiddleware`：那个基类每层都要给下游另起一个任务、
    经内存流转发响应，压测里每个请求的固定开销有一截就花在这里（见 `middleware` 分册）。
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """
        设置请求状态信息（IP / 属地 / UA）后交给下游

        :param scope: ASGI scope
        :param receive: ASGI receive
        :param send: ASGI send
        :return:
        """
        if scope['type'] != 'http':
            await self.app(scope, receive, send)
            return

        request = Request(scope)
        ip_info = await parse_ip_info(request)
        ctx.ip = ip_info.ip
        ctx.country = ip_info.country
        ctx.region = ip_info.region
        ctx.city = ip_info.city

        ua_info = parse_user_agent_info(request)
        ctx.user_agent = ua_info.user_agent
        ctx.os = ua_info.os
        ctx.browser = ua_info.browser
        ctx.device = ua_info.device

        await self.app(scope, receive, send)
