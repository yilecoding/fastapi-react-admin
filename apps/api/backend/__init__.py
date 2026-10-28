import sqlalchemy as sa

from backend.utils.dynamic_import import get_all_models


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
__version__ = '0.5.0'
