"""AI 工具的权限判定——**复用现有 RBAC 语义，不发明第二套授权模型**。

`rbac.py: rbac_verify()` 是"拦住一个 HTTP 请求"（不通过就抛异常）；这里要的是
"这个用户能不能调这个工具"（返回布尔，用于过滤工具清单）。两者判据必须一致。

实现挪到了 `common/security/rbac.py`（`user_has_perm` / `user_can_write`），就挨在
`rbac_verify` 下面 —— 导出任务在 worker 里复核权限也要用同一套判据，两份判据挨着才不会漂。
这里保留原来的名字，调用方（dispatcher、MCP 网关、测试）不用改。

🔴 **改 `rbac_verify` 的判据时，`rbac.py` 里那组要跟着改。** 两边分叉的表现是静默越权：
界面上点不到的按钮，换成"让 AI 帮我做"就能做。
"""

from backend.common.security.rbac import collect_allowed_perms as collect_allowed_perms
from backend.common.security.rbac import user_can_write as user_can_mutate
from backend.common.security.rbac import user_has_perm as user_can

__all__ = ['collect_allowed_perms', 'user_can', 'user_can_mutate']
