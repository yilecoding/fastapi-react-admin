import sys


# 🔴 Windows 上标准输出强制 UTF-8。系统代码页不是 UTF-8 时（实测：繁中 cp950），启动期 rich 打印
# 「检测插件依赖...」这种简体中文直接 `UnicodeEncodeError`，api 起不来（输出重定向 / 非 VT 终端时必现）；
# celery 的日志则整片乱码。放在包的最顶上：api / celery / cli / pytest 都先 import 这里。
# 不靠在 package.json 里写 `PYTHONUTF8=1 uv run …` —— 那种行内设环境变量的写法 Windows 上的 pnpm 不认
def _force_utf8(stream: object) -> None:
    try:
        stream.reconfigure(encoding='utf-8', errors='backslashreplace')  # type: ignore[attr-defined]
    except (AttributeError, ValueError):  # 被替换成了不支持 reconfigure 的对象（如 pytest 的捕获）
        pass


if sys.platform == 'win32':
    _force_utf8(sys.stdout)
    _force_utf8(sys.stderr)

import sqlalchemy as sa  # ruff: ignore[module-import-not-at-top-of-file]

from backend.utils.dynamic_import import get_all_models  # ruff: ignore[module-import-not-at-top-of-file]


def _register_model_globals() -> None:
    """导入所有模型并注册到 backend 模块命名空间"""
    for model_obj in get_all_models():
        model_name = model_obj.name if isinstance(model_obj, sa.Table) else model_obj.__name__
        if model_name not in globals():
            globals()[model_name] = model_obj


_register_model_globals()


# 产品版本号，/docs 顶上的徽章、AI 的 system_info 工具、OTel 的 service.version 都读它。
# 🔴 必须和 `apps/web/package.json` 的 version 同值 —— 打 tag 时 release.yml 两边一起校验，不一致第一个 job 就红。
# 原来写的是上游 FBA 的版本（1.15.1），/docs 上一直挂着一个和本产品无关的号；上游基线记在 `apps/api/.upstream-baseline`
__version__ = '1.1.0'
