"""数据变更审计（#281）：定时任务。

由 `common/data_change/registry.load_data_change_extensions()` 扫描导入
（`backend/app/*` 和插件下的 `data_change.py` 都扫）。

🔴 `total_run_count` / `last_run_time` 每触发一次 beat 就写一次，进 `ignore` —— 不忽略的话每次触发都是一条「改了」。
`args` / `kwargs` 是 JSON 文本，按普通值整段记：任务参数不该放凭据（要用的密钥放 `.env` 或参数配置）。
"""

from backend.app.task.model import TaskScheduler
from backend.common.data_change import register_audited

_YES_NO = {0: '否', 1: '是'}

register_audited(
    TaskScheduler,
    entity='task_scheduler',
    title='定时任务',
    label='name',
    fields={
        'name': '任务名称',
        'task': 'Celery 任务',
        'args': '位置参数',
        'kwargs': '关键字参数',
        'queue': '队列',
        'exchange': '交换机',
        'routing_key': '路由键',
        'start_time': '开始触发时间',
        'expire_time': '截止触发时间',
        'expire_seconds': '相对截止秒数',
        'type': '调度类型',
        'interval_every': '间隔数',
        'interval_period': '间隔单位',
        'crontab': 'Crontab 表达式',
        'one_off': '只运行一次',
        'enabled': '启用',
        'remark': '备注',
    },
    enums={'type': {0: '间隔', 1: '定时'}, 'one_off': _YES_NO, 'enabled': _YES_NO},
    ignore={'total_run_count', 'last_run_time', 'created_time', 'updated_time', 'deleted_time'},
    soft_delete='deleted',
)
