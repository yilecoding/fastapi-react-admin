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
