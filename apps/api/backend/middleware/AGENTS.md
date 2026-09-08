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
