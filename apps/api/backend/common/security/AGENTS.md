# apps/api/backend/common/security —— 鉴权与数据权限

> 这份文件是 [`apps/api` 分册](../../../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的文件时才加载它。

```
rbac.py         权限码校验（DependsRBAC / RequestPermission）
permission.py   权限码的收集与匹配
data_scope.py   数据范围（行级过滤）—— 下面整份讲的就是它
jwt.py          token 签发与校验
```

⚠️ **权限码（能不能进这个接口）和数据范围（能看到哪些行）是两件事**，别混着改。下面这一整份是后者。

一条链：**角色 → 数据范围（`sys_data_scope`）→ 数据规则（`sys_data_rule`）→ 一个 WHERE 条件**，
拼装在 `common/security/permission.py: filter_data_permission()`。
用例在 `backend/app/admin/tests/api_v1/test_data_permission.py`（22 个真实账号，
每个账号一种配置，全部走 `/auth/login/swagger` + `GET /sys/depts` 断言可见集合）。

### 🔴 它是 fail-open 的：规则「落不到列上」= 完全不过滤

`filter_data_permission()` 遍历规则时，遇到下面任一情况就 `continue`，
一条条跳完之后 `where_list` 是空的 —— 返回的是 **`or_(1 == 1)`**，也就是**放行全部**：

| 情况 | 例子 |
|---|---|
| 字段在目标模型上不存在 | 种子里的「本部门数据权限」= `Dept.__dept_id__`，而 `__dept_id__` 解析成 `dept_id`，`sys_dept` **没有这一列** |
| 字段名拼错 | 建规则时后端**不校验** model/column 是否存在（`CreateDataRuleParam` 只有 `str`），前端那个框还允许手填 |
| 字段在 `DATA_PERMISSION_COLUMN_EXCLUDE` 里 | `id` / `created_time` / `sort` / `deleted…` |
| 规则打在别的模型上 | 规则是 `User.xxx`，而接口 `DataPermissionFilter(Dept)` |

对比之下，「开了过滤但一个数据范围都没配」返回的是 `or_(1 != 1)`（**一条都看不见**）。
同一个函数里两种相反的兜底，而**配错的那一种恰好是放行的那一种**：
一个名字叫「本部门数据权限」的范围，实际效果是「全部部门」，界面上没有任何提示。

要收紧的话改 `filter_data_permission()` 里那三处 `continue` —— 但那是产品决定
（现有配置会立刻从"能看"变成"看不见"），不是 bug 修复，所以**没有动**，只用
`test_rule_on_missing_column_fails_open` 等四条钉住了当前行为。

### 🔴 AND 组和 OR 组在**顶层是 OR** —— 一条 OR 规则能抬掉所有 AND 规则

```python
return or_(and_(*where_and_list), or_(*where_or_list))
```

配「`parent_id == RA`（AND，想收紧）」+「`status == 1`（OR）」，结果是**并集**不是交集，
那条 OR 规则把限制整个抬掉了。界面上这两个下拉都叫「运算符」，看不出会有这个后果。
实测：`test_or_rule_defeats_and_rule`。

### 多角色取**最宽**，不是取交集

`for role in request.user.roles: if role.status and not role.is_filter_scopes: return or_(1 == 1)`
—— 只要有一个启用角色勾了「不过滤数据权限」，其它角色配的限制**一条都不看**。
给人加角色是「加能力」，这里同时也在「减限制」。实测：`test_one_unfiltered_role_defeats_all_restrictive_roles`。

### 🔴 覆盖面：不是每个接口都挂了 `DataPermissionFilter`

`GET /sys/depts` 是最早接上的一个，后来 `GET /sys/users` 也接了
（`test_user_list_endpoint_is_filtered`）。**但覆盖面不是靠数一个固定数字来钉的**——
旧版本这里有一条 `test_data_permission_filter_is_wired_to_exactly_one_endpoint`
断言"全仓只有一个接口挂了 `DataPermissionFilter`"，覆盖面一扩大它就必然红，
本身是在记录缺口而不是校验行为。现在换成了
`test_every_crud_class_declares_its_data_scope_stance`：每个 DAO 类要么继承
`DataScopedCRUD`（默认过滤），要么显式写 `data_scope_enabled = False` 并说明理由，
"忘了想这件事"会红——这才是原来那个洞真正的成因。

`PUT/DELETE /sys/depts/{pk}`、文件、任务执行记录……这类写接口目前仍然全部无过滤，
所以配「仅本人数据权限」`__ALL__ + __created_by__` 时不要以为它作用于所有模型 ——
`__ALL__` 说的是「规则匹配哪些模型」，不是「过滤器挂在哪些接口上」。

### 🔴 GET 也要 RBAC——只挂 `DependsJwtAuth` 等于这条路由退出了鉴权（issue #30）

行级数据权限和接口级 RBAC 是两道**独立**的闸，`filter_data_permission` fail-open
不代表 `DependsRBAC` 也可以不挂。2026-08-26 之前，`GET /sys/users`、
`/sys/configs`（+`/all`）、`/sys/data-rules`（+`/all`）、`GET /sys/menus`、
`GET /monitors/redis`、`/logs/login`、`/logs/opera` 这批读接口**只有
`DependsJwtAuth`**，没有 `RequestPermission(...)`，也没有 `DependsRBAC`——
`rbac.py: rbac_verify` 对没声明权限标识的路由是直接 `return`（放行），
所以这不是漏配一个字符串，是这条路由整个退出了鉴权。实测：一个只绑「仪表盘」
菜单的账号，直接打 `GET /sys/users` 能拿到全量用户列表（含 email/phone/dept_id），
打 `GET /logs/opera` 能拿到全量操作日志（含别人的 trace_id/username/IP）。
`GET` 还额外免了 `is_staff` 校验（`method not in {GET, OPTIONS}` 那个判断），
读接口比写接口更容易被这类漏配放过。

`/monitors/redis` 那条更离谱：同一个 `/monitors` 前缀下 `/server`、`/sessions`
都是 `DependsSuperUser`，就它一条是 `DependsJwtAuth`——三条本来就该同一套门槛。

修法是给这批读接口补 `RequestPermission('xxx:list')` + `DependsRBAC`
（新权限码统一用 `:list` 后缀，跟现成的 `sys:file:list` 对齐，不是随手起的名字），
**同时必须在种子菜单里补上对应的权限锚点菜单、并挂到需要保留访问的角色上**——
光加校验不加种子授权，会把当前能用的页面全锁死，这正是 #30 的建议里特别提醒的坑。
补的时候顺带发现：`test_data_permission.py` 那张自建图（`dp` fixture）里的角色
一个菜单都没挂——以前用不上，因为它打的接口都没有 `DependsRBAC`；这次给
`/sys/users` 补上之后必须给每个建出来的角色都挂一份权限锚点菜单（`add_role()`
里统一处理），不然 `rbac_verify` 里"用户未分配菜单"那道更早的闸就先炸了。

🔴 **`test_permission_codes.py` 那三条三方对账测试抓不住"接口压根没声明权限码"
这类洞**——它们做的是"后端声明的权限码 vs 前端 vs 种子菜单"三边 diff，一条路由
如果从来没调用过 `RequestPermission(...)`，根本不会进入被比较的集合，不会有
任何差集，测试照样全绿。这类洞目前只能靠人工审计接口清单发现，同 `sys/depts`
那批写接口的裸奔状态一样——不是这次的范围，留作已知缺口。

🔴 **给一个通用读接口补权限码之前，先搜一遍谁在拿它当"只要登录就行"的旁路用。**
这条修完当场炸了一个：`packages/platform/src/pages/dev-sandbox/api.ts` 一直在打
`GET /sys/configs/all?type=DEV`，代码注释原话是"只要 `DependsJwtAuth`，所以任何
登录用户都读得到"——组件沙箱故意不挂业务权限码（`sandbox/components.tsx`：
"只要登录就能进，不挂业务权限码"），是因为它假设了这条读接口的旧门槛。
`/sys/configs/all` 补上 `sys:config:list` 之后，没有这个权限码的账号（这次新加的
8 个演示账号一个都没有）打组件沙箱直接吃 403——不是显示"沙箱已关闭"那条降级
文案（那条走的是 `readSandboxGate` 的正常分支），是 `useQuery` 的 `error` 分支，
`QueryError` 报接口出错。硬纪律 9 在这起事故里表现是"失败确实可见"，但可见
不等于对：用户看到的是一个跟真实原因（RBAC）毫不相关的报错页。
修法不是把 `sys:config:list` 加进 `RBAC_ROLE_MENU_EXCLUDE`——那会把整张参数
配置表（含邮件服务器地址这类真敏感字段）重新对所有登录用户开放，等于把
#30 刚堵上的洞挖回去。而是新开一条**只读 DEV 组、type 写死不接受入参**的
`GET /sys/configs/dev-sandbox-gate`，只挂 `DependsJwtAuth`——暴露面从"整张
配置表"缩到"两个布尔开关"，跟沙箱本来的设计初衷（"不碰业务数据"）对上号，
不是给旧漏洞开后门。**一般结论**：改一个被多处复用的通用接口的权限门槛前，
`grep` 一遍调用方，尤其是那些没有专属业务权限码、靠"反正只要登录就行"这个
隐含假设活着的旁路用途。

### 已修：三个让接口直接 500 的坑

- 🔴 **`UniversalStr` / `UniversalText` 必须显式写 `python_type`。**
  `TypeDecorator` **不会**把 `python_type` 转发给 `impl`，基类实现直接
  `raise NotImplementedError`。而 `filter_data_permission()` 要靠
  `table.columns[c].type.python_type` 做值类型转换 —— 于是**任何打在字符串列上的
  数据规则都让接口 500**（`Dept.code`、`Dept.name`、`User.username`…，
  也就是这个 fork 里几乎所有能写规则的文本列）。种子里的「部门编码等于 TEST」就是一条。
  实测：修之前 `test_eq` 等 5 条直接 `NotImplementedError` → 500。
  （`TimeZone` 早就显式写了一份，是同一个原因 —— 加新 `TypeDecorator` 时记得跟上）
- 🔴 **`${now}` 要放调用结果，不是函数对象。** 原来是 `'${now}': timezone.now`，
  `datetime(<function now>)` 抛 TypeError 被 `except` 吞掉，
  于是 `'${now}'` 这个**字面量**被拼进 SQL —— 规则不是不生效，是让接口 500
- 🔴 **模板变量解析不出值时要 fail-closed，不能把字面量塞进 SQL。**
  用户没有部门时 `${dept_id}` 是 None，`int(None)` 同样被吞，
  `WHERE parent_id = '${dept_id}'` 实测报
  `Error converting data type varchar to bigint (8114)` → 500。
  现在解析失败的规则编译成 `false()`（看不见），不是放行、也不是崩

### ⚠️ 写数据权限测试：JWT 用户解析**不走**依赖注入

`jwt.get_jwt_user()` 里直接用了 `backend.database.db.async_db_session`（**开发库
`fba`**），而 `conftest.py` 只重载了接口层的 `get_db`（→ `fba_test`）。
现有用例从没暴露这条，是因为它们只用 admin，而 `fba` 和 `fba_test` 是同一份种子
建出来的、admin 的雪花 ID 完全相同。**只存在于测试库里的用户会登录成功、
第一个请求就 `TokenError`** —— 必须把 `jwt_module.async_db_session` 也换掉
（见 `test_data_permission.py` 的 `dp` fixture）。

另外那份 fixture 是**自己建图自己拆**（5 个部门 / 16 条规则 / 17 个范围 /
19 个角色 / 22 个用户，每次跑带一个随机后缀），不依赖种子数据，
teardown 里按 id 硬删干净 —— 因为 `fba_test` 同时也是 Playwright E2E 的库。

## refresh cookie：`max_age` 和 `expires` 必须同源

`set_cookie` 可以同时给 `max_age` 和 `expires`。三个调用点（`/auth/login`、
`/auth/token/new`、oauth2 回调）原来各写一遍，`max_age` 取一个**独立配置**
`COOKIE_REFRESH_TOKEN_EXPIRE_SECONDS`、`expires` 取 refresh token 的真实过期
时间 —— 两个值可以配不一致，而**按 RFC 6265 §5.3，`Max-Age` 优先于
`Expires`**，所以赢的是那个可能配错的。

实测（把那个配置改成 60、refresh token 保持 604800）同一个响应头：

```
Set-Cookie: fba_refresh_token=...; expires=Wed, 09 Sep 2026 20:36:40 GMT;
            HttpOnly; Max-Age=60; Path=/; SameSite=lax
```

浏览器 60 秒后丢掉 cookie，而服务端那份 refresh token 还有 7 天 ——
**静默早退，服务端完全观察不到**：Redis 里 token 还在、日志里什么都没有，
用户只是「又被登出了」。

🔴 **修法是消掉重复的真相源，不是加校验。** 那个配置删了，`max_age` 直接用
`TOKEN_REFRESH_EXPIRE_SECONDS`，和 `expires` 同源。三处收成
`common/security/jwt.py: set_refresh_cookie()` —— 各写一遍迟早有一处不一样
（和 `file_ops.upload_root` 同一个理由）。

实测确认：只改 `TOKEN_REFRESH_EXPIRE_SECONDS=120`，`Max-Age=120` 和 `expires`
（当前时间 +120 秒）**一起动**。

## refresh token 必须活得比 access token 长

这条**消不掉**（两个本来就独立的时长），只能校验。refresh 不长于 access 时，
该续期的时候续期凭据也死了 —— 用户在 access 过期那一刻被硬登出、「记住我」
形同虚设。症状是「所有人整整 N 天后一起被登出，怎么都续不上」，
而两个值单看都合理（典型走法：把 access 调到 7 天做「免登录一周」，
忘了 refresh 也是 7 天）。

`_check_token_lifetimes()` 拦这个，判据是 `>` 而**不是 `>=`** ——
相等时刷新窗口是 0，后果和「refresh 更短」一模一样。两条守卫测试
（更短 / 相等），双向验证过。
