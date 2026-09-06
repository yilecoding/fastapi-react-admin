# scripts —— 仓库级脚本

> 这份文件是根 [`CLAUDE.md`](../CLAUDE.md) 的**模块分册**，Claude Code 读到本目录下的文件时
> 才把它加载进上下文（惰性加载），所以它可以写得比根文件细。跨模块的硬纪律只在根
> `CLAUDE.md` 里有一份；**新增结论请追加到离代码最近的那一份**。

```
ctx-check.mjs        `pnpm ctx:check` —— 核对工程文档里的断言还成不成立
arch-check.mjs       `pnpm arch:check` —— 依赖箭头 / 多页签纪律 / 组件孤儿 / registry
gen-ui-registry.mjs  `pnpm ui:registry` —— 从源码 import 生成 packages/ui/registry.json
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

### 还有一条：品牌版本不能写死

`apps/web/src/lib/brand.ts` 的开头写着「改名字、改版本**只动这里**」，
而 `version` 原来手写着 `"v0.0.1"` —— 和 `apps/web/package.json` 的 `0.0.1`
是**两份真相源**。bump 了包版本忘了改它，登录页和页脚就长期显示旧版本，
**而没有任何东西会发现**（没人比对过这两个数，而且两个数长得一样）。

修法是消掉那份副本：版本从 `package.json` 注入成 `VITE_APP_VERSION`
（`vite.config.ts` 的 `define`，放主 config 而不是那个 `apply: "build"` 的
插件 —— dev 也该显示对的版本）。实测：把 `package.json` 改成 `9.9.9` 重新构建，
产物里就是 `v9.9.9`。**这一步验证是必要的** —— 不验的话「产物里是 v0.0.1」
既可能是派生成功、也可能只是字面量碰巧一样。

`hardcoded-version` 这条守卫防的是有人再写死回去，反向验证过。

⚠️ 回落值刻意写成 `v0.0.0` 而不是当前版本：万一注入没接上，
显示一个明显不对的数比显示一个碰巧对的数好。

### 下半场：多页签那三条硬纪律

| 规则 | 硬纪律 | 违反后的表现 |
|---|---|---|
| `page-reads-router` —— 页面组件不得调 `Route.useSearch/useParams` / `useNavigate` | 1 | 隐藏 tab 拿不到 match 上下文 |
| `route-renders-page` —— `routes/_auth/` 下的 `component` 必须是 `() => null` | 3 | 页面被挂两次 / 切走丢状态 |
| `unscoped-dom-query` —— `document.querySelector` 等必须带 `[data-tab=…]` 或 `[data-visible="true"]` | 5 | 命中隐藏页的 DOM |

这三条**当前全仓干净**，所以它们是回归守卫，不是在抓存量。值得做成闸门是因为
失败方式极难归因：违反了不报错，只会「切回这个 tab 时筛选条件没了」或
「测量到的是隐藏页的尺寸」，而人第一反应永远是去查那个功能本身。

三条同样做过反向验证（各注入一处违规 → 各自红），**而且验证了正确写法能通过** ——
`[data-tab="/_auth/monitor/server"] …` 和 `[data-visible="true"] …` 两种限定都放行。
只验「错的会红」不验「对的能过」，规则很容易变成误报陷阱。

⚠️ 三处判定上的讲究：

- **路径判断**：只管 `routes/_auth/` **目录下**的。`routes/_auth.tsx` 自己是布局、
  `__root.tsx` / `_guest/**` 在多页签体系之外，它们渲染组件是对的。
  第一版用 `includes('routes/_auth')`，把布局文件也框进来了
- **`document.getElementById` 也要管**：id 看着「全文档唯一」，但同一个页面被
  两个 tab 挂载时 id 就重了。允许清单里只有 `apps/web/src/main.tsx`
  的 React 挂载点（它跑在任何 tab 存在之前）
- **必须先剥注释**：`pages/` 下有 9 处注释在引用这三条规则本身
  （「内部不碰 `Route.useSearch()`」这类），裸 grep 会全部误报

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

### 组件库那三条（`orphan-component` / `unused-third-party` / `stale-registry`）

都是为 `packages/ui`「**被下游整包拿走自己改**」这个定位服务的
（见 [`PORTING.md`](../packages/ui/PORTING.md)）。

| 规则 | 级别 | 违反后的表现 |
|---|---|---|
| `orphan-component` —— 组件既没有生产调用方也没有沙箱 demo | error | 下家读到它，无从判断「这是能用的还是没写完的」 |
| `unused-third-party` —— `dependencies` 里的第三方包源码零引用 | warn | 下一个人以为「这个库我们直接在用」，照着它写新代码 |
| `stale-registry` —— `registry.json` 和源码的 import 图对不上 | error | `shadcn add` 照常成功、只是少拷一个文件，下家编译时才炸 |

三条都做过反向验证（造一个零调用方组件 / 加一条假依赖 / 改一处 import → 全部转红）。

⚠️ **`orphan-component` 认 demo，不只认生产调用方。** 沙箱就是这个库的目录，
一个组件有 demo = 有人真的把它跑起来过。`tree.tsx` 就是这么留下来的
（零业务调用方，但有 demo + 23 条纯逻辑单测）。

⚠️ **`unused-third-party` 只查 `dependencies`，不查 `devDependencies`** ——
工具链的包（eslint 插件、tailwind、类型包）本来就不该在源码里出现。
它的豁免表 `RUNTIME_ONLY` 里每一条都写了「凭什么是运行时依赖」：
CSS 入口 import 的、peerDependency、Expo 自动链接的原生模块。
**往里加之前先想清楚理由** —— 豁免表长得越快，这条规则越没用。

实测这条第一次跑就抓出 5 条真的死声明：`lucide-react`（全仓用的是 tabler）
在 `ui` 和 `web` 各一条、`zod` / `zustand` / `@tanstack/react-table` 声明在
用不到它们的包里。加上更早人工发现的 `date-fns`（其实是 `react-day-picker`
自己的依赖），一共 6 条。

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
| `missing-preamble` | 错误 | 分册 H1 之后没有「这份文件是…分册」的声明 |
| `wrong-preamble-kind` | 错误 | 该是子分册的声明成了模块分册（或反过来） |
| `wrong-preamble-link` | 错误 | 序言链到了错的父册 |
| `anonymous-title` | 错误 | H1 里没出现自己的目录名 |
| `budget` | 警告 | 根文件 > 400 行 / 分册 > 500 行 —— 该拆了 |

覆盖 **45 份**文档：`CLAUDE.md` / `AGENTS.md` 之外，还有 `README.md` /
`CONTRIBUTING.md` / `SECURITY.md` / `PORTING.md` / PR 模板。⚠️ 后面那几个是**后来才加进来的** ——
在那之前它们完全不在覆盖范围，而一次人工梳理就从里面翻出三条过期断言
（推荐了已被硬纪律否掉的命令 · Playwright 条数停在 44（实际 54）· 闸门清单少两道门）。
**新增一类文档时先问一句「ctx:check 扫得到它吗」。**

### 分册序言那四条：为什么格式也值得做成闸门

前四条新规则查的是**每份分册开头那段声明**，看着像格式洁癖，其实不是 ——
那段话带着两条给下一个人（和下一个 agent）的指令：
「惰性加载，所以可以写细」和「**新增结论追加到离代码最近的那一份**」。
缺了它，写文档的人不知道该往哪儿写，于是全堆进根 `CLAUDE.md`，
而根文件一超预算就开始掉注意力 —— 这正是这套分册结构要治的病。

实测（2026-09-05 全仓审）：28 份分册里 **3 份完全没有这段**，
另有 9 份措辞各不相同（模块分册长/短两版 + 子分册版混着用），
而「谁是谁的子册」压根对不上目录层级 —— 比如 `apps/web/e2e` 明明在
`apps/web` 底下，却声明自己直接挂在根上。

能做成闸门是因为判据**可推导**，不用维护名单：

| | 判据 | 声明该链到 |
|---|---|---|
| **子分册** | 目录的某个祖先也有 `AGENTS.md` | 最近的那个祖先 |
| **模块分册** | 没有这样的祖先 | 根 `CLAUDE.md` |

`anonymous-title` 是同一件事的另一半：同时挂着七八份分册时，
`# 生产部署` / `# 富文本编辑器` 这种标题不告诉你「这是哪个目录的规矩」，
而分册之间的区别恰恰是目录。判据取**目录名**不是完整路径，
所以 `# pages/menu —— 死链判定` 这种短写法照样过。

四条都做过反向验证（删掉序言 / 改错类型 / 链到别的册 / 把 H1 改回纯主题 → 全部转红）。

🔴 **它在 CI 里跑**（static job 的 `ctx` 步骤）。曾经不在 —— 一个「让机器核对
断言」的脚本自己没被自动核对过，只在有人想起来时才跑。

> 同一个形状又踩了一次：`packages/ui` 加了 86 条 vitest 之后，**CI 里没有任何
> 一步会执行它们** —— 两个 pytest job 直接调 `uv run pytest`、不走 turbo，
> 而 static job 只跑 typecheck / build / i18n / ctx / arch。现在补了
> `unit` 步（`pnpm test:js` = `turbo test --filter=!api`）。
> **排除式过滤不是偷懒**：列包名那种写法正是硬纪律 13 说的「漏了哪个包」，
> 而排除式让新增的 JS 包默认就在里面，不用改 CI。

它**不**校验文字对不对（那要人读），只校验「指向的东西还在不在」。
这一层能自动守住，剩下的才值得花人的注意力。

### 行数预算原来每个文件都多算 1 行

`ctx:check` 数行用的是 `raw.split('\n').length` —— 末尾换行后面那个空串
**被当成了一行**，于是每个文件的报数都 +1。一份正好 400 行、预算 400 的文件
会被报成「401 行超预算」。

这个 off-by-one 真的让人白削过文档：我为了把 `CLAUDE.md` 压回预算内，
连着删了几句真内容，最后才发现 `wc -l` 是 400、检查说 401。
已修成 `raw.replace(/\n$/, '').split('\n').length`。

判据：**闸门自己报的数字也要能对得上 `wc -l`。** 一个系统性偏 1 的阈值检查，
会让人反复付出「删掉一句真东西」的代价，而且每次都以为是自己写多了。

### 这套文档怎么自己长大

**修完一个静默失败的 bug，就在同一次改动里把结论追加到最近的那份分册。**
不是「以后有空补文档」—— 隔一天就只剩「改对了」，当时那个「为什么会
静默地错」的判断没了，而那才是这份文档唯一的价值。

判据是一句话：**违反了会坏，而且多数是静默地坏。** 风格偏好、
能从代码直接读出来的事实、一次性的调试过程，都不写。

写的时候用 `/ctx` 技能（`.claude/skills/ctx/SKILL.md`），它管三件事：
挑分册 · 按这里的文体写（症状 / 根因 / 修法 / **实测证据** 四件套）· 收尾跑校验。
