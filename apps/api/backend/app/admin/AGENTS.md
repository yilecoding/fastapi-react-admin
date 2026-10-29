# backend/app/admin —— 后台管理模块

> 这份文件是 [`apps/api/AGENTS.md`](../../../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的文件时才加载。
> 跨模块的硬纪律仍然只在根 `CLAUDE.md` 里有一份。

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
- 🔴 **默认密码放 `.env` 不放 `sys_config`**。那张表的值会原样显示在参数配置页上，
  而且 `PUT /sys/configs` 的请求体会进操作日志（`value` 不在 `OPERA_LOG_REDACT_KEYS` 里）
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
