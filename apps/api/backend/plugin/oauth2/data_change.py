"""数据变更审计（#260）：用户绑的第三方账号，折叠成用户的「第三方账号」集合字段。

绑定 / 解绑都记在**用户**名下（「加了 GitHub」「去掉了 Google」）。解绑是逻辑删除（`deleted = id`），
所以要给 `active`：`deleted` 非 0 的行不算绑着。第三方那边的用户 ID（`sid`）不记。
"""

from backend.common.data_change import register_audited_set
from backend.plugin.oauth2.enums import UserSocialType
from backend.plugin.oauth2.model import UserSocial

register_audited_set(
    UserSocial,
    entity='user',
    parent='user_id',
    member='source',
    field='socials',
    label='第三方账号',
    member_labels={UserSocialType.github.value: 'GitHub', UserSocialType.google.value: 'Google'},
    active='deleted',
)
