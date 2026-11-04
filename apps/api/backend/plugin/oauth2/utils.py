"""第三方返回的邮箱到底验证过没有（#227）

按邮箱把社交账号关联到已有用户，等于「谁能让第三方返回这个邮箱，谁就能登进那个账号」。
所以只认第三方**明确说验证过**的邮箱：

- Google：v1 userinfo 带 `verified_email`（OIDC 那边叫 `email_verified`），两个都认
- GitHub：`/user` 里的 `email` 不带验证状态；`fastapi_oauth20` 取不到时还会回落到
  `/user/emails` 的 primary **或第一个**，都不保证验证过 —— 自己再查一次 `/user/emails`，
  找到同一个地址且 `verified: true` 才算。查失败一律当没验证（fail-closed：最坏是不自动关联，
  用户先用密码登录再去个人中心绑定）
"""

from typing import Any

import httpx

from backend.common.log import log

GITHUB_EMAILS_ENDPOINT = 'https://api.github.com/user/emails'


def google_email_verified(user: dict[str, Any]) -> bool:
    return user.get('verified_email') is True or user.get('email_verified') is True


async def github_email_verified(access_token: str, email: str | None) -> bool:
    if not email:
        return False
    try:
        async with httpx.AsyncClient(headers={'Authorization': f'Bearer {access_token}'}, timeout=10) as client:
            response = await client.get(GITHUB_EMAILS_ENDPOINT)
            response.raise_for_status()
            emails = response.json()
    except Exception as e:  # 网络 / 权限 / 格式，任何一种都不该让登录 500
        log.warning(f'查询 GitHub 邮箱验证状态失败，按未验证处理：{e}')
        return False
    if not isinstance(emails, list):
        return False
    target = email.strip().lower()
    return any(
        isinstance(item, dict) and str(item.get('email', '')).strip().lower() == target and item.get('verified') is True
        for item in emails
    )
