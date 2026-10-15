"""按配置选引擎——"换引擎只改一个配置值"就落在这里。"""

from backend.common.exception import errors
from backend.core.conf import settings
from backend.plugin.ai.core.ports import AgentRuntimePort
from backend.plugin.ai.engines.native import NativeLoopEngine
from backend.plugin.ai.llm.client import OpenAICompatClient


def build_engine(client: OpenAICompatClient) -> AgentRuntimePort:
    """造一个引擎实例。

    新增引擎 = 这里加一个分支 + 一个适配器文件。**不要**在业务代码里按引擎名分叉，
    那样"可插拔"就退化成"到处都是 if"。
    """
    engine = settings.AI_AGENT_ENGINE
    if engine == 'native':
        return NativeLoopEngine(client)
    # pi sidecar 等适配器在这里接。刻意 fail-fast 而不是"回落到 native"——
    # 静默回落会让"我明明配了 pi"和"pi 没生效"完全无法区分
    raise errors.ServerError(msg=f'未知的 AI 引擎：{engine}')
