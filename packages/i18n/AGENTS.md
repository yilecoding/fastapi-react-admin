# packages/i18n —— 多语言（中文原文即 key）

> 语言包、两个校验脚本、后端出口翻译。**不依赖任何 workspace 包**（连 react-i18next 都不依赖）。
>
> 这份文件是根 `CLAUDE.md` 的**模块分册**，Claude Code 在你读到本目录下的文件时
> 才把它加载进上下文（惰性加载），所以它可以写得比根文件细。跨模块的硬纪律
> 仍然只在根 `CLAUDE.md` 里有一份。新增结论请追加到**离代码最近**的那一份。

## 国际化（`packages/i18n` · 中文原文即 key）

**已做**：后端 msg 全量翻译 · 前端 1191 条 key（含菜单标题、接口 summary、
插件元信息）· 语言切换。全站扫下来只剩**用户自己录的业务数据**（见文末「边界」）。
**没做**：部门 63 / 角色 88 / 数据范围与规则 16 / 字典 33 / 公告 27 这些纯业务数据；
`dev-sandbox` / `playground-*` / `ui/data-grid` 是沙箱与在建组件，
刻意不纳管（`check.mjs` 的 `SKIP_DIRS` 里列着）。
`ui/query-bar` **已经从 SKIP_DIRS 里拿出来了** —— 它要用在全站列表页上，
不纳管等于每个列表页的筛选栏在英文下都是中文。
（两个脚本的 SKIP 列表要一起改，`jsx-text.mjs` 那份是另一处。）

### 包结构（参照 Rocket.Chat 的 `packages/i18n`）

```
packages/i18n/
├─ src/locales/zh-CN.json     基准语言（恒等映射：key 与值都是中文）
├─ src/locales/en-US.json     译文
├─ src/index.ts               i18next 实例 · LANGUAGES · changeLanguage · menuKey
│                            · 模块级 t() · formatNumber/Time/Date/Duration
├─ src/server-data-keys.json  后端数据里的中文（见「白名单」）
└─ src/scripts/check.mjs      校验器，`pnpm i18n:check` / `pnpm i18n:fix`
```

语言文件**不放在 app 里** —— 文案来自 `ui` / `platform` / `web` 三层，
放 app 会让最底层 `ui` 的文案存在最上层，分层就反了。

⚠️ **`packages/i18n` 不依赖 `react-i18next`**（保持框架无关）。
React 绑定 `initReactI18next` 在 `apps/web/src/i18n.ts` 里通过
`initI18n([initReactI18next])` 注入。**忘了注入的后果很隐蔽**：
`useTranslation()` 会绑到 react-i18next 自己的空实例上，`t()` 原样返回 key ——
界面看起来「全是中文」（因为 key 就是中文），连插值都不做，
分页条直接显示 `共 {{total}} 条`。实测踩过。

同理，「切语言时同步接口 `Accept-Language`」也在 app 层用
`onLanguageChange()` 订阅 —— 那需要 import platform 的 api-client。

### key 策略：中文原文即 key

```tsx
const { t } = useTranslation()
<span>{t('每页')}</span>
{t('已选 {{n}} 项', { n })}
```

GitLab（gettext，英文原文即 msgid）和 VS Code（`l10n.t()`）都是这个路线。
**刻意不抄 Rocket.Chat 的 `Department_name` 式符号 key** —— 那是他们英文优先的
结果而不是独立最佳实践（他们的 zh-CN 也只是英文译文）。我们中文优先，
符号 key 会把「漏一条 zh 条目 → 屏幕上出现 raw key」变成常态失败模式。

`zh-CN.json` 是**恒等映射**。放它的意义：文案有一处可集中修改；
最坏情况（漏条目）也只是回落到 key，而 key 本身就是中文。

### 菜单标题：key 用 **path**，不用标题

```tsx
t(menuKey(node.path), { defaultValue: node.title })
```

标题存在数据库里、管理员随时能改，用它当 key 改一次文案就失效；
而 `path` 是菜单管理页从**前端真实路由下拉选**的，是这套数据里最稳的东西。
`defaultValue` 回落库里的中文标题 —— 管理员新建的菜单**永远不会露 raw key**。
`tab-item.tsx` 用 `href` 的 pathname 同理。

### ⚠️ `menu:` 开头的 key，值必须是**标题**，不能是路径本身

`zh-CN.json` 里曾经有一条 `"menu:/403": "/403"`（en-US 那条是 `"Access denied"`，
是对的）。于是「无权访问」这个页面进标签条时，**中文界面上显示的是 `/403`**，
英文界面正常 —— 而路由那边 `staticData.title` 明明写着「无权访问」。

链路：标签条渲染的是 `t(menuKey(pathname), { defaultValue: t(tab.title) })`。
key 存在就用 key 的值，`defaultValue` 根本轮不到 —— 所以「值写错成路径」这件事
**不会**被 `i18n:check` 抓到（key 在、译文非空、占位符也一致），只能靠人看见。

写 `menu:*` 条目时对着菜单标题写，别把回落用的那个字符串顺手填进去。

### 五条硬规则

1. **`keySeparator: false` + `nsSeparator: false`**。删了会**静默出错**：
   默认 `.` 会把 `smtp.qq.com` 切成嵌套路径，默认 `:` 会把 `最后更新 14:58`
   和 `menu:/system/dept` 当成「命名空间:key」
2. **只许传字符串字面量**。`t(label)` / `` t(`第 ${n} 页`) `` 校验器看不见 ——
   和 GitLab 文档同一条规则。动态文案用插值 `t('第 {{n}} 页', { n })`
3. **模块级常量翻不了**（加载时求值、切语言不更新）。但因为 key 就是中文原文，
   在**渲染组件**里 `t(变量)` 就行 —— `STATUS_META`、页面里的 `XXX_ITEMS`
   和它们的调用点一个都不用改。这是「原文即 key」最实用的好处
4. **参数默认值里不能调 hook**。`emptyMessage = '暂无数据'` 要改成
   `emptyMessage` + 渲染处 `?? t('暂无数据')`
5. **普通函数不能调 hook**。`buildColumns()` 是在 `useMemo` 里被调用的普通函数，
   自己 `useTranslation()` 会让 React 抛
   `Should have a queue. You are likely calling Hooks conditionally` 直接白屏 ——
   把 `t` 当参数传进去。它的 `t` 参数签名要写成
   `(k: string, vars?: Record<string, unknown>) => string`，
   写成 `(k: string) => string` 的话带插值的调用会编译不过

### 一句话里夹了 `<code>` / `<strong>` 就得用 `<Trans>`

拆成「前半 t() + `<code>` + 后半 t()」在中文下看不出问题，换英文语序一变就散架
（而且那两半会变成两条谁也读不懂的碎 key）。整句一个 key，标签走 `components`：

```tsx
<Trans
  t={t}
  i18nKey="该插件 extend 到 <code>{{app}}</code>，实际挂载路径会带上宿主应用的段。"
  values={{ app: info.app.extend }}
  components={{ code: <code className="font-mono" /> }}
/>
```

`check.mjs` 认 `i18nKey="…"`，所以这类 key 一样受 missing-keys 保护。

### 模块级 `t()`：给 api.ts、纯函数、抛异常的地方

`packages/i18n` 导出一个不带 hook 的 `t()`。它读的是**调用瞬间**的语言、不订阅变更，
所以只能用在「每次都会重新调用」的位置：mutation 里抛的 `new Error(t('…'))`、
`remainingText()` 这种 render 期间算的派生文案、`registry.ts` 的校验信息。
组件里的静态文案一律 `useTranslation()`，否则切语言不重渲染。

### zod 校验信息：定义处不动，渲染处翻

schema 是模块级常量，拿不到 hook。但 key 就是中文原文，于是用
`pages/_shared/form-error.ts` 的 `useFieldError()`：

```tsx
const fe = useFieldError()
<Field label={t('用户名')} error={fe(errs.username?.message)} />
```

### 时长/时间不要在后端拼中文

原来 `utils/format.py: fmt_seconds()` 在后端就把「3 天 5 小时」拼好了，
英文界面上这一格永远是中文。接口改成下发 `*_seconds`（`uptime_seconds` /
`elapsed_seconds`），成句交给 `packages/i18n` 的 `formatDuration()`。
**新增任何「时长」字段都照这个来 —— 后端只发数值。**

### 🔴 服务端时间一律过 `src/datetime.ts`，不许裸打印 / 切片 / 字典序比较

后端下发的时间**不是给人看的字符串，是一个瞬间**。原来前端到处直接当字符串使：
`{file.created_time}` 裸渲染、`.slice(5, 16)` 截短、`.slice(0, 10)` 当分组键、
`.localeCompare()` 排序。这些能跑是因为凑巧同时满足两个前提 ——
后端下发 `'2026-08-22 11:59:47'`（Asia/Shanghai 墙上时间），**且看的人也在东八区**。
任一前提不成立，界面上的时间就是错的，而且**不报错**。

后端已改成下发带偏移的 ISO 8601（见 [api 分册](../../apps/api/AGENTS.md) 的
「后端国际化」邻节），时区在**显示时**才出现。工具包 `packages/i18n/src/datetime.ts`：

| 函数 | 给谁用 |
|---|---|
| `formatDateTime` | 默认选择。`2026-08-22 11:59:47`，**固定格式不跟 locale** |
| `formatDateTimeShort` | 宽度紧张处。`08-22 11:59`（原 `.slice(5, 16)` 想做的事） |
| `dateKey` | 按天分组统计（原 `.slice(0, 10)` 想做的事） |
| `toEpochMs` | 排序、比较、算差 |
| `formatDate` / `formatTime` | 只要日期或只要时刻，这两个**跟 locale** |
| `setDisplayTimeZone` | 切显示时区；不调就跟浏览器 |

**显示时区从哪来**：`sys_user.timezone`（每人一份，存服务端），由
`platform/src/auth/queries.ts` 的 `meQuery` 在 **queryFn 里**调
`setDisplayTimeZone(me.timezone)`。放 queryFn 不放 `useEffect` 是刻意的 ——
`formatDateTime` 读模块级变量、**不是响应式的**，effect 里设的话已经渲染完的
表格不会重渲染、会一直用旧时区；在 queryFn 里设则保证 `me` 被任何组件读到之前
时区已经对了，也没有「先按浏览器时区闪一下再跳」。
（后端那一侧、以及为什么服务端仍是单时区，见 [api 分册](../../apps/api/AGENTS.md) 的「时区」。）

`formatDateTime` **刻意不跟 locale**（和 `formatNumber` 取向相反）：它渲染的是
日志/审计类机器时间，几乎总在表格里配 `font-mono tabular-nums`，跟 locale 走会得到
`8/22/2026, 11:59:47 AM` —— 宽度不定列对不齐，而且 `M/D/Y` 对中文用户是歧义的。

🔴 **最危险的是 `.slice(0, 10)` 当日期键**：切 ISO 串拿到的是 **UTC 的**年月日，
东八区早上 8 点之前的记录会被算进前一天。仪表盘的「近 7 天登录趋势」踩过 ——
柱子少一天多一天，不报错、不空白，只是数字悄悄对不上。同一个文件里 `days[]`
还是用 `new Date().getDate()`（**浏览器**时区）生成的，两套时区框架混用。
现在两边都走 `dateKey()`。

⚠️ 解析对**无时区标记**的串保留了兜底（按 `Asia/Shanghai` 解释）。这不是洁癖，
是因为「改动前签发的 token」里还存着旧格式：实测切换后在线会话里 200+ 条旧格式
和新登录的 ISO 并存，要等 token 过期才换完。没有兜底的话这些旧值会被
`new Date()` 按浏览器时区解释 —— 非东八区的机器上整体偏移几小时。

### 校验器（`pnpm i18n:check`，`pnpm i18n:fix` 自动修）

规则挑自 Rocket.Chat 的 `check.mts`：

| 规则 | 级别 |
|---|---|
| `sort-keys` 基准语言排序、其他语言跟随（diff 可读） | 错误，可 --fix |
| `missing-keys` 代码里 `t('…')` 用到但语言包里没有 | **错误** |
| `missing-placeholder` 译文丢了基准语言有的 `{{var}}` | **错误**（i18next 会渲染成空） |
| `extra-placeholder` 译文凭空多出 `{{var}}` | **错误**（会渲染字面量 `{{var}}`） |
| `extra-keys` 语言包里有、代码里已无 | 警告，可 --fix |
| `missing-translation` / `untranslated` | 警告 |
| `shadowed-t` 声明了叫 `t` 的变量/回调参数 | **错误** —— 见下 |
| `stale-server-keys` 白名单里已不在语言包的键 | 警告 |
| 动态 key 候选（`t(变量)` 形态） | 仅提醒 —— 对象值里的中文不一定真走 `t()` |

扫描前**先剥注释**。不剥的话中文注释里的成对引号（`用 'a' 而不是 'b'`）会被当成
字符串字面量，动态 key 提醒里塞进几百条散碎片段（实测 369 → 240，全是噪声）。

#### 白名单 `server-data-keys.json`

后端数据里的中文（`sys_config.name` 61 · 接口 `summary` 108 · 插件 `summary`/
`description` · 公告类型…）在代码里**根本不会出现** —— 渲染处写的是
`t(item.name)`，值来自数据库。没有白名单 `extra-keys` 会把它们全判成孤儿，
**`--fix` 一跑就整片删掉**，英文界面上这些字段瞬间回中文。
后端加了配置项 / 接口就往这里补一条（同时补两个语言包）。

#### JSX 文本节点是校验器的盲区 —— 单独一个 `pnpm i18n:jsx`

`t('…')` 正则只看**字符串字面量**，而 `<IconPencil />编辑` 里的「编辑」是 JSX
**文本节点** —— `check.mjs` 一个字都看不见，界面上却是明明白白的中文
（第一次跑出来 114 处，每个 ⋯ 菜单里的「编辑 / 删除」都在里面）。

`scripts/jsx-text.mjs` 做反向扫描：剥注释 → 把字符串/模板字面量掏空 →
剩下的中文只可能是 JSX 文本。**干净状态下输出 0 处**，非 0 就退出码 1。
两个脚本要一起跑，缺一个都会漏：

```bash
pnpm i18n:check   # t('…') 的 key 有没有进语言包 + shadowed-t
pnpm i18n:jsx     # 有没有压根没进 t() 的裸中文
```

#### 🔴 剥注释必须是**字符串感知**的（`strip-comments.mjs`）

两个脚本都先剥注释再扫。原来用的是裸正则 `/\/\*[\s\S]*?\*\//g`，
**它会把字符串里的 `/*` 当成块注释开头**：

```tsx
<input accept="image/*" />     // ← 这里开始「注释」
…
{t('上传图片')}                 // ← 被吃掉了，扫不到
```

一路吃到文件里下一个 `*/`。实测：`profile/index.tsx` 加了 `accept="image/*"` 之后，
它下面 6 条 key 全被判成「代码里已无此 key」的孤儿 —— 而 **`--fix` 会把孤儿从语言包里
删掉**，英文界面上那几处直接回落中文；missing-keys 同时瞎掉（key 明明在代码里却报缺失）。

反方向的坑同样存在：CSS-in-JS 的注释藏在**多行模板字面量**里
（`-sign-in-brand.tsx` 有一个 `` `…` `` 装 CSS，里面是中文注释）。字符串内容原样保留时，
`jsx-text` 会把它们当成裸露的 JSX 中文报出来 —— 而 jsx-text 原来那几条**逐行**的
引号正则看不见跨行的模板字面量。

所以 `strip-comments.mjs` 逐字符扫，两种模式：

| 模式 | 用在 | 行为 |
|---|---|---|
| `blankStrings: false` | `check.mjs` | 字符串整段原样留着 —— key 藏在里面 |
| `blankStrings: true` | `jsx-text.mjs` | 字符串内容抹成空格，只找字符串**外面**的中文，模板字面量跨多少行都抹干净 |

`keepLines: true` 保留行号（jsx-text 要报行号）。另外 `\/` 后面的 `/` 不算行注释开头，
否则正则字面量 `/^https?:\/\/\S+$/` 会把自己那行的后半截吃掉。

> 新增这类脚本时**不要**再写裸的注释正则。

#### 另外三个盲区，脚本兜不住，只能靠纪律

1. **`{}` 表达式里的字面量**。`{isEdit ? '保存修改' : '创建用户'}` 既不是 JSX 文本
   （在花括号里）、也不在 `t()` 里 —— 两个脚本都看不见。**所有表单的提交按钮
   曾经全是裸中文**，就是这么漏的。
2. **`「」『』（）` 不在 `[一-鿿]` 区间里**。`` `「${username}」` `` 这种只由标点 +
   变量组成的片段，missing-keys 抓不到，英文界面还会渲染中文书名号。
3. **`.map(h => t(h))` 是动态 key**。CSV 表头写成 `['序号','登录时间',…].map(t)`
   看起来很干净，但校验器一条都抽不到 —— 要展开成 25 个 `t('序号')` 字面量。

#### Select 的 `items=` 是**关闭态**的标签源

`items={STATUS_ITEMS}` 传中文常量进去，等于关闭态永远不翻（下拉展开时才对）。
一律在渲染处 `useMemo` 映射一遍：

```tsx
const statusItems = React.useMemo(
  () => Object.fromEntries(Object.entries(STATUS_FORM_ITEMS).map(([v, l]) => [v, t(l)])),
  [t]
)
```
**`useMemo` 的 deps 必须带 `t`** —— 漏了的话会话内切语言不重算，标签留在旧语言
（`columns` 的 `useMemo` deps 写成 `[]` 也是同一个 bug）。

#### 一个 key 只能有一个意思

`关闭` 曾经译成 `Off`，而它 8 处用法里 7 处是「关闭抽屉/标签页」= `Close` ——
于是所有抽屉的关闭按钮在英文下都显示 `Off`。**判给多数方**（`Close`），
开关那一处换成独立的 `已开启` / `已关闭`。
同类：`引用`（Reference）不能给富文本的引用块用，另起 `引用块`（Blockquote）。

### 后端侧：前端传 `Accept-Language`，后端在**响应出口**翻

```
前端 client.ts (setApiLanguage)     →  Accept-Language: en-US
  ↓
I18nMiddleware.dispatch             →  ctx.language = 'en-US'   ← **请求级**（starlette-context）
  ↓
出口翻译                             →  t(点分隔键) / tm(原文查表)
```

`ctx.language` 走 starlette-context 的请求作用域，**不是全局单例**——
并发下不会串语言。（`i18n.current_language` 在请求周期外访问会抛
`ContextDoesNotExistError`，这正是它请求级的证据；写单测要用
`with request_cycle_context({'language': lang}):`。）

**两套翻译函数并存是刻意的**：

| | 入参 | 用在哪 | 语言包位置 |
|---|---|---|---|
| `t()` | 点分隔**键**（`response.success`） | `CustomResponseCode` 枚举、pydantic 校验 | `error` / `pydantic` / `response` 段 |
| `tm()` | **原文**（中文字面量） | 业务代码 189 处 `msg='中文'`（28 个文件） | `messages` / `message_templates` 段 |

`tm()` 存在的理由：逐个改成 `t('error.user.not_found')` 会在 fork 里铺开 28 个文件的
冲突面，而出口翻译**调用点一行都不动**。两级查找：`messages` 精确匹配 →
`message_templates` 模板匹配（`{}` 占位生成正则去套）→ 查不到原样返回。

#### 出口必须收全 —— 漏一个出口就漏一整类响应

| 出口 | 翻法 |
|---|---|
| `exception_handler.py` 4 处 | `tm(str(exc.msg))` / `tm(str(exc.detail))` |
| `ResponseBase.__response()` | `tm(res.msg)` |
| `ResponseBase.fast_success()` | `tm(res.msg)` |

> **`response_schema.py` 那两处曾经是漏的**：`CustomResponseCode` 的 msg 由
> `CustomCodeBase.msg` 的 `t()` 翻过了，看起来没问题 —— 但
> `CustomResponse(code=200, msg='插件 x 安装成功…')` 是**裸中文字面量**，
> 直接漏进响应。而语言包里那两条模板一直都在，成了**死条目**。
> `tm()` 对已翻过的 msg 是幂等的（查不到表就原样返回），所以在出口无脑套一层是安全的。

#### `CustomResponseCode` 的值必须是点分隔键，不能写中文

`HTTP_500 = (500, '服务器内部错误')` 曾经这么写 —— `t()` 拿它当 key 去查，
查不到就原样返回，于是 500 的 msg **在任何语言下都是那句中文**。
（`HTTP_200` / `HTTP_400` 用的是 `response.success` / `response.error`，就它不一致。）

#### 反向缺口：框架抛的文案是**英文**的

FastAPI 的 `HTTPBearer` 抛 `Not authenticated`、starlette 抛 `Method Not Allowed` ——
**中文界面下这些才是需要翻的那一方**。`tm()` 原来无条件在默认语言短路，
所以中文界面永远露英文。短路条件已改成「默认语言 **且** 该语言没有 `messages` 表」，
`zh-CN.yml` 补了一个 `messages` 段放这类英文→中文的映射。
业务中文查不到就原样返回，所以这一段只会命中英文，不会误伤中文。

#### 中间件：认不出的语言必须回落

`lang_mapping.get(lang, lang)` 把没映射的语言原样返回过 —— `I18n.t()` 查不到语言包时
会把 key 整个换成 `error.language_not_found`，于是**所有**响应的 msg 都变成
「当前语言包未初始化或不存在」。实测：日文浏览器访问，连 `请求成功` 都是那句话。

### 两个容易踩的

- **别把 map/回调的变量命名成 `t`** —— 会遮蔽翻译函数。**已经踩过 15 处**，
  所以 `check.mjs` 有一条 `shadowed-t` 硬规则专门挡它（在 import 了翻译函数的文件里，
  扫 `(t) =>` / `function (t` / `const|let|var t =` / `for (const t of`）。
  形态五花八门：`TABS.map((t) => …{t.label})`（role/profile 两处 tab 从来没翻）·
  `const t = setTimeout(…)` · `tags.forEach((t) => …)` ·
  `const t = tone ?? usageTone(pct)` · `ToastItem({ toast: t })` ·
  `const t = Date.parse(…)` · `railIdOf` 里 `const t = item.type`。

  > 为什么必须靠静态规则：它**不一定报错**。`{t.label}` 里 t 是对象时 tsc 能拦
  > （"has no call signatures"），但 `const t = 5` 之后调 `t('x')` 要到运行时才炸，
  > 而"返回原文"那种写法连炸都不炸 —— 静默不翻，只能靠人眼在界面上发现
- **默认参数值里不能调 hook**（`placeholder = '选择日期范围'`、
  `title = t('管理平台')`）—— 默认值在 hook 之前求值。改成 `placeholder?: string`
  + 渲染处 `?? t('…')`
- **数字/时间格式化走 `packages/i18n`**（`formatNumber` · `formatDateTime` ·
  `formatDate` / `formatTime` · `dateKey`，见上面「服务端时间一律过 `src/datetime.ts`」），
  不要写死 `toLocaleString('zh-CN')`、也不要裸打印接口给的时间串。
  中英数字分组符号一样，所以写死了也看不出来 —— 等加了德语（`1.234.567`）
  才会发现漏了哪几处；时间那边则是换个时区的人来看才会发现

### 边界：**业务数据不翻**

用户自己录的数据不进语言包：数据范围名 · 规则名 · 部门名 · 字典项 · 公告正文 ·
角色名与描述 · 人名。要多语言得加翻译表/翻译列，属于另一个量级。

而**从代码/配置里来的中文**是例外：菜单按钮标题、参数配置的 `name`/`remark`、
接口 `summary`（= 操作日志的「操作内容」列，108 条）、插件 `plugin.toml` 的
`summary`/`description`、登录日志的 `msg`。它们虽然也在库里，但稳定、来源在仓库里，
渲染处走一次 `t(变量)` 就能翻 —— **历史记录也一起翻了**，因为存的就是中文原文。
这是「原文即 key」最大的实用价值。它们必须同时进 `server-data-keys.json`。

判据很简单：**这段中文是谁写的？** 仓库里写的 → 翻；用户在界面上敲的 → 不翻。

⚠️ **判"是业务数据"之前必须把清单看完。** 扫描脚本按页输出，一页几十条时
很容易只看前十几条就下结论 —— `/system/role` 的 88 条里前 14 条恰好全是角色名，
于是"功能权限/数据范围/角色用户"三个 tab 被埋在后面 —— 是在界面上被发现的，不是扫描脚本报出来的。
现在扫描按「语言包里**已有**这条 key、界面上却还是中文」分桶：命中的一定是
渲染处漏了 `t()`，**不可能是业务数据**，必修。
（反过来会有假阳性：字典类型名「通知公告」恰好和菜单标题撞了 key —— 这是这个
判据的固有代价，看一眼上下文就能排除。）

最后一次全站扫描（英文模式，逐页抓中文片段）剩 256 种，全部落在下面这几类：
部门 63 · 角色 88 · 数据范围/规则 16 · 字典 33 · 公告 27 · 人名 —— 一条 UI 文案都没有。

菜单表格标题用**两级回落**：`t(menuKey(node.path), { defaultValue: t(node.title) })`
—— 一级用 path（稳定），按钮行没有 path 就回落到「标题本身即 key」。

### 布局提醒

**英文比中文长约 40%**。`SelectFilter` 的宽度用 `min-w-*` + `w-auto`，
写死 `w-28` 会把 `All statuses` 截成 `All statuse:`（切到英文界面才会暴露）。
