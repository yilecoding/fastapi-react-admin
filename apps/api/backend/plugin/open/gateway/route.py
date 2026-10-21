"""开放接口的路由类：每次调用落一条调用日志（`open_api_log`），成功失败都落。

为什么是路由类而不是中间件 / 依赖：

- `OperaLogMiddleware` 只记 `/api/v1`，开放接口一条都不会进去；再加一个全局中间件要对每个请求判路径
- 依赖拿不到**最终响应**；而鉴权失败恰恰最要看响应（签名不匹配时里面有服务端的 StringToSign）
- `route_class` 只包 open 这一组路由，依赖解析、鉴权失败、业务异常都在它里面发生

🔴 请求参数 / 请求头 / 响应体的脱敏与截断**直接调 `OperaLogMiddleware` 那几个函数**，不另写一份：
两份脱敏规则迟早一边漏改，漏的那边就是凭据进日志。

落库挂在响应的 `BackgroundTask` 上（响应发完再写），不给调用方加一次写库的延迟。
"""

import time

from collections.abc import Callable, Coroutine
from typing import Any

from fastapi import Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from starlette.background import BackgroundTask, BackgroundTasks

from backend.common.context import ctx
from backend.common.log import log
from backend.middleware.opera_log_middleware import OperaLogMiddleware
from backend.plugin.open.gateway.auth import OpenCallContext, call_context
from backend.plugin.open.gateway.errors import OpenApiError
from backend.plugin.open.service.api_log_service import write_api_log
from backend.utils.serializers import MsgSpecJSONResponse
from backend.utils.timezone import timezone
from backend.utils.trace_id import get_request_trace_id


def _error_response(e: OpenApiError) -> Response:
    content = {'code': e.status, 'msg': e.msg, 'data': e.data, 'trace_id': get_request_trace_id()}
    return MsgSpecJSONResponse(content=content, status_code=e.status, headers=e.headers)


def _entry(
    request: Request,
    call: OpenCallContext,
    *,
    args: dict[str, Any] | None,
    request_headers: dict[str, str],
    status_code: int,
    msg: str,
    started: float,
    request_time: Any,
    response_headers: dict[str, str] | None = None,
    response_body: str | None = None,
) -> dict[str, Any]:
    route = request.scope.get('route')
    app = call.app
    return {
        'trace_id': get_request_trace_id(),
        'app_id': app.id if app else None,
        'app_code': app.code if app else None,
        'app_name': app.name if app else None,
        'access_key': (call.access_key or None) and call.access_key[:64],
        'method': request.method,
        'title': (route.summary or '') if route else '',
        'path': request.url.path,
        'scope': call.scope,
        'scope_granted': call.scope_granted,
        'ip': ctx.ip,
        'ip_whitelisted': call.ip_whitelisted,
        'country': ctx.country,
        'region': ctx.region,
        'city': ctx.city,
        'user_agent': ctx.user_agent,
        'os': ctx.os,
        'browser': ctx.browser,
        'device': ctx.device,
        'args': args,
        'request_headers': request_headers,
        'response_headers': response_headers,
        'response_body': response_body,
        'status': 1 if call.error_code == 'ok' and status_code < 400 else 0,
        'code': str(status_code),
        'error_code': call.error_code,
        'msg': msg,
        'row_count': call.row_count,
        'cost_time': round((time.perf_counter() - started) * 1000, 3),
        'request_time': request_time,
        'touch_app_id': app.id if (app and call.touch_last_used) else None,
    }


class OpenApiRoute(APIRoute):
    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        original = super().get_route_handler()

        async def handler(request: Request) -> Response:
            started = time.perf_counter()
            request_time = timezone.now()
            call = call_context(request)
            # 先读：`get_request_args` 会把 body 读进 request 的缓存，后面的验签和接口函数拿到的是同一份
            args = await OperaLogMiddleware.get_request_args(OperaLogMiddleware, request)  # type: ignore[arg-type]
            request_headers = OperaLogMiddleware.collect_headers(request.headers)

            try:
                response = await original(request)
                msg = 'Success'
            except OpenApiError as e:
                call.error_code = e.error_code
                response = _error_response(e)
                msg = e.msg
            except Exception as e:
                # 参数校验失败 / 业务异常 / 500：交回全局异常处理器出响应，这里只把这一条记下来
                call.error_code = call.error_code if call.error_code != 'ok' else 'open.request_failed'
                if isinstance(e, RequestValidationError):
                    status_code = 422
                else:
                    status_code = int(getattr(e, 'status_code', None) or getattr(e, 'code', None) or 500)
                entry = _entry(
                    request,
                    call,
                    args=args,
                    request_headers=request_headers,
                    status_code=status_code if 100 <= status_code < 600 else 500,
                    msg=str(getattr(e, 'msg', None) or getattr(e, 'detail', None) or e),
                    started=started,
                    request_time=request_time,
                )
                try:
                    await write_api_log(entry)
                except Exception:
                    log.exception('开放接口调用日志写入失败')
                raise

            content_type = (response.headers.get('content-type') or '').split(';')[0].strip().lower()
            raw = getattr(response, 'body', b'') or b''
            body = OperaLogMiddleware.truncate_body(OperaLogMiddleware.redact_body(raw, content_type))
            entry = _entry(
                request,
                call,
                args=args,
                request_headers=request_headers,
                status_code=response.status_code,
                msg=msg,
                started=started,
                request_time=request_time,
                response_headers=OperaLogMiddleware.collect_headers(response.headers),
                response_body=body,
            )
            _attach(response, BackgroundTask(write_api_log, entry))
            return response

        return handler


def _attach(response: Response, task: BackgroundTask) -> None:
    """挂后台任务，**不覆盖**响应上已有的那个（接口自己也可能挂了）"""
    if response.background is None:
        response.background = task
        return
    tasks = BackgroundTasks()
    tasks.add_task(response.background)
    tasks.add_task(task)
    response.background = tasks
