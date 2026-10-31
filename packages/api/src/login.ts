/**
 * 登录页两端共用的契约细节 —— web `apps/web/src/routes/_guest/sign-in.tsx` 和移动端
 * `apps/mobile/src/app/login.tsx` 都从这里取。
 *
 * 都是后端定死、前端只能照做的东西。各写一份的代价已经付过：「撞了限流也重拉图形验证码」
 * web 在密码登录和手机发码两处各修过一次（#174 第 4 条），移动端的密码登录那份一直没跟上。
 */
import { ApiError } from './errors'

/**
 * 手机号格式 —— 和后端 `common/schema.py: CustomPhoneNumber` 是同一条正则（后端才是权威）。
 * 前端提前判一次，只为了不把一个必然 422 的号发出去：发码接口 5 次 / 分钟，白白吃掉一次配额
 */
export const PHONE_PATTERN = /^1[3-9]\d{9}$/

export function isPhoneNumber(value: string): boolean {
  return PHONE_PATTERN.test(value.trim())
}

/**
 * 发码之后多少秒才能再发 —— 对齐短信插件 `captcha` 业务模板声明的冷却
 * （`plugin/sms/templates.py`，登录发码的 `auth_service._phone_captcha_guard` 没配模板时的兜底也是 60）。
 * 只是界面上的倒计时，真正的闸在服务端：提前发会拿到一句「太频繁」
 */
export const SMS_RESEND_SECONDS = 60

/**
 * 登录类请求（密码登录 / 手机发码）失败之后，要不要换一张图形验证码。
 *
 * 🔴 **只有命中限流（429）时不换。** 限流器是路由依赖，在 handler 之前就拦下了 —— 验证码没被校验、
 * 也没被消费，接着用旧的即可。而 `/auth/captcha` 自己也有配额（5 次 / 30 秒）：撞了限流还跟着重拉，
 * 用户连点几下验证码接口也被打满，屏上同时是「验证码加载失败」和「太频繁」，两句都不说真正原因。
 *
 * 其余失败一律换：验证码对了就被服务端消费（`auth_service._verify_graphical_captcha`），
 * 错了多半是用户看错了，换一张比让他对着同一张再猜好。
 */
export function shouldReloadCaptcha(err: unknown): boolean {
  return !(err instanceof ApiError && err.isRateLimited)
}
