# apps/api

FastAPI 后端。**fork 自 [fastapi-best-architecture](https://github.com/fastapi-practices/fastapi_best_architecture)（FBA）**——
三层结构、插件机制、RBAC 与数据权限模型都是它的设计。本仓库在此基础上**新增了
SQL Server 支持**（现在同时支持 MySQL / PostgreSQL / SQL Server 三种数据库，
前两种沿用上游、SQL Server 是本仓库加的那一种）。

上游明确拒绝合并 SQL Server 支持，所以这是**永久分叉** —— 只 cherry-pick 上游安全补丁，
功能更新不跟。基线提交记在 [`.upstream-baseline`](./.upstream-baseline)。上游同为 MIT，
原始版权声明保留在 [`LICENSE`](./LICENSE)。后端架构文档看上游那份最全：
<https://docs.fba.wu-clan.cc>。

> 这个目录下原来有上游的 `README.md` / `README.zh-CN.md` / `CHANGELOG.md` / `CONTRIBUTING.md`。
> 它们讲的是 FBA 这个项目本身（logo、star 徽章、上游的 release 历史与贡献流程），
> 放在分叉里只会误导人以为这就是那个仓库，已经删掉。
> 需要时去上游仓库看，或从基线提交里取回。

## 文档在哪

| 想知道什么 | 看哪里 |
|---|---|
| 这个项目是什么、怎么起服务 | 仓库根的 [README.md](../../README.md) |
| **改代码前必读的硬纪律**（SQL Server 适配 · 雪花 ID · 分页 · 上传安全…） | 仓库根的 [CLAUDE.md](../../CLAUDE.md) 的「后端约定」「文件管理与附件预览」「跑测试」 |

## 相对上游的主要改动

- **SQL Server 适配**：`aioodbc` 驱动 · `UniversalStr`/`UniversalText`（NVARCHAR）· 分页强制
  `ORDER BY`（`OFFSET FETCH` 的要求）· 含可空列的唯一约束改用筛选唯一索引
- **雪花 ID 出口统一转字符串**（`utils/serializers.py: stringify_unsafe_ints`）——
  2^61 超出 JS 的 `Number.MAX_SAFE_INTEGER`，不转的话前端解析会把连续几个 ID 塌成同一个值
- **文件管理模块**：`sys_file` + `sys_file_relation`，带鉴权的下载接口，按日期分目录落盘
- **登录失败落日志**、操作日志敏感请求头打码
- **删掉了 `sys_menu.component` / `cache` 两列** —— 那是 Vue 运行时动态路由和 `<KeepAlive>`
  的遗留，前端是编译期文件路由，见 CLAUDE.md「已经删掉的东西，不要照上游加回来」

## 常用命令

```bash
uv sync --group dev                       # 装依赖（含 pytest）
pnpm --filter api dev                     # 起服务 :8000（--reload，只监听 backend/）
pnpm --filter api test                    # pytest
pnpm --filter api test:db                 # 重建单元测试库 fba_test
pnpm --filter api db:reset                # 清空开发库、按当前模型重建并灌种子（危险）
pnpm --filter api db:upgrade               # 只应用 Alembic 迁移，不清空数据
```

⚠️ **改模型不等于改表。** 没有 alembic 迁移历史（`alembic/versions/` 是空的），
schema 由 `MappedBase.metadata.create_all()` 从模型生成，而它**只建不改** ——
新增/删除列要手写 `ALTER` 或重建库。测试库直接 `test:db` 重建即可。
