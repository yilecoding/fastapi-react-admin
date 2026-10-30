import type { BotPlatform } from './api'

/** 写成函数里的字面量 `t('…')`：模块级常量再 `t(变量)` 的话 `i18n:check` 看不见这些 key */
export function platformLabel(t: (k: string) => string, p: BotPlatform): string {
  switch (p) {
    case 'feishu':
      return t('飞书')
    case 'dingtalk':
      return t('钉钉')
    default:
      return t('企业微信')
  }
}

/** 去哪里复制 Webhook 地址 —— 三家的入口藏得各不一样 */
export function platformHint(t: (k: string) => string, p: BotPlatform): string {
  switch (p) {
    case 'feishu':
      return t('群设置 → 群机器人 → 添加机器人 → 自定义机器人，复制 Webhook 地址。开了「签名校验」就把密钥填在下面')
    case 'dingtalk':
      return t('群设置 → 机器人 → 添加机器人 → 自定义。安全设置至少要选一项：推荐「加签」，把 SEC 开头的密钥填在下面；选「自定义关键词」的话消息里必须带那个词，测试消息多半过不了')
    default:
      return t('群聊右上角 → 消息推送 → 添加，复制 Webhook 地址。企业微信的群机器人没有加签，地址里的 key 就是凭据')
  }
}

/**
 * 后端群机器人那几类 `reason`（`bot_platforms.py` / `senders.py` / `delivery_service.py`）。
 * 不是群机器人的返回 null，投递记录页再按邮件 / 短信的那几类去认
 */
export function botReasonLabel(t: (k: string) => string, r: string): string | null {
  switch (r) {
    case 'sign_failed':
      return t('签名校验没过（密钥填错，或服务器时间偏差太大）')
    case 'keyword_missing':
      return t('消息里没有机器人设的关键词')
    case 'ip_not_allowed':
      return t('服务器 IP 不在机器人的白名单里')
    case 'security_check':
      return t('没过机器人的安全设置')
    case 'invalid_webhook':
      return t('Webhook 地址失效（机器人可能被删了）')
    case 'bad_request':
      return t('平台说请求格式不对')
    case 'rate_limited':
      return t('发送太频繁，被平台限流')
    case 'throttled':
      return t('这一分钟发够了，排到下一分钟')
    case 'platform_error':
      return t('平台返回错误')
    case 'platform_busy':
      return t('平台暂时不可用')
    case 'http_error':
      return t('平台拒绝了请求')
    case 'unreadable_response':
      return t('平台回包读不懂（可能已发出）')
    case 'network_after_send':
      return t('请求已发出、没等到回包（可能已发出）')
    case 'bot_missing':
      return t('机器人已删除')
    case 'bot_disabled':
      return t('机器人已停用')
    case 'network':
      return t('网络不通')
    case 'config_error':
      return t('配置有误（加密密钥换过？）')
    default:
      return null
  }
}
