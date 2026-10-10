from backend.common.enums import IntEnum, StrEnum


class ProviderType(StrEnum):
    """模型供应商类型

    全部走 **OpenAI 兼容** 的 `/chat/completions`，所以这个枚举只影响默认值与界面展示，
    不影响协议——内网自建网关（`CUSTOM`）和 DeepSeek 在代码路径上是同一条。
    """

    OPENAI = 'openai'
    DEEPSEEK = 'deepseek'
    QWEN = 'qwen'
    GLM = 'glm'
    CUSTOM = 'custom'


class MessageRole(StrEnum):
    """会话消息角色

    和 OpenAI 的 role 对齐，`TOOL` 存的是一次工具调用的返回值。
    """

    USER = 'user'
    ASSISTANT = 'assistant'
    TOOL = 'tool'


class ToolInvocationStatus(IntEnum):
    """工具调用的最终状态

    ⚠️ `DENIED` 和 `FAILED` 必须分开：前者是**权限不足被拦下**（安全事件，要能单独查），
    后者是执行过程中出错（业务/系统故障）。合成一个的话，「有人一直在让 AI 试探他没有
    权限的操作」这件事就淹没在普通报错里了。
    """

    SUCCESS = 0
    FAILED = 1
    DENIED = 2
    PENDING_CONFIRM = 3
    CANCELLED = 4
