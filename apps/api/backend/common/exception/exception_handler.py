from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError
from sqlalchemy.exc import DBAPIError
from starlette.exceptions import HTTPException
from starlette.middleware.cors import CORSMiddleware
from uvicorn.protocols.http.h11_impl import STATUS_PHRASES

from backend.common.context import ctx
from backend.common.exception.errors import BaseExceptionError
from backend.common.i18n import i18n, t, tm
from backend.common.response.response_code import CustomResponseCode, StandardResponseCode
from backend.common.response.response_schema import response_base
from backend.core.conf import settings
from backend.utils.serializers import MsgSpecJSONResponse
from backend.utils.trace_id import get_request_trace_id


def _get_exception_code(status_code: int) -> int:
    """
    获取返回状态码（可用状态码基于 RFC 定义）

    `python 状态码标准支持 <https://github.com/python/cpython/blob/6e3cc72afeaee2532b4327776501eb8234ac787b/Lib/http/__init__.py#L7>`__

    `IANA 状态码注册表 <https://www.iana.org/assignments/http-status-codes/http-status-codes.xhtml>`__

    :param status_code: HTTP 状态码
    :return:
    """
    try:
        STATUS_PHRASES[status_code]
    except Exception:
        return StandardResponseCode.HTTP_400

    return status_code


async def _validation_exception_handler(exc: RequestValidationError | ValidationError):
    """
    数据验证异常处理

    :param exc: 验证异常
    :return:
    """
    errors = []
    for error in exc.errors():
        # 非 en-US 语言下，使用自定义错误信息
        if i18n.current_language != 'en-US':
            custom_message = t(f'pydantic.{error["type"]}')
            if custom_message:
                error_ctx = error.get('ctx')
                if not error_ctx:
                    error['msg'] = custom_message
                else:
                    e = error_ctx.get('error')
                    if e:
                        error['msg'] = custom_message.format(**error_ctx)
                        error['ctx']['error'] = e.__str__().replace("'", '"') if isinstance(e, Exception) else None
        errors.append(error)
    error = errors[0]
    if error.get('type') == 'json_invalid':
        message = t('error.request.json_invalid')
    else:
        error_input = error.get('input')
        field = str(error.get('loc')[-1])
        error_msg = error.get('msg')
        # 「，输入：」这段是 dev 专属的调试后缀，也得跟着语言走。
        suffix = t('error.request.debug_input_suffix', input=error_input)
        message = f'{field} {error_msg}{suffix}' if settings.ENVIRONMENT == 'dev' else error_msg
    # 外壳也要翻 —— 原来 en-US 下是「请求参数非法: Input should be a valid string」
    msg = t('error.request.invalid_parameter', message=message)
    data = {'errors': errors} if settings.ENVIRONMENT == 'dev' else None
    content = {
        'code': StandardResponseCode.HTTP_422,
        'msg': msg,
        'data': data,
    }
    ctx.__request_validation_exception__ = content  # 用于在中间件中获取异常信息
    content.update(trace_id=get_request_trace_id())
    return MsgSpecJSONResponse(status_code=StandardResponseCode.HTTP_422, content=content)


#: 「值太长」在三种方言下的样子。SQLSTATE `22001` 是标准码，
#: 但 pyodbc 报的是 `42000`，所以还得认消息文本。
#:
#: 🔴 **不加这层的表现是 500 + 一条裸 SQL 错误。** 实测：给部门的 `leader`
#: 传 33 个字符（列是 `UniversalStr(32)`），
#: `pyodbc.ProgrammingError: String or binary data would be truncated in
#: table 'fba_test.dbo.sys_dept', column 'leader'` 一路冒到
#: `ServerErrorMiddleware`。
#:
#: 为什么在这里兜而不是逐个字段补 `max_length`：全仓有 **88 个**带长度的
#: 字符串列，而 schema 里只有 **9 处** `max_length`（实测数的）。
#: 逐个补是 88 份重复声明、88 个会和列定义分叉的地方；在这里兜一次，
#: 现在和以后新增的列一起罩上。
#:
#: ⚠️ 这不替代 `max_length` —— 有 `max_length` 的字段报的是 422 + **字段名**，
#: 比这里的 400 精确得多。前端已经限制了长度的字段（`dept.leader`、
#: `role.remark` 那些）值得单独补上，让报错点出是哪一个框。
_VALUE_TOO_LONG_MARKERS = (
    'string or binary data would be truncated',  # SQL Server (2628 / 8152)
    'data too long for column',  # MySQL (1406)
    'value too long for type',  # PostgreSQL (22001)
)


def _is_value_too_long(exc: BaseException) -> bool:
    """判断一个数据库异常是不是「值超出列长度」"""
    sqlstate = getattr(getattr(exc, 'orig', None), 'sqlstate', None)
    if sqlstate == '22001':
        return True
    message = str(getattr(exc, 'orig', exc)).lower()
    return any(marker in message for marker in _VALUE_TOO_LONG_MARKERS)


def _unknown_exception_content(exc: BaseException) -> dict:
    """未知异常的响应体（dev 带原文，prod 只给标准 500）"""
    if settings.ENVIRONMENT == 'dev':
        return {'code': StandardResponseCode.HTTP_500, 'msg': str(exc), 'data': None}
    return response_base.fail(res=CustomResponseCode.HTTP_500).model_dump()


def register_exception(app: FastAPI) -> None:  # ruff:ignore[complex-structure]
    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException):
        """
        全局 HTTP 异常处理

        :param request: FastAPI 请求对象
        :param exc: HTTP 异常
        :return:
        """
        if settings.ENVIRONMENT == 'dev':
            content = {
                'code': exc.status_code,
                'msg': tm(str(exc.detail)),
                'data': None,
            }
        else:
            res = response_base.fail(res=CustomResponseCode.HTTP_400)
            content = res.model_dump()
        ctx.__request_http_exception__ = content
        content.update(trace_id=get_request_trace_id())
        return MsgSpecJSONResponse(
            status_code=_get_exception_code(exc.status_code),
            content=content,
            headers=exc.headers,
        )

    @app.exception_handler(RequestValidationError)
    async def fastapi_validation_exception_handler(request: Request, exc: RequestValidationError):
        """
        FastAPI 数据验证异常处理

        :param request: FastAPI 请求对象
        :param exc: 验证异常
        :return:
        """
        return await _validation_exception_handler(exc)

    @app.exception_handler(ValidationError)
    async def pydantic_validation_exception_handler(request: Request, exc: ValidationError):
        """
        Pydantic 数据验证异常处理

        :param request: 请求对象
        :param exc: 验证异常
        :return:
        """
        return await _validation_exception_handler(exc)

    @app.exception_handler(AssertionError)
    async def assertion_error_handler(request: Request, exc: AssertionError):
        """
        断言错误处理

        :param request: FastAPI 请求对象
        :param exc: 断言错误
        :return:
        """
        if settings.ENVIRONMENT == 'dev':
            content = {
                'code': StandardResponseCode.HTTP_500,
                'msg': str(''.join(exc.args) if exc.args else exc.__doc__),
                'data': None,
            }
        else:
            res = response_base.fail(res=CustomResponseCode.HTTP_500)
            content = res.model_dump()
        ctx.__request_assertion_error__ = content
        content.update(trace_id=get_request_trace_id())
        return MsgSpecJSONResponse(
            status_code=StandardResponseCode.HTTP_500,
            content=content,
        )

    @app.exception_handler(BaseExceptionError)
    async def custom_exception_handler(request: Request, exc: BaseExceptionError):
        """
        全局自定义异常处理

        :param request: FastAPI 请求对象
        :param exc: 自定义异常
        :return:
        """
        content = {
            'code': exc.code,
            # 业务消息在**出口**翻译：调用点仍是中文字面量（189 处 / 28 个文件），
            # 一行都不用改，见 `common/i18n.py: I18n.tm`
            'msg': tm(str(exc.msg)),
            'data': exc.data or None,
        }
        ctx.__request_custom_exception__ = content
        content.update(trace_id=get_request_trace_id())
        return MsgSpecJSONResponse(
            status_code=_get_exception_code(exc.code),
            content=content,
            background=exc.background,
        )

    @app.exception_handler(DBAPIError)
    async def dbapi_exception_handler(request: Request, exc: DBAPIError):
        """数据库驱动异常 —— 把「值太长」翻译成 400，其余仍按未知异常走 500

        :param request: FastAPI 请求对象
        :param exc: SQLAlchemy 包装过的驱动异常
        :return:
        """
        if not _is_value_too_long(exc):
            content = _unknown_exception_content(exc)
            ctx.__request_unknown_exception__ = content
            content.update(trace_id=get_request_trace_id())
            return MsgSpecJSONResponse(status_code=StandardResponseCode.HTTP_500, content=content)

        content = {
            'code': StandardResponseCode.HTTP_400,
            'msg': t('error.db.value_too_long'),
            'data': None,
        }
        content.update(trace_id=get_request_trace_id())
        return MsgSpecJSONResponse(status_code=StandardResponseCode.HTTP_400, content=content)

    @app.exception_handler(Exception)
    async def all_unknown_exception_handler(request: Request, exc: Exception):
        """
        全局未知异常处理

        :param request: FastAPI 请求对象
        :param exc: 未知异常
        :return:
        """
        if settings.ENVIRONMENT == 'dev':
            content = {
                'code': StandardResponseCode.HTTP_500,
                'msg': str(exc),
                'data': None,
            }
        else:
            res = response_base.fail(res=CustomResponseCode.HTTP_500)
            content = res.model_dump()
        ctx.__request_unknown_exception__ = content
        content.update(trace_id=get_request_trace_id())
        return MsgSpecJSONResponse(
            status_code=StandardResponseCode.HTTP_500,
            content=content,
        )

    if settings.MIDDLEWARE_CORS:

        @app.exception_handler(StandardResponseCode.HTTP_500)
        async def cors_custom_code_500_exception_handler(request: Request, exc: BaseExceptionError | Exception):
            """
            跨域自定义 500 异常处理

            :param request: FastAPI 请求对象
            :param exc: 自定义异常
            :return:
            """
            if isinstance(exc, BaseExceptionError):
                content = {
                    'code': exc.code,
                    'msg': tm(str(exc.msg)),
                    'data': exc.data,
                }
            else:
                if settings.ENVIRONMENT == 'dev':
                    content = {
                        'code': StandardResponseCode.HTTP_500,
                        'msg': str(exc),
                        'data': None,
                    }
                else:
                    res = response_base.fail(res=CustomResponseCode.HTTP_500)
                    content = res.model_dump()
            if isinstance(exc, BaseExceptionError):
                ctx.__request_custom_exception__ = content
            else:
                ctx.__request_unknown_exception__ = content
            content.update(trace_id=get_request_trace_id())
            response = MsgSpecJSONResponse(
                status_code=exc.code if isinstance(exc, BaseExceptionError) else StandardResponseCode.HTTP_500,
                content=content,
                background=exc.background if isinstance(exc, BaseExceptionError) else None,
            )
            origin = request.headers.get('origin')
            if origin:
                cors = CORSMiddleware(
                    app=app,
                    allow_origins=settings.CORS_ALLOWED_ORIGINS,
                    allow_credentials=True,
                    allow_methods=['*'],
                    allow_headers=['*'],
                    expose_headers=settings.CORS_EXPOSE_HEADERS,
                )
                response.headers.update(cors.simple_headers)
                has_cookie = 'cookie' in request.headers
                if cors.allow_all_origins and has_cookie:
                    response.headers['Access-Control-Allow-Origin'] = origin
                elif not cors.allow_all_origins and cors.is_allowed_origin(origin=origin):
                    response.headers['Access-Control-Allow-Origin'] = origin
                    response.headers.add_vary_header('Origin')
            return response
