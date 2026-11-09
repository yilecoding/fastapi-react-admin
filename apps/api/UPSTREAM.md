# 上游审查记录

本仓库的后端 fork 自 [fastapi-best-architecture](https://github.com/fastapi-practices/fastapi_best_architecture)（FBA），
是**永久分叉**：只拿上游的安全补丁和我们也有的 bug 修复，功能更新不跟（根 `CLAUDE.md`「fork 管理」）。

- **分叉点**：`.upstream-baseline`（`6149d04`，2026-08-16，上游 v1.15.1）。这个值不再动，它说的是「从哪儿分出来的」
- **已审到**：`c60408b`（2026-11-09）。下次从这个提交之后开始看：

```bash
git clone --filter=blob:none --no-checkout https://github.com/fastapi-practices/fastapi-best-architecture.git /tmp/fba
git -C /tmp/fba log --format='%h %cs %s' c60408b..origin/master
```

🔴 **上游的提交不能直接 cherry-pick。** 三层结构以外的东西我们大多重写过（会话模型、调度器、脱敏、限流……），
同一个文件两边早就对不上。每一条都要拿**我们的代码**核对「这个 bug 在我们这儿还在不在」，再按我们的写法重做；
核对结论写进下表，下一个人就不用再查一遍。

## 2026-11-09：`6149d04..c60408b`（54 个提交，上游 v1.16.0 / v1.17.0）

### 拿了的

| 上游 | 我们这里的样子 | 改在哪 |
|---|---|---|
| `e975ae1` 连接串里密码有特殊字符 | celery broker 和 socket.io 用裸 `quote()` 拼 Redis 地址，密码带 `/` 时整条 URL 解析错位；结果后端用 `quote_plus`，密码里的空格变 `+` | `database/redis.py: get_redis_url` · `app/task/celery.py: _userinfo`，见 [`task` 分册](backend/app/task/AGENTS.md) |
| `10791a1` 操作日志队列关停 / 溢出 | 关停时直接 `cancel()` 消费者，手里那一批丢掉；队列满时 `await put()` 卡住请求 | `common/queue.py` · `middleware/opera_log_middleware.py`，见 [`common` 分册](backend/common/AGENTS.md) |
| `adb4b94` IP 属地支持 IPv6 | 只有 v4 库，IPv6 和 `::ffff:` 映射地址都报错、属地为空 | `utils/request_parse.py: get_location_offline`。**只做了一半**：映射地址按 v4 查，真 IPv6 返回空不报错；上游另带的 37 MB `ip2region_v6.xdb` 刻意没进仓库 |
| `7ab3bb8` 热重载锁等待超时 | `lock.acquire()` 等不到返回 False，没看返回值照样往下走 | `utils/locks.py`。拿不到锁报 409（上游是 500）。插件安装只在开发环境开放，影响面小 |

### 我们已经有了 / 那段代码已经不在了

| 上游 | 为什么不用拿 |
|---|---|
| `f75eb56` 参数配置批量更新权限码 | 早修了，`plugin/config/api/v1/sys/config.py` 有注释 |
| `935c494` 调度器后台任务被回收 | 早修了，而且修得更彻底（没有事件循环时退化成同步写） |
| `c7ccebb` 换 PyJWT | #193 已换 |
| `a38bd0b` 多端登录判断 | 那段代码被会话模型（#145）整个替换了 |
| `66a4c77` · `a0964d9` · `fa2825b` 脱敏 | prod 的 422 不回显输入；`OPERA_LOG_REDACT_KEYS` 比上游全。上游补的主要是 AI Buddy 插件，我们没有 |
| `8c3d35b` beat 异步调度 | 调度器是重写的，不用 `run_await`。⚠️ 但它「统一跑在常驻后台循环上」的思路，可以拿来修 [`task` 分册](backend/app/task/AGENTS.md)里记着还没修的「worker 雪花节点续期被取消」 |
| `54a438c` 雪花初始化用了线程锁 | 每个进程只初始化一次、没有并发调用，线程锁不会被争用 |
| `514211d` · `6e7c2ed` 限流 / 缓存换 Redis SDK | 重构；限流我们自己修过（Redis 重启后 500 那次） |

### 不拿的

| 上游 | 为什么 |
|---|---|
| 🔴 `8ea214c` CORS 默认放开成 `*` | 往不安全的方向改。我们 prod 启动检查本来就拒绝 `*` |
| `98c697f` 删 MySQL 支持 | 我们保留三种库 |
| `c60408b` 删代码生成插件 | #180 早删了 |
| `8dc1b3f` 字段改名 `*_ids` · `9ec613e` `enabled` → `status` | 破坏接口兼容（根 `CLAUDE.md`「1.0 起的兼容约定」） |
| `2054c5b` · `2ea1001` · `e34e2ab` · `c5c0430` 性能小优化 | 在我们这里收益很小，不值得冒和自己的改动冲突的风险 |
| 其余（插件版本检查、查询参数模型、异常文案换 i18n key、格式、文档、依赖升级、版本号） | 功能 / 重构 / 杂项。依赖升级由 Dependabot 管 |
