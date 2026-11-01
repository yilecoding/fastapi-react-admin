---
title: 功能总览
description: fastapi-react-admin 自带的全部功能，按领域列出：权限与数据范围、导入导出、审批、AI 助手、开放平台、文件、消息、运维与客户端。
sidebar:
  order: 0
---

下面列的都已经在 `main` 上。有单独介绍页的领域带了链接。

| 领域 | 内容 |
|---|---|
| **权限与组织** | RBAC（菜单 / 按钮 / 数据范围）· [行级数据权限](/zh-cn/features/data-permissions/) · 部门树 · 用户与角色 |
| **导入导出** | 服务端 xlsx / csv 导出（按当前筛选或勾选行 · 大数据量转后台任务，完成后通知 · 防公式注入）· 通用导入（模板带下拉 · 预览校验 · 只新增 / 新增或更新 / 只更新 · 错误报告 · 全部成功才落库）· 一个文件建出整棵部门树 |
| **登录与安全** | 验证码 · 登录锁定 · 密码历史与过期 · OAuth2（GitHub / Google）· 强制下线 |
| **工作台** | [多页签保留状态](/zh-cn/features/multi-tab/)（固定 / 拖拽 / 刷新）· 命令面板 ⌘K · 快捷键 · 功能引导 · 主题 / 圆角 / 页签样式 · 按用户设时区 · 中英双语 |
| **文件与存储** | [带预览的文件管理](/zh-cn/features/file-storage/)（pdf / docx / xlsx / 图片 / 压缩包）· 本地 + S3 兼容存储 · 预签名下载 · 回收站 · 秒传 · 分片断点续传 · 任意页面可挂的附件面板 |
| **审批流** | [表单设计器 · 流程树](/zh-cn/features/approval-workflow/)（审批 / 抄送 / 条件分支）· 同意 / 拒绝 / 转交 / 退回 / 撤回 / 加签 · 超时提醒与自动处理 · 草稿 · 加急 · 离职交接 |
| **AI 助手** | [整页对话 + 侧滑抽屉](/zh-cn/features/ai-assistant/) · 工具调用受权限和数据范围约束 · 写操作先预览再确认 · 审计日志 · MCP 网关 |
| **开放平台** | [AK/SK 签名接口](/zh-cn/features/open-api/) · 权限范围 / IP 白名单 / 防重放 / 限流 · 调用日志 · 增量同步 · Python / Node / Java SDK |
| **消息与任务** | [站内通知、通知公告与渠道路由](/zh-cn/features/notifications/)（邮件 / 短信 / 群机器人）· 定时任务（在线调度 · cron 预览 · 执行记录） |
| **运维** | 参数配置 · 字典 · 登录 / 操作日志（已脱敏）· 服务器与 Redis 监控 · 新版本提示 · 给外部监控用的[统一健康检查地址](/zh-cn/getting-started/deployment/#外部监控探哪个地址) |
| **数据库** | [PostgreSQL · SQL Server · MySQL](/zh-cn/features/databases/)，同一套代码、同一条迁移链 |
| **客户端** | [Electron 桌面端](/zh-cn/features/clients/)（静默打印 · 本地硬件 · 自动更新）· 原生 Expo App（不是 WebView 套壳） |
| **开发者** | 组件沙箱（每个组件都能调参、复制代码）· 调色板 · 从 OpenAPI 生成的类型安全接口契约 |

## 工程规矩写在哪

仓库把规矩和踩过的坑写在代码旁边：根目录的 [`CLAUDE.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/CLAUDE.md) 加 40 多份模块分册（`AGENTS.md`），按任务索引（「加列表页」「改权限模型」「写迁移」）。每条都是同一个格式——现象、原因、修法、证明它的实测或测试；CI 里跑 `pnpm ctx:check`，文档指向的文件、脚本或 testid 不存在了就报错。

## 不装能先试试吗

可以：登录[在线演示](https://fra.wubunan.com/sign-in)，账号 `admin` / `123456`。所有人共用这一个实例，数据可能随时被别人改掉，版本也可能比 `main` 落后一两个。
