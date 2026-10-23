from typing import Any

from backend.common.i18n import t


class OpenApiError(Exception):
    """开放接口的鉴权 / 授权失败。

    不走全局的异常处理器：`gateway/route.py` 在路由内就把它转成响应，这样调用日志能拿到
    **最终发出去的那份响应体**（签名不匹配时里面有服务端的 StringToSign，详情页靠它排查）。

    `error_code` 是给机器认的稳定码（对接文档里列着），`msg` 是给人看的、跟着 Accept-Language 走。
    """

    def __init__(
        self,
        status: int,
        error_code: str,
        *,
        data: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> None:
        self.status = status
        self.error_code = error_code
        self.msg = t(f'error.{error_code}', **kwargs)
        self.data = data
        self.headers = headers
        super().__init__(self.msg)
