# scripts —— 仓库级脚本

> 这份文件是[根 `CLAUDE.md`](../CLAUDE.md) 的**模块分册**，Claude Code 读到本目录下的文件时才加载它。

```
ctx-check.mjs        `pnpm ctx:check` —— 核对工程文档里的断言还成不成立
gen-brand-icons.mjs  `pnpm brand:icons` —— 从一份图形生成 favicon / 桌面 / 移动端图标
deploy-prod.mjs      `pnpm deploy:prod:*` —— 生产部署编排
```

🔴 **`gen-brand-icons.mjs` 是品牌图形的唯一真相源。** 改了图形或配色跑
`pnpm brand:icons` 重新生成，**不要手改生成产物**（favicon / 桌面图标 /
`apps/mobile/assets/images/*`）。

## ⚠️ 试过并否掉：把 `dead-path` 扩到**代码注释**

markdown 里的反引号路径基本都是真路径，所以 `dead-path` 在那儿信噪比很好。
**代码注释里不是**：那里合法地引用着一大堆长得像路径的东西。

实测（扫 `packages` + `apps/*/src` + `scripts` 的注释行）：**151 条候选，
真阳性约 2 条**，其余全是这几类合法引用 ——

| 误报类型 | 例子 |
|---|---|
| 后端 API 路由 | `` `/api/v1/auth/captcha` `` · `` `/users/me` `` |
| 前端路由 | `` `/monitor/online` `` · `` `/system/dept` `` |
| eslint 规则名 | `` `react-hooks/exhaustive-deps` `` |
| MIME 类型 | `` `application/x-www-form-urlencoded` `` |
| 运行时生成的文件 | `` `version.json` `` · `` `app-update.yml` `` |
| 无扩展名的模块路径 | `` `pages/log-login` `` · `` `shell/preferences` `` |

要压到可用的信噪比就得为上面每一类维护白名单，而白名单本身会腐烂 ——
**一个 1% 命中率的检查不会有人跑，或者会长出一张比它自己还长的豁免表。**

那 2 条真阳性是这么产生的：删掉一个文件之后，注释里指向它的引用没跟着删
（实测：删 `_shared` 的只读列表工厂时留下了两处）。**判据是人的：
删文件时顺手 `grep` 一遍文件名。** 那比一个噪音检查便宜。

## `pnpm arch:check`：让依赖箭头不漂

```bash
pnpm arch:check     # 已进 CI（和 ctx 同一个 job）
```

四条规则，核对 7 个 JS 包（`apps/api` / `apps/worker` 是 Python，只有一个
dev 脚本、零 JS 依赖，不参与）：

| 规则 | 级别 | 为什么 |
|---|---|---|
| `undeclared-import` —— import 了就必须在 `package.json` 里声明 | error | 那次 GHCR 构建事故 |
| `undeclared-path-mapping` —— tsconfig `paths` 映射了就必须声明 | error | 漂移的**上游**：人总是先加映射让它跑起来 |
| `wrong-direction` —— 箭头不能反（`ui → platform` 之类） | error | 反了会把分层吃穿 |
| `unused-declaration` —— 声明了没人 import | warn | 死声明会误导下一个读箭头的人 |

三条 error 都做过反向验证：删掉 `apps/web` 的 `@admin/platform` 声明
→ 前两条同时红；给 `packages/ui` 加上 `@admin/platform` → 第三条红。

首次跑就抓到一条真的：`packages/ui` 在 `package.json` 和 `tsconfig.json` 里
都声明了 `@admin/i18n`，但**全包无一处 import**（它直接依赖 `react-i18next`，
而 `packages/i18n` 也没有任何 `declare module` 类型增强）。已删。

### 两个写这个脚本时踩到的坑

🔴 **剥注释必须字符串感知，不能用正则。** 第一版是两条正则，结果把
JSON 字符串里的 glob 当成了块注释开头：`"@/*"` 里那两个字符一开，
就一路吃到 `include` 里某个 `.ts` glob 的块注释结束符，把 JSON 啃成碎片。

而它的**表现**是「解析不了 → 跳过这个文件」，报告照旧显示通过 ——
检查静默地停止覆盖了 `apps/mobile` 和 `apps/desktop` 两个包。
所以第二条：**解析失败一律算 error，不许降级成「跳过」**。
宁可炸，也不要假绿 —— 一个静默失效的闸门比没有闸门更坏，因为它还给人信心。

⚠️ **自引用要放行。** `packages/ui` 里到处
`import { cn } from '@admin/ui/lib/utils'` —— 那是 Node 标准的包自引用
（靠 `package.json` 的 `exports` 字段），不需要也不该声明自依赖。
第一版没放行，差点去「修」一个不存在的问题。

⚠️ 写这段说明的时候还踩了第三种形态：注释里写 `"**/*.ts"` 这样的 glob，
`*` 和 `/` 挨在一起就把**块注释自己**提前关掉了，脚本直接 `SyntaxError`。

## `pnpm ctx:check`：让文档不腐烂

这份文档全是**实测出来的结论**，而结论会过期 —— 过期的方式是**静默**的：
它照旧言之凿凿地指着一个已经不存在的文件。实测样本：这套规则第一次跑起来
就抓到「别用 command.tsx」这条 —— 那个 cmdk 组件早就删了，规则却还教了很久。

所以凡是能被机器核对的断言就让机器核对，和 `i18n:check` 同一个物种：

```bash
pnpm ctx:check          # 死引用 / 死链接 / 死脚本 / 死 testid / 行数预算
```

| 规则 | 级别 | 抓什么 |
|---|---|---|
| `dead-path` | 错误 | 反引号里的文件路径在仓库里找不到 |
| `dead-link` | 错误 | markdown 相对链接指向不存在的文件 |
| `dead-script` | 错误 | 反引号里的 pnpm 脚本没有任何 package.json 声明 |
| `dead-testid` | 错误 | 提到的 `data-testid` 源码里不存在 |
| `dead-anchor` | 错误 | 正文里的章节交叉引用指向一个全仓都不存在的章节 |
| `cross-file-anchor` | 错误 | 那一节在**别的分册**里 —— 拆分册最容易留下的债，改成相对链接 |
| `empty-scope` | 错误 | `AGENTS.md` 所在目录下没有源码（模块被搬走了） |
| `budget` | 警告 | 根文件 > 400 行 / 分册 > 500 行 —— 该拆了 |

覆盖 **40 份**文档：`CLAUDE.md` / `AGENTS.md` 之外，还有 `README.md` /
`CONTRIBUTING.md` / `SECURITY.md` / PR 模板。⚠️ 后面那几个是**后来才加进来的** ——
在那之前它们完全不在覆盖范围，而一次人工梳理就从里面翻出三条过期断言
（推荐了已被硬纪律否掉的命令 · Playwright 条数停在 44（实际 54）· 闸门清单少两道门）。
**新增一类文档时先问一句「ctx:check 扫得到它吗」。**

🔴 **它在 CI 里跑**（static job 的 `ctx` 步骤）。曾经不在 —— 一个「让机器核对
断言」的脚本自己没被自动核对过，只在有人想起来时才跑。

它**不**校验文字对不对（那要人读），只校验「指向的东西还在不在」。
这一层能自动守住，剩下的才值得花人的注意力。

### 这套文档怎么自己长大

**修完一个静默失败的 bug，就在同一次改动里把结论追加到最近的那份分册。**
不是「以后有空补文档」—— 隔一天就只剩「改对了」，当时那个「为什么会
静默地错」的判断没了，而那才是这份文档唯一的价值。

判据是一句话：**违反了会坏，而且多数是静默地坏。** 风格偏好、
能从代码直接读出来的事实、一次性的调试过程，都不写。

写的时候用 `/ctx` 技能（`.claude/skills/ctx/SKILL.md`），它管三件事：
挑分册 · 按这里的文体写（症状 / 根因 / 修法 / **实测证据** 四件套）· 收尾跑校验。
