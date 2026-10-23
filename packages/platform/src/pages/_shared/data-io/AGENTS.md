# pages/_shared/data-io —— 导入导出（#11 · v0.4）

> 这份文件是 [`pages/_shared` 分册](../AGENTS.md) 的**子分册**（列表页的总纲在 [`pages` 分册](../../AGENTS.md)），Claude Code 读到本目录下的
> 文件时才把它加载进上下文（惰性加载）。跨模块的硬纪律只在根 `CLAUDE.md` 里有一份；
> **新增结论请追加到离代码最近的那一份**。

| 文件 | 提供 |
|---|---|
| `export-button.tsx` | `ExportButton`：选格式（xlsx / csv）、选范围（当前筛选 / 选中的行），链到「导出记录」 |
| `import-sheet.tsx` | `ImportSheet`：模板 → 预览（模式 / 排除行 / 错误报告）→ 提交（部分成功或全有或全无） |
| `api.ts` | 两者的接口层：`useStartExport` · `myExportsQuery` · `useImportPreview` · `useImportCommit` · 下载 |

后端是一个通用框架（[`common/dataio` 分册](../../../../../../apps/api/backend/common/dataio/AGENTS.md)），
每个资源登记一份定义；前端也只有一份：`export-button.tsx` 和 `import-sheet.tsx`，
页面只传接口前缀。现在接了的：

| 页面 | 导出 | 导入 |
|---|---|---|
| 用户 | `sys:user:export` | 超管（`DependsSuperUser`，只新增） |
| 部门 | `sys:dept:export` | `sys:dept:import`（三种模式，一份文件能建一整棵树） |
| 字典项 | `dict:data:export` | `dict:data:import`（三种模式，跨类型） |
| 通知公告 | `sys:notice:export` | —— |
| 登录日志 / 操作日志 | `log:login:export` / `log:opera:export` | —— |

## 导出（`ExportButton`）

- 🔴 **筛选参数原样交给后端**（`filters` 就是列表接口的入参，不含 page / size），
  所以「导出的就是列表看到的那批」。拼错一个参数名后端会**拒绝**、不是忽略 ——
  忽略的话导出的是全表，而用户以为是筛过的
- **列是资源定义的全量字段**，不是表格上看得见的那几列：导出里有编码、ID 这些表格不显示的列，
  正是它们让「导出 → 改 → 原样导回」成立
- 小批量当场生成、直接下载（`status = 2`）；大批量返回排队中（`status = 0`），生成完发
  站内消息，链到个人中心的「导出记录」（`/profile?section=exports`，`../../profile/exports-panel.tsx`）。
  **两种都是 200** —— 按 `status` 分支，不要按「请求成没成功」
- 两个日志页原来是前端按页拉全量拼 CSV：拉到 20 页（200 条一页）就停 —— 超过 4,000 条**静默截断**；
  失败登录记的是请求里填的用户名，`=…` 原样进了 CSV。权限码也是借的 `log:*:del`，现在是独立的 `log:*:export`
- 文件名用后端起的（`Content-Disposition`，按当前语言），前端只留兜底名。🔴 跨源时这个头要在
  后端 `CORS_EXPOSE_HEADERS` 里列出来，否则 `headers.get()` 拿到 `null` —— 不报错，只是静静地用了兜底名
- 下载一律走 `api-client/download.ts`（带 Authorization 头取字节再存）。**不能做成 `<a href>`**：
  裸链接带不上头，存下来的是 401 的 JSON，而文件管理器只会说「文件已损坏」

## 导入（`ImportSheet`）

两阶段：预览只校验不落库 + 一个存 Redis 的一次性令牌；提交带令牌，默认部分成功。

- 🔴 **上传用 `uploadFile()` 不是 `api.POST`**（`api-client/client.ts`）。它是
  multipart，而且成败判定过 `resolveEnvelope` —— FBA 的 `fail()` 是
  **HTTP 200 + `code: 400`**，只看 `res.ok` 会把被拒的上传当成功
- 🔴 **令牌是一次性的**，服务端在写库**之前**就删掉它（双击 / 重试不会写两遍）。所以提交失败后
  不能原地重试 —— 界面要把用户送回「重新选文件」，而不是留一个点了没反应的按钮
- 🔴 **换了导入方式要重新预览**：令牌绑着预览时的模式（同一行在「只新增」下是错、在「新增并更新」下是更新），
  抽屉里换模式会拿同一个文件重跑预览
- 🔴 **「未识别的表头」必须显示出来。** 列名拼错时整份文件照样解析成功，只是那一列的数据**全丢了**
- 「全部成功才导入」（`atomic`）是用户选的：勾上之后提交时有一行写不进去，这一批一行都不写；
  结果页第一句就要说「一行都没写入」，否则用户会以为前面那些成功了
- 有问题的行能下载「错误报告」：原样的单元格 + 行号 + 原因，改完那几行直接再导（多出来的两列会被忽略）
- ⚠️ **换同一个文件要先清 `input.value`。** 用户改完 Excel 再选**同一个文件**不会
  触发 change 事件，表现成「点了没反应」，而文件确实变了
- ⚠️ **抽屉宽度要写 `data-[side=right]:sm:max-w-3xl`**，裸 `sm:max-w-3xl` 无效
  （`cn()` 是 tailwind-merge，只在同一变体作用域内消解冲突，基础类
  `data-[side=right]:sm:max-w-sm` 会赢）。**这条踩过**：类在、宽度没变，
  「校验」那一列被挤出视口 —— 错误信息在 DOM 里，文本断言全绿，
  只有截图才看得出用户根本看不见。规则见
  [`packages/ui` 分册](../../../../../ui/AGENTS.md) 的「为什么有些覆盖有效、有些无声失效」
- 预览表只摆 `previewKeys` 那几列：部门有 8 列，全摆的话「校验」那一列又被挤出去了
- 🔴 **「校验」列紧跟行号，不放最后。** 390 宽的手机上数据列一多，最后一列就在视口外 ——
  错误信息在 DOM 里、E2E 全绿，人却得横着拖才看得见。和上面那条抽屉宽度是同一类坑，**只有截图看得出来**
- ⚠️ **不要用中文标点拼东西**：多条错误原来 `join('；')`、列名清单 `join('、')`，英文界面里就是
  `…sign. ；Department…`。错误一条一行；清单走 `Intl.ListFormat(语言, { type: 'conjunction', style: 'narrow' })`
  （中文「A、B、C」，英文「A, B, C」）

**目测证据**（2026-10-22，Playwright 截图：中 / 英 × 浅 / 深 × 1440 / 390）：上面两条，加上后端的两条
（邮箱错显示「值错误，{error}」、状态手打「启用」被拒，见 [`common/dataio` 分册](../../../../../../apps/api/backend/common/dataio/AGENTS.md)）
和「列」面板的空白带（`PopoverContent` 基础类带 `gap-4`）—— **五处全部是测试绿着的时候截图看出来的**。
动这一屏之后至少截一次 390 宽、一次英文

