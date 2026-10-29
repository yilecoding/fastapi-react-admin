"""审批流对外的 Webhook 事件（#167）。由 `plugin/open/events.py: load_webhook_extensions` 扫描装入。

`workflow:read` 现在**没有**对应的开放接口（二期加 `workflow.instance` 的开放读接口），只用来授权订阅这几个事件。
data 是 thin 的：不给表单内容 —— 表单里什么都可能有（金额、身份证、病假原因）。
"""

from backend.plugin.open.events import register_webhook_event
from backend.plugin.open.gateway.auth import register_scope

register_scope('workflow:read', '读取审批')

_SAMPLE = {
    'id': '2231877432617197568',
    'definition_code': 'LEAVE',
    'title': '张伟提交的请假申请',
    'status': 'running',
    'initiator_id': '2049629108245233664',
    'biz_type': 'form',
    'biz_id': None,
}

for _type, _label, _status in (
    ('workflow.instance.started', '审批已发起', 'running'),
    ('workflow.instance.approved', '审批已通过', 'approved'),
    ('workflow.instance.rejected', '审批已驳回', 'rejected'),
    ('workflow.instance.withdrawn', '审批已撤回', 'withdrawn'),
    ('workflow.instance.terminated', '审批已终止', 'terminated'),
):
    register_webhook_event(_type, label=_label, scope='workflow:read', sample={**_SAMPLE, 'status': _status})
