# plugin/oauth2 —— 第三方登录（GitHub / Google）

> 应用级插件，回调在 `/api/v1/oauth2/{github,google}/callback`（免鉴权）。配置项见同目录 `README.md`。
> 「设 cookie 再重定向」那个坑记在 [`apps/api` 分册](../../../AGENTS.md)。
>
> 这份文件是 [`apps/api` 分册](../../../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的
> 文件时才把它加载进上下文（惰性加载）。跨模块的硬纪律只在根 `CLAUDE.md` 里有一份；
> **新增结论请追加到离代码最近的那一份**。

## 🔴 陌生账号默认不建号（#226）

`plugin/oauth2` 原来对「库里对不上任何用户」的社交账号**无条件自动建号**：`is_staff=True`，角色取
`select(Role).where(启用)...first()` —— 没有 `ORDER BY`，挂到哪个角色取决于数据库物理行序。
插件默认启用、回调在免鉴权名单里，所以任何一个 GitHub / Google 账号走一遍就成了系统用户。

现在 `OAUTH2_AUTO_REGISTER` 默认 `False`（陌生账号 403、不建号）；打开时必须配 `OAUTH2_AUTO_REGISTER_ROLE`
（`sys_role.code`），找不到 / 停用就拒绝，**不退回别的角色**。绑定还在、用户被逻辑删除时也是 403，原来是 500。

⚠️ 写这类「两道检查前后挨着」的测试，要让**只有被测那一道**能拦住：第一版「开关关着要拒绝」那条没配角色，
去掉开关后紧接着的「角色未配置」也抛同一种异常，**变异检验照样全绿**。

**实测证据**：`plugin/oauth2/tests/test_auto_register.py` 5 条；三处变异（去掉开关 · 角色退回 `.first()` · 去掉删除用户的判空）各自当场红。

## 🔴 按邮箱关联已有用户，只认第三方验证过的邮箱（#227）

社交账号第一次进来、邮箱和某个已有用户相同，就把它绑到那个用户上并登录 —— 等于「谁能让 GitHub / Google
返回这个邮箱，谁就能登进那个账号」。原来没有任何验证判断，`fastapi_oauth20` 的 GitHub 客户端取不到 primary
时还会回落到 `emails[0]`。现在回调算出 `email_verified` 往下传（`utils.py`）：Google 看 `verified_email` /
`email_verified`，GitHub 自己再查一次 `/user/emails`，**同一个地址**且 `verified: true` 才算；查失败当没验证。
没验证的邮箱既不拿来关联，也不写进自动注册的新用户（否则真主人来关联时撞上的是陌生人建的号）。

⚠️ **会话工厂是 `autoflush=False`**（`database/db.py`）：`create_model` 只 `add` 不 `flush`，紧接着
`select` 查不到。第一版「没验证就不该有绑定行」那条断言因此**永远成立**；对照组（验证过的应该有）反而红了才暴露。
断言「有 / 没有某一行」之前先 `await db.flush()`。

⚠️ 关联之后是开会话（要真 request / cookie / 全局 Redis 客户端），pytest 里全局 Redis 绑在别的事件循环上会
`attached to a different loop`。测「关联到了谁」时把关联之后的
第一步（`password_security_service.peek_lock_reason`）打桩成抛哨兵异常，异常里带上 user_id。

**实测证据**：`tests/test_verified_email.py` 13 条；变异 —— 去掉「没验证就不关联」→ 反面用例红；GitHub 判定
不看 `verified` → 两组参数红。⚠️ 第一次做第二个变异时 sed 没匹配上（ruff format 把那几行并成了一行），
测试「全绿」是因为代码根本没变 —— 变异之后先 `grep` 确认改动真的落了。

## 🔴 state 绑在发起授权的浏览器上：cookie 在后端 authorize 那一跳下发（#227 后半）

**症状**（修之前）：攻击者自己走一遍授权，把带着**自己** `code` + `state` 的回调地址发给受害者 → 受害者登进攻击者的账号，
之后上传的文件、填的数据都落进去（login CSRF）。state 只是 Redis 里的裸 UUID，回调只看「存在且没用过」。

**为什么不能在原来那个接口上设 cookie**：授权链接是前端 XHR 拿的，开发环境 `localhost:8888` → `127.0.0.1:8088` 是跨站
（`localhost` 和 `127.0.0.1` 不是同一个 site），桌面端 `app://local` 也是 —— 跨站 XHR 响应里的 `SameSite=Lax` cookie
浏览器**不保证**存下来、更不保证之后带上（推断，没在真浏览器里测过；同一类跨站问题让 refresh cookie 在桌面端走不通，
那条是实测过的，见 `packages/platform/src/api-client/client.ts`）。猜错的代价是全员第三方登录失效，所以不赌。

**修法**（`state_binding.py`）：`GET /oauth2/{github,google}` 和 `GET /oauth2/me/binding` 照旧返回一个字符串 URL，
但 URL 换成后端自己的 `GET /oauth2/{provider}/authorize` —— 顶层跳转，在这一跳上设 `fba_oauth2_state`
（HttpOnly · Lax · `Path=/api/v1/oauth2`）再 302 到第三方；回调的 `dependencies` 第一个就是 `require_state_cookie`，
对不上直接 403，**不去第三方换 token、不消耗 Redis 里的 state**。前端一行没改。

- ⚠️ **authorize 的地址从回调地址推出来**（`.../callback` → `.../authorize`），不要用 `request.url_for`：
  cookie 设在哪个 host，回调就必须打到哪个 host；反代后面 `url_for` 拿到的 host 可能和配置的回调地址不同，
  那样 cookie 永远带不回来，全员第三方登录 403
- ⚠️ **绑定还留着一个口子**：绑定 state 带 user_id，authorize 是顶层跳转、带不了 Bearer 头，核对不了登录态。
  现在绑定链接是**一次性 ticket**（第一个打开的浏览器认领），但攻击者把自己刚取到、还没打开的绑定链接
  在 3 分钟内骗受害者点开并授权，受害者的第三方账号仍会绑到攻击者名下。要堵死得让绑定入口能核对登录态
  （例如前端用表单 POST 把 access token 带过去）；桌面端怎么打开授权页没核实过，改之前先看那一边

**实测证据**：`tests/test_state_binding.py` 7 条（TestClient 真请求，换 token 那一步打桩成抛哨兵异常）；
三处变异 —— 回调去掉 `require_state_cookie` → 「没有 cookie」「别人的 state」两条红；认领不看 NX 结果 →
「ticket 只能用一次」红；authorize 不下发 cookie → 三条红。⚠️ **真浏览器 + 真 OAuth 应用还没跑过**：
顶层跳转能设 Lax cookie、回调能带上，是浏览器规范保证的行为，但这里没有亲眼看到过。

## 🔴 回调里的业务拒绝要 302 回前端，不能抛出去（v1.0.1 发版前评审）

**症状**：#226 之后，没绑定过的 GitHub / Google 账号第一次社交登录，浏览器停在 **API 域名**上一页裸 JSON
（`{"code":403,"msg":"这个 Github 账号还没有绑定系统用户…"}`），回不到前端、也没有返回入口。原来只有 state 出错这种边角路径才这样，
#226 把它变成了每个新用户的默认路径。

**根因**：回调是「第三方 → 后端」的顶层跳转，不是 XHR —— 异常走全局处理器渲染成 JSON，直接显示给人看。

**修法**：两个回调把 `login_or_binding` 包在 `try` 里，`errors.BaseExceptionError` 交给 `state_binding.callback_failed`：
302 到 `OAUTH2_FRONTEND_LOGIN_REDIRECT_URI?error=<文案>` 并清掉 state cookie；前端落地页 `routes/oauth2/callback.tsx` 显示原因。

- 🔴 **吞异常之前必须 `await db.rollback()`**：处理函数跑在依赖的 exit stack **里面**（fastapi 0.141 `routing.request_response`），
  异常被吞掉后 `CurrentSessionTransaction` 看到的是正常返回、照样 commit —— 抛错之前写了一半的东西会被提交
- ⚠️ 落地页**不能挂在 `_guest` 下面**：绑定失败也落到这里，发起绑定的人是已登录的，`_guest` 守卫会把他踢回工作台，错误被静默吞掉
- ⚠️ `dependencies` 里抛的（`require_state_cookie` 403、限流 429、换 token 失败）不经过这个 `try`，仍然是 JSON —— 那几条是攻击 / 异常路径，没改

**实测证据**：`tests/test_state_binding.py::test_rejected_login_goes_back_to_the_frontend_with_the_reason`（TestClient 真请求，
换 token / 拉用户信息打桩）；变异 —— github 回调的 `except` 改成 `except KeyboardInterrupt` → 当场红，响应体正是上面那页 403 JSON。
⚠️ 前端落地页的错误态只过了 typecheck / build，没在浏览器里点过。
