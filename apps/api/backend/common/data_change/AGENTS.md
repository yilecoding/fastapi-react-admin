# backend/common/data_change —— 数据变更审计（#260）

> 谁、什么时候、从哪来，把哪个对象的哪个字段从什么改成了什么。
>
> 这份文件是 [`backend/common` 分册](../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的
> 文件时才把它加载进上下文（惰性加载）。跨模块的硬纪律只在根 `CLAUDE.md` 里有一份；
> **新增结论请追加到离代码最近的那一份**。

```
registry.py   登记表：哪些表要记、每一列怎么记（普通 / 引用 / 敏感 / 忽略）· 关联表折叠成集合字段 · 一对一子表折叠成开关字段 · 来源和动作的中文名
capture.py    拦截层：挂在 Session 类上的五个事件 · 「第一次碰到时拍原样，提交时和现状比」· 同一个事务里写 sys_data_change
chain.py      防篡改链：写入时编号 + 签名（含上一行的签名）· 校验 · 保留期推锚点 · 迁移补签
```

内置登记在 `app/admin/data_change.py`（用户 / 部门 / 角色 / 菜单 + 三张关联表 + 用户的二次验证），插件放自己目录下的
`data_change.py`（参数配置：`plugin/config/data_change.py`；用户绑的第三方账号：`plugin/oauth2/data_change.py`）。表是 `app/admin/model/data_change.py`，
接口 `GET /api/v1/logs/changes`（+ `/meta`），权限码 `log:change:list`，**不按数据权限过滤**（#260 拍板，同操作日志）。
前端：「日志管理 → 数据变更」页（`pages/log-change`）· 五个页面的「变更记录」抽屉（`pages/_shared/data-change`）·
操作日志详情的「这次改了什么」（按 `trace_id`）。保留期参数 `DATA_CHANGE_RETENTION_DAYS`（默认 180，参数配置「日志」组），
`maintenance.prune_logs` 每天删。

## 为什么挂在会话上，而不是在 service 里一处处写

五张表的写入有 **34 个 DAO 写方法、5 种写法**（按条件 UPDATE · Core 写关联表 · 按主键批量 UPDATE ·
unit of work INSERT · 逻辑删除）。照 yudao（mzt-biz-log）在 service 里显式写，漏一处就是「这类修改没有记录」，
而且是**静默**的 —— 和 Webhook 那 15 个 `emit` 同一个风险。挂在会话上，以后新加的写路径自动被记。

ORM 的 `before_update` / `after_update` 抓不到：crud-plus 发的是「按条件 UPDATE」，不触发映射器事件
（SQLAlchemy 2.0 文档对这类语句给的拦截点就是 `do_orm_execute`）。

## 🔴 `before_commit` 里必须先 `session.flush()`

**症状**：新建角色 / 菜单 / 参数没有「已新建」记录；而且那条新建会记到**同一个会话下一个事务**的头上。

**根因**：提交时 SQLAlchemy 是**先**触发 `before_commit`、**再**做最后一次 flush。这几个 DAO 的 `create_model`
不 flush（`db.add()` 之后 INSERT 要到提交时才发生），`after_flush` 要等 `before_commit` 跑完才轮到 ——
那时缓冲已经处理过了，新建进了缓冲却没人写。

**修法**：`_on_before_commit` 第一句 `session.flush()`（没东西要 flush 时是空操作）。

**实测证据**（2026-11-09，自建 schema 跑完删掉，PostgreSQL 和 SQL Server 结果一致）：

| 场景 | 事件顺序 | 结果 |
|---|---|---|
| `add()` 不 flush 直接 commit，不先 flush | `before_commit(缓冲 0, 待写新对象 1)` → `after_flush` → `after_commit(缓冲剩 1)` | 审计 0 行，缓冲泄漏 |
| 同上，先 flush | `before_commit` → `after_flush` → 写审计 → `after_commit(缓冲剩 0)` | 和业务同一个事务提交 |
| UPDATE → rollback | `do_orm_execute` → `after_soft_rollback(清缓冲)` | 业务没改、审计 0 行 |

变异：去掉这句 flush → `test_data_change.py::test_creating_a_role_is_recorded_although_create_model_does_not_flush` 红。

## 🔴 每一列都必须归类

`register_audited` 要求表的每一列都写进 `fields` / `refs` / `secret` / `ignore` / `soft_delete` 之一（主键自动忽略），
漏一列、多写一列、一列写两处都当场抛（import 期，启动即失败）。

防的是：**以后加了个 `api_token` 列，默认当普通列记，明文进了审计表** —— 静默，而且是泄密。
给这五张表加列时先想它属于哪一类；字段的中文名同时要进 `packages/i18n` 的两个语言包和 `server-data-keys.json`
（`test_every_label_is_translated_and_whitelisted` 守着 —— 不在语言包里英文界面就是中文，不在白名单里
`pnpm i18n:fix` 会把它们当孤儿删掉）。

## 🔴 拦不到的写法，由静态守卫挡在生产代码外

运行时**不报错**（测试收尾大量用这些写法硬删数据，35 处）：

| 写法 | 为什么拦不到 |
|---|---|
| `text('UPDATE sys_user …')` | 原生 SQL，没有表对象 |
| 语句式 `insert(User)` | 拿不到新行的主键（雪花 ID 是 Python 侧默认值，不在参数里） |
| `session.connection().execute(...)`，包括 crud-plus `bulk_update_models(pk_mode=False)` | 不经过 `Session.execute`，`do_orm_execute` 不触发 |

`test_production_code_has_no_write_the_capture_cannot_see` 扫生产代码（不含 tests / alembic / scripts / cli.py）。
迁移、`fba init`、种子 SQL 走连接，不记，符合预期。

## 关联表记的是提交时的净变化

改用户角色、存权限矩阵都是「全删再全插」。按语句记的话每次保存都是「删了 5 个、又加了同样 5 个」。
现在第一次碰到某个父对象时拍一次成员集合，提交时再查一次，记差集；原样保存不出记录。
变异：每条语句都重拍 → `test_updating_a_user_records_old_and_new_values_with_the_actor` 红。

## 评审补的（#262）

PR 第一版合并前跑了一次独立评审，下面五条都是**读代码能推出来、测试一条都不红**的：

| 症状 | 根因 | 修法 | 实测证据 |
|---|---|---|---|
| 🔴 SMTP 密码明文进审计表，留 180 天 | `EMAIL_PASSWORD` 就存在 `sys_config` 里，`value` 第一版按普通列记 | 登记表加 `secret_when`：键名以 PASSWORD / SECRET / TOKEN / API_KEY 结尾的行只记「改过」（和前端参数配置打码同一条规则） | `test_a_password_like_config_value_is_recorded_as_secret` |
| 一个请求拆成好几条记录；保存点里写记录出的错被吞掉、记录丢失 | **保存点提交也触发 `before_commit` / `after_commit`**（`_prepare_impl` 里 `if self._parent is None or self.nested`）。AI 工具每调用一次就开保存点写调用审计 | 两个钩子都 `session.in_nested_transaction()` 时跳过 | `test_a_savepoint_commit_does_not_split_or_drop_the_record`（去掉任一个跳过都红） |
| 每次登录多查两次整行 | `update_login_time` 只写忽略列，照样前查后查 | 语句写的列全在忽略列里就不抓 | `test_writing_only_ignored_columns_skips_the_capture`（数 `_fetch` 调用） |
| 从很多人身上摘掉一个角色：逐个拍集合、写几万行，全在业务事务里；按主键批量更新几千行在 SQL Server 上超 2100 个参数，业务 UPDATE 跟着失败 | 关联表没有 `BULK_LIMIT`；executemany 的主键一次塞进一个 IN | 关联表超限记一条汇总（哪个集合字段、多少个对象、加了 / 去了谁）；executemany 超限直接汇总（`varies`：每行值不同），不超限分批查 | `test_an_association_delete_over_the_limit_is_one_summary` · `test_executemany_over_the_limit_is_one_summary_without_a_pre_select` |
| 改部分加载的对象，记出一串「从空改成了现值」的假变更；来源按 flush 时算 | 原样用属性历史拿：没加载过的属性历史是空的；会话 `autoflush=False`，flush 常在 `with data_change_source` 外面 | 原样改在 `before_flush` **从库里查**；登记过的模型的列属性挂 `set` 监听，改的那一刻把来源记在 `InstanceState.info` 上 | `test_editing_a_partially_loaded_object_records_only_what_changed`（`load_only` + `with` 外提交） |

另外两条：「定时任务」来源原来没人设（worker 里的修改记成「系统」，筛选下拉里那一项永远是空的），现在 `app/task/tasks/base.py: with_timeout`
统一包一层（`test_celery_tasks_record_their_changes_as_scheduled_tasks`）；操作日志详情的「这次改了什么」只取第一页 50 条，
现在超出时给「还有 N 条」的链接，trace_id 是占位的 `-` 时不查。

⚠️ 评审还提了一条**没改**的：trace_id 可以由客户端带 `X-Request-ID` 指定（`RequestIdPlugin(validate=True)` 接受任何合法 UUID），
所以「这次改了什么」能被伪造成挂在别人的请求下。操作人照样记的是真的那个人，影响的只是关联关系 —— 这是 trace 机制本身的事，不在这里改。

## 来源：流式响应要显式传操作人

`with data_change_source('ai', ref, actor_id=…)` 包住的修改记成别的来源。来源在**第一次碰到那一行**时就定下来
（`db.add()` 那一刻由 `transient_to_pending` 记），所以提交发生在 `with` 外面也没关系。

🔴 AI 对话是 SSE 流式响应，生成器跑起来时请求上下文（starlette-context）可能已经收尾了，从上下文里取操作人会拿到空 ——
`plugin/ai/core/dispatcher.py: _invoke` 显式传 `ctx.user.id`。批量导入（`import_service`）和第三方登录（建号 / 同步头像）同理。
定时任务在 `with_timeout` 里统一包（一期这五个对象还没有任务会改，口子先接上）。

## 顺手修的：`last_login_time` 带 `onupdate`（上游带过来的）

**症状**：管理员改一下某人的资料 / 状态 / 角色，个人中心、角色成员、用户导出、AI 工具里的「上次登录时间」
都成了「被改的时间」，不报错。

**根因**：`app/admin/model/user.py` 的 `last_login_time` 带着 `onupdate=tz_helper.now`（分叉提交 `2dc4e71` 就有，
上游 FBA 现在也是 `onupdate=timezone.now`）—— 对用户表的**任何** UPDATE 都会刷它。登录那条路径本来就显式写这一列。

**修法**：去掉 `onupdate`。**实测证据**：第一次探针只改昵称，比对结果里 `last_login_time` 跟着变了；
`test_updating_a_user_no_longer_touches_last_login_time` 守着（把 `onupdate` 加回去就红）。

## 二期：用户的二次验证 · 第三方账号

两张表都记在**用户**名下，不单独当对象 —— 单独记的话记录挂在子表自己的 ID 上，用户的「变更记录」里看不到
「谁把他的二次验证关了」。

| 表 | 怎么登记 | 用户名下出现的字段 |
|---|---|---|
| `sys_user_mfa`（开了才有这一行） | `register_audited_child`：有没有这一行 = 开关字段；`values` 从那一行算值，两边都有行时才比 | 二次验证（未开启 ↔ 已开启）· 恢复码（只记「改过」） |
| `sys_user_social` | `register_audited_set(..., active='deleted', member_labels=...)` | 第三方账号（+ GitHub / − Google） |

管理员重置和自己关是同一条「已开启 → 未开启」，区别在操作人。开启时只记开关，不另记「生成了恢复码」。

| 症状（不处理的话） | 根因 | 修法 | 实测证据 |
|---|---|---|---|
| 🔴 开二次验证（`db.add`）、自己关（`db.delete`）、绑第三方账号（`create_model`）一条都不记，只有管理员重置（语句 `delete(UserMfa)`）记得到 | unit of work 在 flush 时发的 INSERT / UPDATE / DELETE **不经过** `do_orm_execute`（它只拦 `Session.execute()`）。一期的三张关联表都是 Core 表、只被语句写，碰不到这条 | `before_flush` 里 `_remember_flushed`：新建 / 改过 / 要删的子表对象按父对象拍原样 | 去掉这一句 → `test_mfa.py::TestChangeRecords` 和 `test_social_change_records.py` 红 |
| 🔴 解绑不出记录 | 解绑是逻辑删除（`UPDATE … SET deleted = id`），查成员不过滤的话被标删的那行还算「绑着」，前后集合一样 | 关联表登记给 `active`：非 0 的行不算成员 | 去掉过滤 → 社交那条红 |
| 🔴 登录过程中被强制绑定二次验证、第三方回调绑定账号，操作人是空、来源是「系统」 | 这两个请求不带登录态（还没登进来 / 第三方重定向回来），请求上下文里没有 `user_id` | `with data_change_source('web' / 'oauth2', actor_id=…)`，人从挑战令牌 / OAuth2 state 里取 | 去掉任一处 → 对应那条红 |
| 每次用恢复码登录多一条「恢复码：已修改」，而且是「系统」改的 | 用掉一个恢复码会把 `used` 写进同一列 JSON | 比的是「这一批是哪几个哈希」（`_recovery_batch`），不是整段 JSON | 改成按整段比 → `test_using_a_recovery_code_is_not_a_change` 红 |
| 每次用动态码登录前查后查两次 | 防重放要写 `last_step` | 进 `ignore`；ORM 改属性和语句 UPDATE 两条路都按「写的列全在忽略列里」跳过 | 去掉任一条跳过 → `test_writing_only_ignored_child_columns_skips_the_capture`（数 `_snapshot` 调用）红 |

⚠️ 子表的列**不进审计表**，进的只是 `values` 算出来的东西，所以不像对象那样要求每一列归类（新加的列没人读就不会漏）。
`ignore` 只决定「写这几列要不要抓」—— 把被 `values` 读的列写进去会漏记。

**没接的**：个人偏好（工作台布局，拖一下就是一条）· 密码历史（派生数据，「密码：已修改」已经在用户上）·
会话 / 强制下线（在 Redis，操作日志里有）。

## 二期：单字段历史 · 导出 · 防篡改链

**单字段历史**：变更记录抽屉里点字段名只看这一个字段（状态跟着抽屉走）；「数据变更」页详情里点字段名，
对象 + 字段写进地址栏（能分享）。后端早就支持 `field` 筛选（`fields` 列存 `,a,b,`），这次只接前端。

**导出**：`POST /logs/changes/export`（`log:change:export`，迁移 + 三份种子 + 清单），框架照 `common/dataio`。
「改了什么」一格是 `昵称：A → B；角色：+X −Y；密码：已修改（不记录内容）`。⚠️ 字段名、动作、对象类型的英文在前端语言包里
（中文原文即 key），后端读不到 —— 英文文件里出代号（`nickname: A → B`），不出中文；引用的名字（部门名）是业务数据，照摊。

**防篡改链**（`chain.py`，`GET /logs/changes/integrity` 超管 · `fba data-change verify` · 页面上「校验完整性」）：
每行带序号，签名 = `HMAC(DATA_CHANGE_CHAIN_KEY, 上一行签名 + 这一行的规范文本)`。密钥只放 `.env`、不进库。

| 症状（不处理的话） | 根因 | 修法 | 实测证据 |
|---|---|---|---|
| 🔴 SQL Server 上两个并发请求拿到同一个序号，唯一索引让其中一个业务提交直接失败 | SQLAlchemy 的 mssql 方言**静默丢掉** `with_for_update()`：编译出来是一条裸 SELECT，没有锁 | 先 `UPDATE sys_data_change_chain SET head_seq = head_seq + n` 占行锁（三个方言都持有到提交），再读链头；锁是这个事务最后拿的，拿到之后只写这两张表，不会和业务行锁成环 | 三个方言编译 `select().with_for_update()`：PostgreSQL / MySQL 带 `FOR UPDATE`，mssql 没有。`test_concurrent_writers_queue_on_the_chain_head`（6 个线程在屏障后同时提交，序号连续、链校验通过） |
| 迁移之前就有的记录被成批报成「伪造」，或者伪造的行冒充旧行 | 第一版按「链上最早那一行的时间」分「上线前的旧行 / 绕过应用塞进来的」：时间一错开就误报，伪造的人把时间写早就混进旧行 | 迁移 `an000000datachangechain` 把已有记录按 (created_time, id) **补签进链**，此后没有序号的行一律是问题，不设「旧行」 | 第一版在测试里一次误报 **977 条**；补签后私有库 979 行 `fba data-change verify` 通过 |
| 每次保留期清理之后，校验报「中间少了几行」 | 按时间删、起点不动的话，删掉的那段就是缺口 | 清理先把锚点推到「第一条还要留的」前一条、提交，再按序号删；校验从锚点往后算。链头写进任务日志（库外的旁证） | `test_pruning_chained_data_changes_keeps_the_chain_verifiable` |
| 链头那一行没有（`fba init` 和测试库都是 create_all + 种子，不跑迁移）→ 第一次写记录就失败 | —— | `chain.link` 发现占锁的 UPDATE 改了 0 行，就在保存点里建（接着已有的最大序号），撞主键说明别人刚建好，再占一次锁 | `test_the_chain_head_row_is_created_by_the_first_write` |

能发现：改过某一行 · 中间删了几行 · 最新的几行被删 / 链头被往回改 · 绕过应用塞进来的行 · 整条链换个签法自己重算（配了密钥时）。
**发现不了**：同时拿得到库和密钥的人（能重算整条链）· 同时删掉最老几行**并**改锚点的人（锚点在库里）·
刚配上密钥、还没有新修改的那段时间里整条链被重算（那时只会报「最新一行不是用现在的密钥签的」，有一次修改之后才能确认）。
没配密钥时签名谁都算得出来，只防「手滑直接改库」—— 校验结果和页面上都会说。配密钥之前签的行（标识是「没配密钥」）
照样用空密钥核对；换过密钥的话，换之前签的行只能核对序号，单独列出来。

### 评审补的（#271）

PR 第一版跑了一次独立评审，10 条里 8 条成立、改了；下面都是**读代码推得出来、原来的测试一条都不红**的：

| 症状 | 根因 | 修法 | 实测证据 |
|---|---|---|---|
| 🔴 能写库、没有密钥的人把整条链的密钥标识换成假的（或「没配密钥」）再自己重算，校验回「没有发现问题」 | 不是当前密钥签的行只计数不报；「没配密钥」签的谁都算得出 | 配了密钥时**最新一行必须是用它签的**（`stale`）；当前密钥签过的行之后再出现别的标识照报 `key`；「没配密钥」的行用空密钥核对（改了配密钥之前的记录也查得出） | `test_re_signing_the_whole_chain_another_way_is_caught`（两种标识）· `test_records_signed_before_the_key_was_set_are_still_checked` |
| 🔴 自增主键模式（`DATABASE_PK_MODE=autoincrement`）下所有被审计的提交失败 | 链为了签名自己填雪花 `id`，SQL Server 不许给 IDENTITY 列显式插值 | 签名不带 `id`，`id` 交给列默认值 / 数据库；记录靠 `chain_seq` 认 | `test_link_leaves_the_id_to_the_database` |
| 业务高峰点「校验完整性」报「最新的记录被删掉了」 | 先读链头再一批批读记录，读记录不限上界，期间提交的行也读进来 | 只走到读链头那一刻的链头；再拿「最大序号 vs 现在的链头」兜住「把链头往回改、藏起最新几行」（**先读最大序号再读链头**，反过来两次读之间一提交就误报）；校验期间锚点被推了，被删那段不算缺口 | `test_records_committed_while_verifying_are_left_for_next_time` · `test_rolling_the_head_back_to_hide_the_newest_records_is_caught` |
| 🔴 清理把伪造的行删了 | 没有序号的行原来按时间删 —— 迁移补签之后它们就是绕过应用写进来的 | 不删，留给校验报；任务日志里说一声 | `test_pruning_leaves_records_written_around_the_app` |
| 链头那一行不在时清理照删，之后永远报着一段「缺口」 | 推不了锚点、照样按序号删 | 链头不在就不删有序号的行 | `test_pruning_without_a_head_row_deletes_no_chained_record` |
| 多实例时钟有偏差时，还在保留期里的行被提前删 | 按「早于 cutoff 的最大序号」推锚点，序号和时间不严格同序 | 推到「第一条还要留的」前一条：宁可多留，不少留 | `test_pruning_never_takes_a_record_still_in_retention`（序号 a < b < c，b 在保留期里、c 更早） |
| 抽屉开着换对象，带着上一个对象的字段筛选 | 只在关掉时清 | 换对象也清 | —— |
| 详情里点字段名，「这个字段的历史」被原来的筛选缩小 | 合并了原有的 search | 只留对象 + 字段（视图状态留着） | E2E 带 `actor=admin` 进来，点完不能还在地址栏里 |

另外：新库（`fba init` / 测试库）的种子里放了链头那一行，第一次写记录不用再在保存点里建 —— 评审推断 MySQL 上两个首写会死锁
（`UPDATE` 没匹配到行时拿了间隙锁），**没实测**；自增主键模式没有种子，仍走保存点那条路。
没改的一条：每次提交在链头那一行上「UPDATE + SELECT + UPDATE」三次往返、锁到提交，PostgreSQL 的 `RETURNING` /
SQL Server 的 `OUTPUT` 能省一次，但要按方言分叉、MySQL 没有 —— 后台写少，先不做。
8 处变异各打红一条（上表测试）；前端「点字段名」那处改回合并原有 search → E2E 红。

⚠️ **推断，没实测**：MySQL 上「先 UPDATE 再读」要求 UPDATE 真的改了值（`+ n`）—— InnoDB 的一致性读只认本事务改过的行，
`SET x = x` 之后再 SELECT 可能读到事务开头的旧快照。本机没有 MySQL 容器，这条没跑过。

⚠️ 这条链让每次提交多一把锁和几条语句，把「接口回 200 时事务还没提交」那个窗口撑得更宽了（`common/AGENTS.md`
「写接口的事务要在响应之前提交」，#268）：没合那个修复之前，`data-change.spec.ts` 第一步「建部门 → 按编码查」就查不到。

**实测证据 / 变异**：`test_data_change.py` 新增 9 条（链 · 改内容 · 删中间 / 删最新 · 绕过应用塞行 · 没密钥重签 · 有密钥只重签一行 ·
并发 · 链头重建 · 超管接口）· `test_prune_logs.py` 一条 · `test_export.py` 一条（中文 / 英文两份文件 + 拼错的筛选参数被拒）· E2E `data-change.spec.ts`
加了单字段历史、导出按钮、完整性校验（前端去掉按字段过滤 → 红在 `Expected: 0, Received: 1`）。
后端 12 处变异各有测试红：链头不占锁（先读后写）· 不重算签名 · 不查没序号的行 · 不认密钥标识 · 不查链头 · 不查缺口 ·
没有链头就不建 · 清理不推锚点 · 清理按时间删 · 导出英文也出中文 · 校验接口谁都能调 · **签名不带上一行** ——
最后这处第一轮没有测试红：序号本身签在签名里，改内容、删中间不靠串联也查得出。串联守的是「密钥泄露了也得整条重签、
链头和库外日志对不上」，补了 `test_re_signing_one_record_breaks_the_next` 才红。迁移在私有库上
`downgrade -1` → `upgrade head` 走过，`test_model_matches_migrations` 对升级上来的库通过。

## 性能

**实测**（开发库 PostgreSQL / docker / WSL，同一条 `update_model_by_column` 200 次）：拦截关中位 2.045 ms，
拦截开（前查 + 后查 + 比对）中位 4.275 ms —— 每次被审计的 UPDATE 约 +2 ms（不含提交时那一次批量 INSERT）。
**没登记的表**上测不出开销：PostgreSQL 0.752 → 0.723 ms、SQL Server 4.156 → 3.879 ms（300 次，监听器装 / 不装）。

一条语句命中超过 `BULK_LIMIT`（500）行时只记一条「批量修改」汇总（`entity_label` 存命中行数），不先把半张表查出来。

## 实测证据 / 守卫

`app/admin/tests/api_v1/test_data_change.py` 35 条（接口路径的五种写法 + 同步会话造的回滚 / 保存点 / 同一事务改两次 /
没 flush 的新建 / 建了又删 / 批量汇总 + 评审补的七条 + 登记守卫 + 静态守卫 + 接口）· `app/task/tests/test_prune_logs.py` 一条保留期 ·
E2E `data-change.spec.ts`。CI 的 PostgreSQL / SQL Server 两个 pytest job 都跑这份文件。

变异 18 处各有测试红：不先 flush · 原样每次都覆盖 · 外层回滚不清缓冲 · 关联表每条语句都重拍 · 敏感列照记值 ·
逻辑删除不认 · 来源不看 `add` 那一刻 · 不查引用的名字 · `last_login_time` 带回 `onupdate` · 批量上限失效 ·
参数配置不按行判敏感 · 保存点提交照写 · 保存点提交照清缓冲 · 只写忽略列照抓 · executemany 超限照逐行查 ·
关联表没有上限 · 改属性的来源按 flush 时算 · 定时任务不设来源。
E2E 那条第一版**变异不红**：新名字写成 `${旧名字}改`，「显示了旧值」那句永远成立 —— 改成不相交的名字之后才红。

**没验过**：MySQL（本机没有容器）· 提交时那一次 INSERT 的耗时。
