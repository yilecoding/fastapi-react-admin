"""AI 自动同意（#111 第 5 条）：预审「建议通过」之后，**数据够了**才替人同意这一步。

#111 定的边界，每条都守住：

- 🔴 **只有同意，永远不自动驳回**：预审是 attention / reject、或者数据不够，什么都不做，照常给人审
- 🔴 **按数据放闸**：这个流程 × 这个模型「建议通过」的单里，人最后也通过的比例 ≥ 节点配的门槛、
  样本 ≥ 节点配的下限，才做。
  看的是「建议通过」那一列的准确率（不是总一致率）：AI 只在建议通过时出手，建议驳回准不准与此无关。
  口径和一致率抽屉同一个函数（`ai_review_service.decided_reviews`），AI 自动同意过的单不算 —— 否则是 AI 给自己打分
- 🔴 **AI 不进审批事务**：这里在预审的 Celery 任务里、预审结果提交之后跑；真正动单子的那一下（`apply_ai_approve`）
  和人点按钮一样先认领实例，并且只在「提交之后谁都没动过」时做
- **三道闸**：总闸 `WORKFLOW_AI_APPROVE_ENABLED`（plugin.toml，要重启）·
  节点开关在**实例快照**和**当前发布的版本**里都要开着
  （关掉再发布，在途的单立刻停，不用等它们走完）· 数据门槛按当前发布版本的配置算（调高门槛同样立刻生效）
"""

from __future__ import annotations

import json

from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select

from backend.common.i18n import t
from backend.common.log import log
from backend.core.conf import settings
from backend.plugin.workflow.engine.flow import index_nodes
from backend.plugin.workflow.enums import DefinitionStatus, InstanceStatus, TaskStatus
from backend.plugin.workflow.model import WfAiReview, WfDefinition, WfDefinitionVersion, WfInstance, WfTask
from backend.plugin.workflow.service import runtime_service
from backend.plugin.workflow.service.ai_review_service import decided_reviews, run_review

if TYPE_CHECKING:
    from collections.abc import Callable

    from sqlalchemy.ext.asyncio import AsyncSession


async def pass_record(db: AsyncSession, *, code: str, model: str | None) -> tuple[int, int]:
    """（AI 建议通过、已经有结论的单数，其中人最后通过的单数）"""
    stmt = decided_reviews(WfInstance.status, func.count()).where(
        WfDefinition.code == code, WfAiReview.model == model, WfAiReview.verdict == 'pass'
    )
    rows = dict((await db.execute(stmt.group_by(WfInstance.status))).all())
    approved = rows.get(InstanceStatus.approved, 0)
    return approved + rows.get(InstanceStatus.rejected, 0), approved


def _ai_cfg(model: dict[str, Any], node_id: str) -> dict[str, Any] | None:
    ref = index_nodes(model).get(node_id)
    if ref is None or ref.node['type'] != 'approval':
        return None
    cfg = ref.node.get('aiApprove') or {}
    return cfg if cfg.get('enabled') else None


async def maybe_approve(db: AsyncSession, review_id: int) -> str:
    """预审写完之后调。返回一个给任务日志看的短状态：

    `off` / `not_pass` / `node_off` / `gate` / `moved` / `approved`
    """
    if not settings.WORKFLOW_AI_APPROVE_ENABLED:
        return 'off'
    review = await db.get(WfAiReview, review_id, populate_existing=True)
    if review is None or review.status != 'done' or review.verdict != 'pass' or review.instance_version is None:
        return 'not_pass'
    inst = await db.get(WfInstance, review.instance_id, populate_existing=True)
    if inst is None or inst.status != InstanceStatus.running or inst.version != review.instance_version:
        return 'moved'
    node_ids = set(
        (
            await db.scalars(
                select(WfTask.node_id).where(WfTask.instance_id == inst.id, WfTask.status == TaskStatus.pending)
            )
        ).all()
    )
    if len(node_ids) != 1:
        return 'moved'
    (node_id,) = node_ids
    d = await db.get(WfDefinition, inst.definition_id)
    current = await db.get(WfDefinitionVersion, d.current_version_id) if d and d.current_version_id else None
    snapshot_cfg = _ai_cfg(json.loads(inst.model_snapshot), node_id)
    current_cfg = _ai_cfg(json.loads(current.model_json), node_id) if current else None
    if snapshot_cfg is None or current_cfg is None or d.status != DefinitionStatus.published:
        return 'node_off'
    min_samples = int(current_cfg.get('minSamples', 30))
    min_precision = float(current_cfg.get('minPrecision', 0.95))
    samples, approved = await pass_record(db, code=d.code, model=review.model)
    precision = approved / samples if samples else 0.0
    if samples < min_samples or precision < min_precision:
        log.info(
            f'AI 自动同意没放闸（实例 {inst.id}，{d.code} × {review.model}）：'
            f'{samples} 张里通过 {approved}，要求 ≥{min_samples} 张、≥{min_precision:.0%}'
        )
        return 'gate'
    done = await runtime_service.apply_ai_approve(
        db,
        inst.id,
        version=review.instance_version,
        node_id=node_id,
        model_name=review.model,
        opinion=t('workflow.ai_approved', n=samples, rate=f'{precision:.1%}'),
        detail={
            'review_id': str(review.id),
            'model': review.model,
            'points_version': review.points_version,
            'samples': samples,
            'precision': round(precision, 4),
            'min_samples': min_samples,
            'min_precision': min_precision,
        },
    )
    return 'approved' if done else 'moved'


async def after_review(session_factory: Callable[[], Any], review_id: int) -> str:
    """Celery 任务的本体：先预审，「建议通过」再看能不能替人同意。

    🔴 自动同意出任何错都不影响预审结果（那一行已经提交了），也不会变成「驳回」—— 只是这张单照常给人审
    """
    status = await run_review(session_factory, review_id)
    if status != 'pass':
        return status
    try:
        async with session_factory() as db:
            return f'pass:{await maybe_approve(db, review_id)}'
    except Exception as e:  # 认领撞了（有人正在办）也走到这里：照常给人审
        log.warning(f'AI 自动同意没做成（review={review_id}）：{e!r}')
        return 'pass:error'
