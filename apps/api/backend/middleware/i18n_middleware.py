from collections.abc import Callable

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

from backend.common.i18n import i18n
from backend.core.conf import settings


def get_current_language(request: Request) -> str | None:
    """
    获取当前请求的语言偏好

    :param request: FastAPI 请求对象
    :return:
    """
    accept_language = request.headers.get('Accept-Language', '')
    if not accept_language:
        return settings.I18N_DEFAULT_LANGUAGE

    languages = [lang.split(';')[0] for lang in accept_language.split(',')]
    lang = languages[0].lower().strip()

    # 语言映射
    lang_mapping = {
        'zh': 'zh-CN',
        'zh-cn': 'zh-CN',
        'zh-hans': 'zh-CN',
        'en': 'en-US',
        'en-us': 'en-US',
    }

    mapped = lang_mapping.get(lang)
    if mapped:
        return mapped

    # ⚠️ 原来这里是 `lang_mapping.get(lang, lang)`，把没映射的语言原样返回。
    # 后果很重：`I18n.t()` 查不到语言包时会走 KeyError 分支，
    # 把请求的 key 整个换成 `error.language_not_found` —— 于是**所有**响应的 `msg`
    # 都变成「当前语言包未初始化或不存在」，业务错误提示全废。
    # 实测：日文浏览器访问，连 `请求成功` 都变成那句话。
    # 认不出来的语言一律回落到默认语言。
    return settings.I18N_DEFAULT_LANGUAGE if lang not in i18n.locales else lang


class I18nMiddleware(BaseHTTPMiddleware):
    """国际化中间件"""

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        """
        处理请求并设置国际化语言

        :param request: FastAPI 请求对象
        :param call_next: 下一个中间件或路由处理函数
        :return:
        """
        language = get_current_language(request)

        # 设置国际化语言
        if language and i18n.current_language != language:
            i18n.current_language = language

        response = await call_next(request)

        return response
