import random

from typing import Annotated

from fastapi import APIRouter, Body, Depends
from pyrate_limiter import Duration, Rate

from backend.common.context import ctx
from backend.common.response.response_schema import ResponseModel, response_base
from backend.common.security.jwt import DependsJwtAuth
from backend.core.conf import settings
from backend.database.db import CurrentSession
from backend.database.redis import redis_client
from backend.plugin.email.utils.send import send_email
from backend.utils.limiter import RateLimiter

router = APIRouter()


@router.post(
    '/captcha',
    summary='发送电子邮件验证码',
    # 🔴 `recipients` 是调用方传的，鉴权只挡住了"必须是登录用户"，挡不住
    # "登录用户能把邮件发给任意地址、发任意次"——这条接口会真的触发一次 SMTP
    # 发信（`send_email`），不限流等于把这台服务器的邮箱变成一个能被登录用户
    # 拿来batch群发的中继。速率参照 `EMAIL_CAPTCHA_EXPIRE_SECONDS`（验证码
    # 3 分钟过期）定，同一个 IP 3 分钟内最多请求 3 次，跟验证码本身的有效期
    # 对齐，不是拍脑袋的数字。
    dependencies=[DependsJwtAuth, Depends(RateLimiter(Rate(3, Duration.MINUTE * 3)))],
)
async def send_email_captcha(
    db: CurrentSession,
    recipients: Annotated[str | list[str], Body(embed=True, description='邮件接收者')],
) -> ResponseModel:
    code = ''.join([str(random.randint(1, 9)) for _ in range(6)])
    ip = ctx.ip
    await redis_client.set(
        f'{settings.EMAIL_CAPTCHA_REDIS_PREFIX}:{ip}',
        code,
        ex=settings.EMAIL_CAPTCHA_EXPIRE_SECONDS,
    )
    content = {'code': code, 'expired': int(settings.EMAIL_CAPTCHA_EXPIRE_SECONDS / 60)}
    await send_email(db, recipients, 'FBA 验证码', content, 'captcha.html')
    return response_base.success()
