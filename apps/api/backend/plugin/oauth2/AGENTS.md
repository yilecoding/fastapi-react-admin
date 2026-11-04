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

**没修的一半**：`state` 没绑定到发起登录的浏览器（login CSRF）。开发环境前端 `localhost:8888` 跨站直连
`127.0.0.1:8088`，授权链接是 XHR 拿的；浏览器会不会存下跨站 XHR 响应里的 SameSite=Lax cookie、回调时带不带，
要真浏览器 + 真 OAuth 应用才验得了，猜错就是全员第三方登录失效。分析留在 #227。
