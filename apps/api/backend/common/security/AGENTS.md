# apps/api/backend/common/security —— 鉴权与数据权限

> 这份文件是 [`apps/api/backend/common` 分册](../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的
> 文件时才把它加载进上下文（惰性加载）。跨模块的硬纪律只在根 `CLAUDE.md` 里有一份；
> **新增结论请追加到离代码最近的那一份**。

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

## 登录会话（#138）：`session.py`

一次登录 = 一个会话，**会话 ID 从登录到结束不变**。存储形状、轮换规则、两道上限写在
`session.py` 的模块注释里，这里只记「违反了会坏」的那几条。改会话相关的代码前先读这一节。

```
session.py   会话的全部读写（建 / 轮换 / 核对 / 撤销 / 列表），Lua 原子脚本
jwt.py       只签 access token、下发 / 清除 refresh cookie、每个请求调 session_store.check
```

### 🔴 撤销只走 `session_store.revoke` / `revoke_user`

#138 之前有 7 个文件各自 `delete_by_prefix` 删 token key，其中「多端登录」开关改别人时只删了
access 不删 refresh —— 被踢的人刷新一下就回来了（同 `apps/api` 分册「撤销一个会话 = 删三个 key」那次）。
现在会话只有一个 key，撤销函数顺手写原因、推 socket、断连接。**新增「让某人下线」的入口时
调这两个函数，不要自己删 `fba:session*`。**

### 🔴 空闲按「人有没有在操作」算，不按请求算

后台轮询（在线用户页 10 秒一次、监控页、审批 AI 预审、导出任务）会让「按请求算」的空闲超时
**永远不过期** —— 人走开了、浏览器开着，正是等保要防的那个场景。ContiNew 4.2 的 `active_timeout`
就是这么被绕过去的（读源码，没跑）。

客户端每个请求带 `X-Client-Idle: 距上次键盘 / 鼠标 / 触屏操作的秒数`（`jwt_auth_middleware.client_idle`），
服务端据此推算最后活跃时间，最多每分钟写一次。不带这个头的端（移动端、桌面主进程）按刚操作过算。
socket 握手不算操作（`touch=False`）。

🔴 **判空闲只看记录下来的最后活跃，自报值只决定「这次算不算一次活跃」。** 第一版是反过来的
（先拿自报值往后挪，再判空闲）：人走开三小时、回来点一下，那个请求报「0 秒没操作」，会话就被续上了 ——
空闲超时只在「中途恰好有一次后台轮询暴露了空闲」时才生效。顺序换过来之后，**看页面不发请求的人**
会被误判，所以前端在用户最近 5 分钟有操作时每 5 分钟打一次 `POST /auth/heartbeat`
（`platform/src/auth/activity.ts`）。

**实测证据**：`test_session.py` 的 `test_background_polling_does_not_keep_the_session_alive`
（带 `X-Client-Idle: 3600` 的请求不挪最后活跃时间）· 反方向的 `test_user_activity_moves_last_active_forward` ·
`test_coming_back_after_the_idle_limit_does_not_revive_the_session` · `test_heartbeat_keeps_a_reading_user_alive`；
变异检验：把 `active = max(…)` 改成 `active = now`，第一条红；把判空闲挪回自报值之后，第三条红。

⚠️ **压根没带 refresh cookie 的刷新不给原因码**（`rotate(None)` 只回 401）：页面加载时守卫会先静默恢复，
第一次打开页面的人也会走到这里 —— 带上 `expired` 的话，登录页上会对一个从没登录过的人说「登录已过期」
（`test_refresh_without_any_cookie_has_no_reason`，变异检验打红过）。

### 🔴 宽限期不能短于客户端刷新超时；对不上的 secret 不撤销

- 宽限期内再出示上一代 refresh token → 回放**同一组**新令牌（多标签页同时刷新、弱网重试都靠它）；
  宽限期外再出示 → 判盗用、撤销整个会话（`reuse`）。宽限期短于客户端超时的话，响应丢了之后的重试
  会被当成盗用 —— ContiNew admin 把 starter 默认的 30 秒改成 5 秒就是这个坑（读源码）。
  `_check_session_settings` 在 prod 拦 10 秒以下；前端刷新请求要配 10 秒超时（PR 2）
- 出示的 secret 和会话对不上 → 只回 401，**不撤销**：会话 ID 写在 cookie 里、日志里都看得见，
  凭它就能把人踢下线是送上门的 DoS。登出 / 同浏览器重登按 cookie 认会话时同理，要 secret 对得上
  （`owner_of`）

**实测证据**：`test_previous_token_within_grace_replays_the_same_pair` · `…_after_grace_revokes_the_whole_session` ·
`test_unknown_secret_with_a_real_session_id_does_not_revoke`，三条各做过一次变异（不回放 / 期外不撤销 /
对不上也撤销），都当场红。#138 之前的行为（并发刷新一个 200 一个 401）见 issue 正文 T4。

### 🔴 本仓库的 `StrEnum` 用 `str()` / f-string 得到的是 `EndReason.idle`，不是 `idle`

`common/enums.py` 的 `StrEnum` 是 `(str, Enum)` 那种老写法。往 Redis 写、拼 i18n key 时直接
`str(reason)` / `f'...{reason}'`，写进去的是 `EndReason.idle`：回头查结束原因对不上、退回成
笼统的「到期」，文案 key 拼成 `error.session.EndReason.expired`、界面上显示的就是那串 key。
`session.py` 在边界上统一走 `_plain()`（取 `.value`）。**实测证据**：第一版没有 `_plain`，
`test_idle_session_ends_with_reason_idle` 红在 `assert 'expired' == 'idle'`，日志里是
`请求异常: error.session.EndReason.expired`。（比较 `==` 不受影响 —— 它比的是 value，所以只有落地 / 拼接时才露馅）

### 🔴 refresh cookie 换了 Path，旧的那个必须显式清掉

cookie 现在只发往 `/api/v1/auth`（`COOKIE_REFRESH_TOKEN_PATH`）。#138 之前是 `Path=/`。
升级后浏览器里两个同名 cookie 并存，访问刷新接口时都带上（路径长的排前面），而 Starlette 解析
Cookie 头时**后出现的覆盖先出现的** —— 赢的是旧的、早已失效的那个，于是每次刷新都 401，
用户每 30 分钟被登出一次，持续到旧 cookie 过期（最长 7 天）。所以登录 / 刷新 / 登出的响应都带一行
`Path=/` 的删除（`_clear_legacy_refresh_cookie`）。

⚠️ 那一行要排在真正下发的 cookie **后面**：桌面端主进程按名字取第一个 Set-Cookie
（`apps/desktop/src/main/auth.ts: extractRefreshCookie`）。

**实测证据**：`Request` 收到 `fba_refresh_token=NEW-path-api-v1-auth; fba_refresh_token=OLD-path-root`，
`request.cookies` 取到的是 `OLD-path-root`（2026-10-23，starlette 随 fastapi 0.141.1）。
这一行还曾被操作日志中间件吞掉（`dict(response.headers)` 把同名头压成一个），见 [`middleware` 分册](../../middleware/AGENTS.md)。

### `max_age` 和 `expires` 同源 · `Secure` 跟着请求走

- `max_age` / `expires` 都来自会话的**绝对到期**（`set_refresh_cookie`）。#138 之前曾有一个独立配置
  `COOKIE_REFRESH_TOKEN_EXPIRE_SECONDS` 给 `max_age`，而 RFC 6265 §5.3 下 `Max-Age` 优先 ——
  配得不一致时浏览器提前丢 cookie、服务端会话还在，静默早退（当时实测过 `Max-Age=60` 与 7 天的 `expires` 并存）
- `COOKIE_SECURE = None` = HTTPS 请求带 `Secure`、HTTP 不带。写死 `True` 的话没上 HTTPS 的部署里
  浏览器不存这个 cookie，每 30 分钟被登出一次、日志里什么都没有。前面有反代终结 TLS、却把
  `X-Forwarded-Proto` 改写成 `http` 的部署，`request.url.scheme` 会是 `http` —— 那种情况显式配 `COOKIE_SECURE=true`。
  `test_refresh_cookie_attributes` / `test_plain_http_does_not_get_a_secure_cookie` 两个方向各一条

### ⚠️ Lua 脚本按前缀拼 key —— 假设 Redis 是单实例

准入 / 轮换 / 续活跃 / 撤销都是一段 `EVAL`，脚本里从 `ARGV` 的前缀拼出要碰的 key（用户索引要先读会话里的 uid
才知道是哪个），没有在 `KEYS` 里声明。单实例 Redis 上没问题；Redis Cluster 要求脚本碰的 key 都声明过、
且落在同一个 slot —— 这一点**没在 Cluster 上实测过**，到那天要给同一用户的 key 加 `{uid}` hash tag、
会话 key 带上 uid、改成显式传 `KEYS`。

## 🔴 「非展示的读」必须 `bypass_data_scope()` —— 否则受限用户会自锁

`bypass_data_scope()` 的注释写着它给「请求上下文里的系统内部读」用，
理由是「这些读的目的不是把数据展示给用户，按可见范围过滤没有意义，
而且会自锁」。**这条纪律有两处漏了，都是实测踩出来的。**

前提：种子里的 `STAFF` 角色是 `is_filter_scopes=True` 但**一个数据范围都没配**
—— 而那种组合是 fail-closed（`filter_data_permission_for_user` 里
`if not data_rules: return or_(1 != 1)`）。也就是说这种用户**看不见自己**。

| 漏的地方 | 实测表现 |
|---|---|
| `update_password` 先 `user_dao.get()` 验旧密码 | **500** `AttributeError: 'NoneType' object has no attribute 'password'` |
| `update_email` 用 `check_email()` 查唯一性 | 邮箱被**看不见的人**占着时冲突检查静默通过 → 撞唯一索引 `uk_sys_user_email_deleted` → 500（正确应是 409） |

⚠️ 只有改密码那一条炸：`/users/me`、`/me/nickname`、`/me/avatar` 实测都是 200，
因为只有改密码**先 `get()` 了一次**。所以这个 bug 的可见面极窄 ——
一个受限用户想改自己的密码，拿到 500，而管理员自己（超管豁免）永远复现不了。

### 那 25 处后来逐个核实了，7 个方法要豁免

先按 DAO 分类：**豁免清单里的那批压根没这个问题**（`CRUDMenu` / `CRUDConfig` /
`CRUDDictType` / `CRUDDictData` / `CRUDDataRule` / `CRUDDataScope` /
`CRUDNotification` / `CRUDUserSocial` / `CRUDUserPasswordHistory` 都写着
`data_scope_enabled = False`）。25 处里大半自动出局，真正 scoped 的只有
dept / role / user / notice / file 这几个。

逐个核实调用方之后，7 个方法在**方法内部**加了 `bypass_data_scope()`：

| 方法 | 调用方（全是非展示读） |
|---|---|
| `user_dao.get_by_username` | 登录 · OAuth2 查号 · 建/改用户的冲突检查 · CLI |
| `user_dao.check_email` | 改邮箱 / 建用户的冲突检查 |
| `dept_dao.get_by_code` · `get_sibling_by_name` | 建/改部门的冲突检查 |
| `dept_dao.get_children` | 删部门前「还有没有子部门」的业务规则检查 |
| `role_dao.get_by_code` · `get_by_name` | 建/改角色的冲突检查 |

⚠️ **写在方法内部而不是调用点**：这些方法**只**服务于检查和认证，没有一个
把结果展示给用户。逐个调用点包的话，下一个新调用点会漏 ——
而漏的表现是静默的 500。

⚠️ **种子配置下这个 bug 走不到**：四个非超管演示角色一个写权限都没有
（实测 `:add`/`:edit`/`:del` 全为 0），而要触发冲突检查得先有写权限。
但这是个底座 —— 数据范围功能的用途就是做「区域管理员」（写权限 + 部门范围），
第一个这么配的人就会踩到。守卫测试自己造那个配置
（`set_current_user` + `SimpleNamespace`），不依赖种子里恰好有没有。

## 🔴 没有权限门禁的端点，绝不能挂 scoped 的 DAO

这两件事单独都合理，**撞在一起就是「界面静默变空」**：

- 端点只挂 `DependsJwtAuth`（所有登录用户可读）
- 它读的 DAO 是 `DataScopedCRUD`（默认过滤，而「开了过滤没配范围」是 fail-closed）

结果是那个用户**永远**看不到任何行 —— 而且没有任何办法给他授权，
因为他缺的不是权限码，是数据范围，而那个模型可能压根没有可过滤的维度。

实测样本：公告。`GET /sys/notices` 只挂 `DependsJwtAuth`（给所有人看公告，
仪表盘还拿它做统计卡），而 `CRUDNotice` 默默继承了默认值。
超管看到 3 条，STAFF 用户看到 **0 条** —— HTTP 200、空列表、无任何提示。
而 `sys_notice` 只有 `id / title / type / status / content`，
没有 `dept_id` 也没有 `created_by`：规则想表达「某部门才看得到某公告」
压根表达不了，所以过滤在这里**只有 fail-closed 一种效果**。已豁免。

⚠️ **反过来，有权限门禁的端点是安全的** —— 实测 `/logs/login`、`/logs/opera`、
`/sys/files` 对受限用户都是 **403**（缺 `log:login:list` 那些码），
请求在 RBAC 那层就被拒了，压根到不了 DAO。所以这个坑的范围很精确：
**「无权限码 + scoped DAO」那一小撮**。

⚠️ 排查时容易误报的一条：`/auth/codes` 对 STAFF 返回 0 条，看着像同一个 bug ——
但那是**对的**，STAFF 那三个菜单一个 `perms` 都没有（实测）。
「受限用户看到的少」不等于「被错误地过滤了」。

## 🔴 停用的菜单按上级算 —— 快照里的 `status` 是生效状态（#143）

**症状**（修之前）：停用一个目录，接口 200，而侧边栏照常显示、下面按钮的权限码照常生效 —— 等于没停。
权限码是逐个菜单算的，五处判定（`rbac_verify` · `collect_allowed_perms` · `/auth/codes` · 文件 `_has_perm` ·
审批 `Actor.from_user`）都只看菜单**自己**的 `status`，而目录 / 页面大多不带权限码。

**现在**：一个菜单生效 = 它和每一级上级都启用（`menu_dao.get_disabled_ids`）。落在三处，各有理由：

| 哪里 | 怎么做 | 为什么在这 |
|---|---|---|
| `jwt.get_jwt_user` 建快照时 | 把停用那一枝的菜单 `status` 改写成 0 | 上面五处全读快照，换一次全都对了，不用逐处改 |
| `auth_service.get_codes` 的超管分支 | 用 `get_disabled_ids` 滤 | 超管那一支直接查库，不读快照 |
| `menu_service.get_sidebar` | 整枝不下发 | 只去掉某一项会留下孤儿，被 `traversal_to_tree` 提到顶层 |

- 🔴 **新写「从库里查菜单算权限码」的代码，要过 `get_disabled_ids`**，不能只看 `menu.status`。只看自己的话停用目录对它不生效，
  而别处都生效了 —— 同一个人在这条路上有权限、在界面上没有，不报错
- 🔴 **改菜单要清整棵下级持有者的快照**（`menu_service.update` → `get_subtree_ids`）。只清「持有这一项的人」不够：
  角色可以只有页面和按钮、没有它们的目录（接口允许这么授），停用目录时这些人的快照不清，权限要等 token 过期才失效
- ⚠️ 只写目录自己那一行，不往下级写 —— 下级自己的状态保留着，重新启用目录就整棵原样回来

**实测证据**：`app/admin/tests/api_v1/test_menu_disable.py`（变异记录见 [`pages/menu` 分册](../../../../../packages/platform/src/pages/menu/AGENTS.md)「三处『改了、保存成功、界面不变』」）。
