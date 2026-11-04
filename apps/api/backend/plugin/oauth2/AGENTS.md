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
