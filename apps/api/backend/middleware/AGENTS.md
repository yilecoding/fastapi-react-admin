# backend/middleware —— 中间件

> 这份文件是 [`apps/api/AGENTS.md`](../../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的文件时才加载。
> 跨模块的硬纪律仍然只在根 `CLAUDE.md` 里有一份。

## 🔴 操作日志的响应体此前完全不脱敏

`desensitization()` 只作用于**请求**的 query/path/json/form，而且**只看顶层 key**
（嵌一层的 `password` 一个字符都不打码）；响应体只被截断，原样落进
`sys_opera_log.response_body`。两个洞都是静默的 —— 日志照常写、字段照常在。

现在 `desensitization()` 递归遍历 dict/list，且 `redact_body()` 对 JSON 响应先脱敏
再截断。三条要记住的：

- **顺序是「先脱敏后截断」**。反了等于没脱敏：截断后的片段不是合法 JSON，解析不了
- **解析失败一律不记原文，记一句占位**（fail-closed）。结构读不出来就没法确认里面
  没有敏感字段，宁可少一条日志，也不要记一条**看起来正常、实际没打码**的
- `text/plain` 不在此列 —— 纯文本没有可按字段打码的结构，保持原样截断

⚠️ **给 `check_production_settings` 加检查时要同步 `test_prod_config.py` 的
`_FakeSettings`**（它是最小配置对象，不是真的 `Settings`）。漏了会 `AttributeError`
把那个文件里所有用例一起打红 —— 吵闹但不静默，照着补上那一行即可。

## 🔴 重建响应时头要原样搬，不能 `dict(response.headers)`

`capture_response_body` 读完 JSON 响应体之后要重建一个 Response（`body_iterator` 只能消费一次）。
原来写的是 `headers=dict(response.headers)` —— `dict` 把**同名的头压成一个**（只留第一个），
一个响应里的第二行 `Set-Cookie` 就静默没了，接口返回 200、界面一切正常。

撞上它的是 #138：登录 / 刷新的响应里有两行 refresh cookie（真正下发的那个 + 清掉旧 `Path=/` 的那个），
第二行被吞，浏览器里的旧 cookie 留着，刷新时它盖过新的那个 —— 用户每 30 分钟被登出一次
（为什么旧的会赢见 [`common/security` 分册](../common/security/AGENTS.md)「refresh cookie 换了 Path」）。

现在搬 `raw_headers`（去掉旧的 `content-length`、按重建后的 body 重算）。

**实测证据**：`test_session.py::test_refresh_cookie_attributes` 第一次跑红在 `assert 1 == 2`，
真实响应头里只有一行 `set-cookie`；同一个最小 FastAPI 应用（不过这个中间件）返回的是两行。
变异检验：把 `raw_headers` 改回从 `dict(response.headers)` 构造，这条当场红。


## 🔴 客户端半路走了：`ClientDisconnect` 按 499 收掉，不是 500

浏览器跳页 / 关标签页会取消在途的 POST。请求体还没传完时读它，Starlette 抛 `ClientDisconnect`；原来没人接，
每次都记一条 ERROR + 几百行的栈、按 500 处理 —— 而客户端早就不在了，什么都收不到。日志里一片「请求异常」，
真正的错误被淹在里面。现在 `dispatch` 读请求参数和调路由时都接这个异常，回 499（nginx 的 client closed request），
记一行 INFO，不写操作日志（请求根本没执行）。

**实测证据**：本地真跑（2026-10-24）时 api 日志里撞到一次 `Exception in ASGI application … ClientDisconnect()`，
时间点紧挨着 Playwright 登录之后的跳页（是哪个请求日志里看不出来 —— 那条错误只带了 request id，没有路径，这是推断）；
`tests/test_opera_log_redaction.py::test_a_client_that_left_before_the_body_arrived_is_not_a_server_error`
构造一个 `receive()` 直接返回 `http.disconnect` 的请求，修之前当场抛 `ClientDisconnect`。

🔴 **第二个接法（路由跑到一半客户端走了）第一版写错了**：那个 `return` 在 `try` 里，`finally` 照样跑，按默认值
（`code=200` / `Success`）往操作日志里记了一条 —— 一个没执行完的请求在审计里成了「成功」。第一版测试只断言了 499，
没断言「没写日志」，所以是代码审查翻出来的。现在 except 里先把 `code` 改成 499、关掉 `should_log_opera` 再返回：
访问日志那一行照常记（显示 499），操作日志不写。
`test_a_client_that_left_while_the_route_ran_is_not_logged_as_a_success` 在旧代码上红：队列里是一条 `code='200' msg='Success'`。
