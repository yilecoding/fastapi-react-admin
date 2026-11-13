# backend/app/admin —— 后台管理模块

> 这份文件是 [`apps/api/AGENTS.md`](../../../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的文件时才加载。
> 跨模块的硬纪律仍然只在根 `CLAUDE.md` 里有一份。

## 用户快照：刷新身份查询与提交后清理（#313）

🔴 **受限用户带有效 Bearer 调 `/auth/refresh`，会误报「账号已停用」并撤销会话。**
中间件已设置数据范围上下文，而 `refresh_token` 的 `user_dao.get` 会应用范围过滤；
STAFF 这类「启用过滤、没有规则」的用户连自己也查不到。认证身份查询必须在调用点包
`bypass_data_scope()`，保留 DAO 在用户详情等展示路径上的过滤。

🔴 **降权接口返回成功，旧超管 / staff 权限仍可能在 Redis 快照里存活 30 分钟。**
`user_service` 在写事务里直接删快照，并发请求可把提交前的旧行重新缓存。各用户编辑入口
统一传入 `BackgroundTasks`、调用 `user_cache_manager.clear`；`CurrentSessionTransaction` 的
`scope='function'` 保证先提交，再执行成功响应上的后台清理，回滚时不清。

**实测证据**：`tests/api_v1/test_user_snapshot.py`，真实 SQL Server + Redis：修复前带 Bearer 刷新为
401 `reason=disabled`；在提交前暂停写请求、让另一请求回填旧权限，提交后超管 / staff 仍为 True；
回滚昵称编辑也会提前删快照。修复后上述场景通过。测试先读出旧行、再延迟 Redis 回填，不依赖 SQL Server
是否开启 `READ_COMMITTED_SNAPSHOT`，也不靠 sleep 碰运气。

## 批量建号：不要循环调 `user_service.create()`

`crud_user.add()` 每建一个用户都跑一次 `bcrypt.gensalt()` + `get_hash_password()`，
而那是**同步**调用。实测（8 核）：

| 做法 | 87 行 |
|---|---|
| 串行（= 循环调 `create()`） | **16.75 s** |
| 线程池 4 / 8 并发 | 4.31 s / 2.32 s（bcrypt 会释放 GIL，实测 7.2×） |
| 整批共用一次 hash | **0.19 s** |

🔴 **16.7 秒不是「这个请求慢」，是整个事件循环被占住** —— 所有人的所有请求
一起停 16.7 秒，而日志里只会看到一片莫名其妙的慢请求，没有一条指向 bcrypt。
`crud_user.bulk_add()` 整批只算一次 hash。

⚠️ 代价是这批用户在库里是**同一个 hash + 同一个 salt**。他们本来就共用同一个
默认密码，所以泄露的信息只有「这几个人密码相同」，而那本来就是真的；
任何人改一次密码，`reset_password()` 会重新 `gensalt()`。

## 用户批量导入（`POST /sys/users/import/{preview,commit}`）

两阶段：预览只校验不落库 + 一个存 Redis 的短期 token；提交带 token、允许部分成功。
现在是通用导入框架的一个资源（定义在 `app/admin/dataio.py` 的 `USER_IMPORT`），框架那一层的坑
（令牌、文件内重复、提交前重新校验、错误报告）见 [`common/dataio` 分册](../../common/dataio/AGENTS.md)；
下面只记**建号**这一侧独有的。
解析走 [`utils/excel_ops.py`](#上传的表格一律过-utilsexcel_opspy不要自己-load_workbook)。

- 🔴 **明文密码在整条链路上一次都不出现**：模板里没有密码列（一律用系统默认
  密码 `USER_IMPORT_DEFAULT_PASSWORD`），请求、响应、Redis 里也都没有。
  理由是 `opera_log_middleware` 会把 JSON 响应体写进 `sys_opera_log.response_body`
  —— 把生成的密码放进响应 = 永久写进日志表，而那张表有自己的查看权限
- 🔴 **默认密码放 `.env` 不放 `sys_config`**。那张表在库里是明文；#283 之前 `PUT /sys/configs` 的请求体
  还原样进操作日志（现在键名像密钥的行会打码，见 [`middleware` 分册](../../middleware/AGENTS.md)）
- 🔴 **默认密码必须自己过 `validate_password_strength()`**。`123456` 过不了
  （`is_has_letter`）。不校验的失败是**延迟且分裂**的：导入成功、用户能登录，
  但他改密码时被「必须含字母」挡住，两件事看不出是同一个原因。空串 = 功能关闭，
  **不给内置兜底值**（内置值会跟着仓库公开，而每套部署都会照抄）
- 🔴 **重复要查两个维度**。库里没有、文件里有两行同名时，逐行对着库查**全都通过**，
  然后在提交阶段撞唯一约束 —— 而那时第一行已经落库了
- 🔴 **提交前先删 token**。不删的话重放一次就是重复建号：第二次撞唯一约束报
  「导入失败」，而库里已经多了第一批人
- ⚠️ **导入路由必须声明在 `GET /{pk}` 之前**。现在是两段路径（`/import/xxx`）撞不上，
  但以后加一条**一段**的放在后面就会被吞掉，表现是 `422 pk 不是合法整数`，
  看着像参数写错了
- ⚠️ **没有强制首次改密的机制**。`last_password_changed_time` 建号时就是当下，
  所以导入的账号在 `USER_PASSWORD_EXPIRY_DAYS`（默认 365 天）内不会被要求改掉默认密码

## 手机号：唯一约束 + 「本人验证过」才算数（issue #168）

`sys_user.phone` 有唯一约束 `uk_sys_user_phone_deleted`（形状同 email：`(phone, deleted)`，SQL Server 走筛选唯一索引让 NULL 互不冲突），
所以**三条管理员写路径都要先查重**：`user_service.create` / `update`（`user_dao.check_phone`，豁免数据范围的理由同 `check_email`）、
批量导入（`dataio._user_validate` 文件内 + 库内两维，同邮箱）。漏一条的表现是 IntegrityError → 500，而不是干净的 409。

🔴 **`phone_verified_time` 为空 = 管理员录入 / 导入的，没经过本人验证 —— 这种号不能用来登录。** 打错一位，号码的主人就能登进别人的账号。
只有本人在个人中心用验证码绑定（`PUT /sys/users/me/phone`）才写这个时间；**管理员改了号码就清掉它**（`user_service.update` 里
`'phone' in obj.model_fields_set and obj.phone != user.phone` 那一句），否则「验证」会跟着一个换过的号继续算数。
⚠️ 判据要看 `model_fields_set`：`UpdateUserParam.phone` 可选、落库 `exclude_unset`，请求体不带 phone 时号码原样不动，
只比 `obj.phone != user.phone` 会把验证静默清掉（号没变、手机登录失效，界面上看不出）。

🔴 登录参数里的短信验证码字段叫 `captcha`，不叫 `code`：`captcha` 在 `OPERA_LOG_REDACT_KEYS` 里，`code` 是字典 / 部门编码的通用键名，不能整个脱。

**实测证据**：`tests/api_v1/test_user_phone_unique.py` —— 新建 / 编辑撞号 409、空号互不冲突、管理员改号后 `phone_verified_time` 变空、
导入文件内两行同号第二行红 + 库里已有的号那一行红。迁移 `aa000000userphone` 在开发库 up → down → up 验过，加约束前先查重、有重复就报出是哪几个号。

## 手机验证码登录（`auth_service.send_phone_captcha` / `phone_login`，issue #168 第二步）

两个匿名接口 `/auth/phone/captcha` · `/auth/phone/login`（都在 `TOKEN_REQUEST_PATH_EXCLUDE`，精确匹配）。
只认 `phone_verified_time` 非空的号（上一节）。

🔴 **发码接口对「没注册 / 没验证 / 验证过」三种号的表现必须一致，只有第三种真发。** 一致的维度有四个，漏哪个都是一张号码核对器：

| 维度 | 怎么做到一致 |
|---|---|
| 状态码 / 文案 | 不发的那两种也返回 200「成功」 |
| 冷却 / 日上限 | 短信插件自己的防护只作用在真发了的号上，没注册的号永远不会「太频繁」→ 在决定发不发**之前**先用 `_PHONE_GUARD`（一段 Lua）按 `captcha` 模板同样的口径记一笔 |
| 耗时 | 真发要等厂商几百毫秒，不发的那条随机睡 0.3～0.8 秒 |
| 图形验证码 | 开着时两种号都要过（否则这个匿名接口就是免费的短信轰炸入口） |
| 厂商侧失败 | 只有真发的号会撞上厂商超时 / 没配置 / 熔断，照抛 502 就是故障期间的核对器 → 吞成 200 + error 日志，冷却不退。插件判的「太频繁」放行（和 `_PHONE_GUARD` 同一句 400；刚绑完号就来登录是常见流程，吞掉要白等 5 分钟）。绑定那条路不吞（已登录，硬纪律 9） |

🔴 **图形验证码比对之前就消费，答错也作废（#229）。** `_verify_graphical_captcha` 原来只在答对时删 key，同一张图在 5 分钟里
能反复猜，每次只花一次登录限流的配额 —— 而它也是上面这个匿名发码接口的那道门。前端答错后本来就换图（`shouldReloadCaptcha`）。
**实测证据**：`tests/test_captcha_consume.py`（字典打桩 Redis）；把删除挪回比对之后，「答错后再答对只能拿到已过期」那条红。

登录接口：没注册 / 没验证 / 码错 / 码过期一律「手机号或验证码有误」+ 403；锁定原因**码对了才说**（同 `user_verify` 的顺序）。
IP 锁定、停用 / 锁定判定、密码过期、成败计数、登录日志逐条照 `user_verify` 做，验证码替代的只是「密码对不对」那一步；
开会话那段抽成了 `_open_session`，两种登录共用。登录日志里对不上账号的那次记**掩码号**，不留明文号码表。

**实测证据**：`plugin/sms/tests/test_phone_login.py` —— 没注册的号 200 且 Redis 无码且耗时 ≥ 250ms；
没注册 / 没验证两种号第二次都是同一句 400；码错 / 没注册 / 管理员录的号拿着对的码三者 403 同文案；对的码开会话一次、cookie 下发、第二次 403。

## 已经删掉的东西，不要照上游加回来

`sys_menu` 的两列已从**模型、DTO、种子 SQL 和数据库**里彻底删除：

| 列 | 上游的用途 | 为什么这里不需要 |
|---|---|---|
| `component` | Vue 运行时动态路由的组件路径 | 前端是编译期文件路由，`page-registry.tsx` 按 routeId 挂载 |
| `cache` | Vben `<KeepAlive>` 的 per-page 开关 | `TabOutlet` 用 `<Activity>` 一律保活，没有 per-page 概念 |

侧边栏也不再下发 `meta.keepAlive`（`utils/build_tree.py`）。

> 想给某一页关掉保活时**不要复活这个字段**，直接在 `TabOutlet` 里判断。
> 另外记住 `update` 走 `model_dump(exclude_unset=True)`：前端不传的字段不会被写 ——
> 这条在「前端删字段」时是好事（不会静默重置老数据），但要归一老值就得显式传一次。

## 二次验证（MFA，#181）：TOTP 动态码 + 一次性恢复码

`utils/totp.py`（RFC 6238，SHA1 / 30 秒 / 6 位，自己实现、不引依赖）· `service/mfa_service.py` · 表 `sys_user_mfa`（迁移 `ad000000usermfa`）。
三条登录路径（密码 / 手机验证码 / 第三方）在「身份确认」之后、「开会话」之前过 `mfa_service.gate()`：需要第二步就返回
`MfaChallenge`（Redis 一次性令牌，5 分钟，最多试 5 次），**不开会话、不下发 refresh cookie、不记成功日志**。

- 🔴 **「密码对了」不再清零失败计数**（`user_verify` 里那一句挪到了 `mark_login_success`，真正放行时才调）。原来密码一对就清零：
  有密码的人每登一次试 5 次动态码、登完又清零，等于可以无限试 6 位数。动态码错算进同一个账号的失败计数，满了按密码错的规则锁定
- 🔴 **同一个时间片的码只能用一次**（RFC 6238 5.2，`sys_user_mfa.last_step`）。不记的话被人从肩后看到的那 6 位数在 30～90 秒内还能再登一次
- 🔴 **绑定要扫完码再输一次码才算开启**：密钥先放 Redis，确认了才落库。只扫不确认就算开启的话，认证器没存上就把自己锁在外面
- 🔴 **Swagger 调试口拒绝 MFA 账号**（HTTP Basic 做不了第二步；这个口只在非 prod 注册）
- 🔴 **字段名都起成专用的**（`otp` / `totp_secret` / `otpauth_uri` / `recovery_codes` / `mfa_token`）并进了 `OPERA_LOG_REDACT_KEYS`：
  叫 `code` / `secret` 的话脱不掉（`code` 是部门 / 字典编码的通用键）
- 强制策略 `LOGIN_MFA_ENFORCE`（off / superuser / all）在参数配置「登录策略」组。**`gate` 自己不加载登录配置**，三条登录路径各自
  `load_login_config` —— 测试要能把策略钉住（`no_captcha` 夹具顶掉的是 auth_service 里那个名字）
- 没配 `MFA_SECRET_KEY` 时：开不了（`setup` 报错说明原因）、写入侧不许把策略改成强制（`check_dynamic_dependency`）；
  策略已经是强制、密钥后来被拿掉的兜底是 `is_enforced` 返回 False + error 日志（fail-open —— fail-closed 的话被强制的人一个都登不进来）

### 🔴 参数配置的值校验原来挂在读写共用的基类上 —— 库里一个不合格的值就让整个列表 500

`plugin/config/schema/config.py` 的范围 / 固定取值检查原来写在 `ConfigSchemaBase` 上，而 `GetConfigDetail`（读列表的那个）也继承它。
库里只要有一个不合格的值（直接改库 / 范围后来收紧了 / 依赖运行时环境变量的检查不再成立），**参数配置列表 500，管理员连在界面上改回去都做不到**。
MFA 这条依赖检查第一次就踩到了：变异检验时 `all` 被真写进了 `fba_test`，下一轮整个配置列表 `ResponseValidationError`。
现在校验只挂在写入的三个参数模型上（`_WriteChecked`），读路径不校验；读取侧的回落在 `load_config` 里本来就有。

**实测证据**：`tests/test_totp.py`（RFC 6238 附录 B 的 SHA1 向量 6 组全对 + 重放 / 窗口 / 格式）· `tests/api_v1/test_mfa.py` 14 条 ·
`plugin/sms/tests/test_phone_login.py::test_two_factor_applies_to_phone_login_too` · E2E `mfa.spec.ts`。
变异各有测试变红：密码 / 手机登录不过 gate · 不防重放 · 恢复码不标记已用 · 密码对了就清零 · 失败不计入账号 · 被强制也能关 ·
没密钥也能改成强制 · Swagger 不拦 · 恢复码不脱敏 · 绑定令牌能拿来验证 · 读路径也校验 · 前端忽略挑战直接当登录成功（E2E）。
迁移 `ad000000usermfa`：PostgreSQL 在开发库副本上 up → down → up（表和参数行都在 / 都没 / 都在）；SQL Server 在 `fba_test` 上 down → up 两轮，主键 `sys.identity_columns` 0 行。**没验过**：第三方登录真走一遍（要 GitHub / Google 的回调）、
打包出来的桌面端、真机上的移动端（只过了 typecheck）。

## 个人偏好（`GET / PUT /sys/users/me/preferences/{key}`，#202）

表 `sys_user_preference`（迁移 `ah000000userpref`）：`(user_id, key)` 唯一，`value` 是 JSON **文本**（不用三方言各不相同的原生 JSON 类型）。
跟人走、不跟设备走的设置放这里（第一期只有工作台布局 `dashboard.layout`，前端见
[`pages/dashboard` 分册](../../../../../packages/platform/src/pages/dashboard/AGENTS.md)）；「这块屏幕上我想看到什么」那种仍在前端 localStorage。
路径里没有用户 ID —— 「读写别人的偏好」在契约上就不存在。没存过回 **200 + `value: null`**，不是 404。
键是格式白名单（小写 `命名空间.名字`），所以另有两道防滥用：值 ≤ 16 KB（UTF-8 字节）、每人 ≤ 32 个键。

- 🔴 **`json.dumps` 要 `allow_nan=False`。** 请求体是 Python `json.loads` 解析的，它**接受** `NaN` / `Infinity`。
  实测（关掉这道）：`PUT {"value": {"w": NaN}}` 回 **200**，库里存的是 `{"w":NaN}`（不是合法 JSON），
  PUT 的响应和之后的 GET 都是 `{"w": null}` —— 响应编码层把 NaN 换成了 null。**写进去的和读回来的不是同一份，没有任何报错**
- ⚠️ **大小按字节算，不按字符。** 6000 个汉字是 6000 个字符、18000 字节；按 `len(text)` 判就放进去了（变异实测：那条用例红）
- ⚠️ **测试收尾删这张表的行要走 Core，不能裸 `text()`**：`key` 在 SQL Server / MySQL 是保留字。
  实测：`text("DELETE FROM sys_user_preference WHERE key LIKE …")` 在 PostgreSQL 上全绿，换到 SQL Server
  20 条用例在 fixture 里一起 `ProgrammingError`；改成 `delete(UserPreference).where(...)` 三个方言都过
- ⚠️ 同一个人同一个键**第一次**被两个请求同时写，后到的那个撞唯一约束回 500（先查后写，三个方言的 upsert 语法各不相同）。
  真实用户只可能是两台设备同一瞬间第一次保存，接受。**E2E 撞上过**（2026-11-01）：`notice-reach.spec.ts` 是并行的，两个 worker 的
  `beforeAll` 同时给 zhoumin 第一次存布局，一个 `UniqueViolationError` → 500。造前置数据的地方再存一次就是更新（那个 spec 里重试了）

**实测证据**：`tests/api_v1/test_user_preference.py` 20 条（往返 + 整份覆盖 · 只能动自己的 · 未登录 401 · 9 个坏 key ·
5 种坏 JSON 且旧值不被覆盖 · 字节上限边界 · 键数上限）。变异各自当场红：放行 NaN · 按字符算大小 · 查询不带 `user_id` ·
去掉键数上限。迁移在三个方言的私有库上都是 `downgrade -1`（表没了）→ `upgrade head`（表回来）：PostgreSQL 16 /
SQL Server 2022（`sys.identity_columns` 对这张表 0 行）/ MySQL 8.4；之后在同一个库上跑这 20 条 + 迁移守卫 7 条，三个方言都全绿。

## 工作台「系统运行」三个接口（`/sys/dashboard/attention|services|visits`，#202）

`service/dashboard_service.py`。前端只在「系统运行」区用（见 [`pages/dashboard` 分册](../../../../../packages/platform/src/pages/dashboard/AGENTS.md)）。
一张卡片一个接口，守卫各自对齐：`services` 是 `DependsSuperUser`（同在线用户页），`visits` 要 `log:login:list`，
`attention` 只要登录、**逐条按权限过滤**（Webhook 停用 `open:webhook:list` · 定时任务失败 `task:scheduler:edit` · 登录失败突增 `log:login:list`）。

- 🔴 **「哪一天」按查看人的显示时区切**（`visits?tz=`）：按服务端时区切，人在别的时区时柱子整体错一天，不报错（同 i18n 分册 `dateKey` 那条）
- 🔴 **只提醒自动停用的 Webhook**（`disabled_reason == 'auto'`）：手动停的是人自己关的
- 🔴 **在线会话数不算 swagger 调试口的会话**（同在线用户页）。第一版测试只断言「三端加起来等于 total」，把过滤去掉照样绿 ——
  `token_headers` 本身就是一个 swagger 会话，现在拿 `/monitors/sessions` 的条数对总数，变异当场红
- 🔴 **权限判据走 `rbac.user_has_perm`**（和接口上的 `RequestPermission` 同一份）。第一版自己收集权限码：
  权限码白名单（`RBAC_ROLE_MENU_EXCLUDE`）里的码它看不到，casbin 模式下它照样按菜单算 —— 两种情形下结论都和真正的接口守卫对不上
- 🔴 **被删应用下的端点不提醒**：应用是逻辑删除、端点还在表里，不过滤的话「严重」永远清不掉，「去处理」点进去 404。
  join `OpenApp` 且 `deleted == 0`，同投递侧的 `crud_webhook.subscribers`
- **「今天登录失败偏多」的「今天」也按查看人的时区切**（`attention?tz=`），和同一屏的柱状图同一种切法；条目里带 `day` 说是哪一天
- **失败任务的最后一行报错一条窗口函数查完**（`row_number() over (partition by name order by date_done desc, id desc)`），原来逐个任务查（N+1）。
  按 id 取「最后一条」不对：最新的那次不一定 id 最大（测试里先插最新的）
- ⚠️ **测试在共享库里垫数据要垫到「一定是我」**：「失败最多的 IP」那条原来只垫刚好够触发突增的条数，库里今天已经有别的 IP 失败了 6 次时
  （截图用的私有库）`top_ip` 就成了别人。现在至少垫到比今天已有失败的总数还多一条

**实测证据**：`tests/api_v1/test_dashboard_ops.py` 10 条 + 审批那边的 `plugin/workflow/tests/test_dashboard_feeds.py` 12 条，
2026-11-01 在 PostgreSQL 16 / SQL Server 2022 / MySQL 8.4 三个私有库上都全绿（连同个人偏好 20 条；窗口函数三个方言都认）。
变异各自当场红：任务失败不按权限过滤 · 手动停用的也提醒 · 按服务端时区切天 · 会话数算上 swagger（加了上面那句断言之后）·
被删应用下的端点照样提醒 · 报错逐个任务查（数查询条数）· 报错按 id 取最新 · 登录失败按服务端时区算「今天」· 自己收集权限码。

## 登录日志里的安全事件：账号被锁 · IP 被锁 · 被强制下线（#273）

`sys_login_log.event`（`common/enums.py: LoginLogEvent`）：`login` 一次登录尝试 · `locked` · `ip_locked` · `kicked`。
后三种不是登录动作，`status` 记 0。

| 原来的样子 | 现在 |
|---|---|
| 账号被锁那一刻只是某次失败尝试的文案碰巧写着「账号已被锁定」，筛不出来 | `handle_login_failure` 第一次设锁时记一行 `locked`（锁到几点、哪个 IP 在试）。锁住之后不再累加，也不再记 |
| 🔴 IP 被锁**完全看不出来**：对方收到的是「用户名或密码有误」（刻意不给攻击者反馈），日志文案也是这句 | 跨过阈值的那一次记一行 `ip_locked`（`==` 不是 `>=`）。对方看到的不变 |
| 管理员踢人：操作日志里只有会话编号；改密码 / 停用连带撤销的会话**什么都没记** | 在会话层唯一的撤销入口 `session_store.revoke` 挂回调（`on_session_revoked`），登录日志服务登记 `record_forced_logout`：踢人 / 改密码 / 停用都记，以后新加的撤销路径自动记上；自己登出、被同浏览器新登录挤掉、空闲 / 到期不算 |

- 🔴 **被踢那一行记的是被踢那个会话的 IP / 浏览器**（撤销之前先 `HGETALL` 会话），不是点按钮的管理员的。说明里写谁干的（`ctx.user_id`；就是本人时写「本人」，没有请求上下文时写「系统」）
- 🔴 **记这一行时不能另开会话读 `sys_user`**（`record_event` 只收调用方给的 uuid / 用户名）。
  **症状**：PR 第一版 CI 上「pytest · SQL Server」和「playwright · E2E」都跑满 20 分钟被取消，PostgreSQL 那个 job 5 分半全绿。
  **根因**：改密码 / 停用 / 删除是先 UPDATE 用户那一行、再撤销会话（→ 回调），请求的事务要等回调返回才提交；回调另开会话读那一行，
  SQL Server（RCSI 关着，读要加共享锁）上就排在请求的排他锁后面 —— 两边互等，而一边在应用层，数据库的死锁检测看不见，请求永远挂着。
  **修法**：被踢的人取会话里的快照（`session_meta` 多存一个 `uuid`；升级前登录的会话没有，那几天记随机的），
  点按钮的人取请求上下文（JWT 认证时放进 `ctx.username`），锁定那条用调用方自己的会话读。
  **实测证据**（2026-11-09，本机 SQL Server 私有库）：修之前 `test_login_events.py` 卡住，`sys.dm_exec_requests` 里回调那条
  `SELECT sys_user.uuid, sys_user.username` 在 `LCK_M_S` 上等改密码那个会话（它最后一句是 `UPDATE sys_user SET last_password_changed_time`）；
  修后 6 条 6.4 秒。守卫不靠「挂没挂」（PostgreSQL 不挂）：`test_a_password_reset_records_every_session_it_ended` 记下每条语句和提交，
  断言请求 UPDATE 用户行之后、提交之前没有别的连接碰 `sys_user` —— 把操作人改回查库，PostgreSQL 上当场红。
  ⚠️ 以后往 `on_session_revoked` 上挂新回调，同一条：**它跑在调用方的事务中间**，别另开会话读调用方可能刚改过的行
- 🔴 **数登录的地方只数 `login`**：工作台的「登录次数 / 失败」和「今天登录失败偏多」都过滤了。不过滤的话踢一次人就多一次「登录失败」
- 记录写不进去只记日志、不往外抛：拒绝登录、踢人这两件事本身不能因为记不下来而失败
- 解锁是到期自动的（没有手动解锁），锁到几点写在锁定那一行里；「用恢复码登录」还没做
- ⚠️ **swagger 调试口（`/auth/login/swagger`）不写登录日志。** 测试第一版用它造失败尝试，这个人名下只有「被锁」一行，
  筛不筛都是一行 —— pytest 和 E2E 都改成走真登录接口后，去掉筛选当场红（`Expected: 1, Received: 7`）
- ⚠️ **别的测试收尾时撤销同一个临时账号的会话（`EndReason.disabled`），本身就会记成「被强制下线」**。单跑本文件全绿、
  和 `test_session.py` 一起跑就多出 26 行 —— 断言一律限定在本条测试开始之后，而且精确到微秒（按秒截的话上一条的收尾落在同一秒里就混进来）

**实测证据**：`tests/api_v1/test_login_events.py` 6 条（经接口按 `event` 读回；改密码那条兼守上面的锁窗口）+ E2E `login-events.spec.ts`。
变异 8 处各打红：锁定不记 · IP 锁定不记 · 撤销不登记回调 · 被踢那行记管理员的 IP · 什么原因下线都记 · 工作台不按事件过滤 ·
接口不透传 `event` · 撤销之前不取会话字段。前端：查询区去掉「事件」→ E2E 红；路由 schema 去掉 `event` **不红**，是等价变异
（叶子路由的 search 会合并根上没校验的那一份，见 `packages/ui` 分册「列顺序」那条）。迁移 `ao000000loginevent`（原 `an000000loginevent`，#271 先合后改接）：已有行回填 `login`、
库上不留 DEFAULT，`test_model_matches_migrations` 对升级上来的库通过。

## 🔴 邮箱验证码必须绑定用户和目标邮箱（#303）

**症状**：邮箱 A 收到的验证码能把账号绑定到邮箱 B，同 IP 的用户也共用同一份码。
**根因**：邮件验证码只按 IP 存，校验不检查用户和目标邮箱。
**修法**：按用户 ID + 校验后的目标邮箱哈希存，Lua 原子校验消费、最多猜 5 次；SMTP 成功才发布新码，失败重发保留旧码。
**实测证据**（2026-11-12，SQL Server / Redis 私有验证库）：`tests/test_email_binding.py` 经真实接口覆盖错邮箱、同 IP 跨用户、重放、猜测上限、非法目标和重发失败；修前错邮箱返回 200。

## 🔴 图形验证码 uuid 不能指向限流键（#310）

**症状**：传手机号冷却键后缀与答案 `1` 就通过图形验证，并删掉冷却状态。
**根因 / 修法**：外部 uuid 直接拼进共用 Redis 前缀，GET / DEL 也不原子。schema 和 service 校验 UUID4，图形码用 GETDEL 消费，短信限流改用独立前缀。
**实测证据**（2026-11-12，真实 Redis + HTTP）：`tests/test_captcha_consume.py` 修前接受限流键 `1`，修后 HTTP 返回 422、限流键保留；5 个并发验证只通过 1 个，答错仍作废。

## 🔴 删除按钮权限不能代替账号保护（#312）

**症状**：非超管拿到 `sys:user:del` 就能直接删除超管，或删除自己；前端禁用超管的按钮挡不住直接请求。
**根因 / 修法**：删除 service 必须拿到操作者，先拒绝自删，再按原数据范围锁住目标，拒绝直接删除任何超管（包括最后一个、已停用的超管）。
要删除超管须先由另一名超管降权；不能修改本人权限的保护仍在。锁持有到提交，防止检查后并发提升权限；SQL Server 要显式 `UPDLOCK, HOLDLOCK`，只写 `with_for_update()` 会被方言静默忽略。
会话撤销和精确的用户快照清理挂到响应后台任务，事务提交成功才执行；回滚不能把仍有效的账号踢下线。
**实测证据**（2026-11-13，PostgreSQL / Redis 私有库）：`tests/api_v1/test_user_delete.py` 17 条覆盖真实角色授权、自删、超管、唯一超管、数据范围、并发提升、三端 access / refresh 撤销、提交失败保留会话，以及三方言锁语句编译。MySQL / SQL Server 本轮只验了编译。浏览器 `apps/web/e2e/tests/user-delete.spec.ts` 验证非超管本人不可选、不可删，其他普通用户可删。
变异验证：去掉自删保护、去掉超管保护、去掉目标锁、把会话撤销挪回提交前，四处都被对应测试抓到。
