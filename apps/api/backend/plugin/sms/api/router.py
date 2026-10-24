from fastapi import APIRouter

from backend.core.conf import settings
from backend.plugin.sms.api.v1.config import router as config_router
from backend.plugin.sms.api.v1.log import router as log_router
from backend.plugin.sms.extensions import load_sms_extensions

v1 = APIRouter(prefix=f'{settings.FASTAPI_API_V1_PATH}/sms')

v1.include_router(config_router, prefix='/configs', tags=['短信配置'])
v1.include_router(log_router, prefix='/logs', tags=['短信发送日志'])

# 在路由装配时把内置厂商 / 模板和别的插件的扩展装进来。
# ⚠️ 放这里而不是某个 startup 钩子：插件加载器一定会 import 这个模块，而「没被 import 的厂商等于不存在」
# 的表现是配置页下拉里少一家 —— 不报错（同 AI 插件 `load_builtin_tools()`）
load_sms_extensions()
