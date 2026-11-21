# plugin/ai/llm —— 调模型网关的客户端，和失败时给人看的那句话

> 这份文件是 [AI 插件分册](../AGENTS.md) 的**子分册**（内网网关的 `verify_ssl` / `trust_env` 两条约束在那一份）。
> 跨模块纪律在根分册；新增结论写进离代码最近的分册。

## 🔴 报错里不带上游响应体和网关地址（#317）

**症状**：`base_url` 只校验协议头，能指向任意内网地址。「测试连接」把非 200 的响应体前 200 字回给调用者 =
半盲 SSRF（能探内网服务、读到它的报错内容）；对话里「连不上模型网关（{base_url}）」经错误帧发给每一个有
`ai:chat:use` 的**普通用户**。
**根因**：不止 issue 里点名的 `client.py` 一处 —— 两个引擎都把 `str(e)` 当错误帧（pydantic-ai 的 `ModelHTTPError`
的 `str` 里就带着响应体），`chat_service` 拼 `对话出错：{e}`，审批的 AI 填单 / 设计器兜底也是 `str(e)`。
**修法**：`client.py: user_facing_error(e)` 一处翻译 —— 自己抛的 `ServerError` 原样（`_explain_http_error` 只按状态码说人话、
400 给出常见原因）· 带 `status_code` 的按状态码 · 超时 / 连接错误各一句 · 认不出的只说异常类型。
🔴 **顺着异常链（`__cause__` / `__context__`）按类型认**，不看最外层的类名：pydantic-ai 把 openai 的 `APIConnectionError` /
`APITimeoutError` 包成 `ModelAPIError` 再 `raise … from e`，只看最外层的话同一次断网 pydantic_ai 引擎说「ModelAPIError」、native 说「连不上」
（评审抓的；第一版按类名子串猜，两个都没猜中）。全文和地址只进服务端日志。
上面五处都改走它（审批插件经 `ai_assist.explain_failure`，lazy import：AI 插件是可选的）。

⚠️ **没做目标地址校验**（issue 的第二条建议）：自建模型网关在内网是合理部署，一刀切挡私网会把它们全挡掉；要做得是可配置的白名单，
单独做。现在剩下的是**盲**探测：状态码那句话（401 / 404 / 400 / 其他）和耗时仍然能区分「端口开着、是个 HTTP 服务」，
前提是有 `ai:provider:add/edit`。

**实测证据**（2026-11-16，PostgreSQL 私有测试库）：`tests/test_ai_provider_errors.py` 6 条 —— 本机起一个真 socket「内网服务」，
回 400 / 500 / 502 + 带秘密的响应体，经真实「测试连接」接口：状态码在、秘密和 `127.0.0.1` 都不在；端口空着时只回固定那句；
`ModelHTTPError` 的 `str` 本来带着响应体（断言了前置）、翻译后不带。`test_ai_pydantic_engine.py` 那条「模型报错是可见的一帧」改成断言
不出原文。AI 插件 + 审批的 AI 填单 / 设计器共 180 条全过。变异：状态码分支拼上响应体 → 4 条红；连不上那句拼上地址 → 1 条红；
只看最外层不顺着异常链 → `ModelAPIError` 那条红。
⚠️ 「测试接口改回 `str(e)`」**没打红，是等价变异**：`stream_chat` 抛的都是已经清洗过的 `ServerError`，`str` 就是那句话 ——
这一层的防线在 `client.py`，不在测试接口。

## 🔴 模型密钥解不开：给一句说得清的报错，不是断流（#395）

**症状**：`AI_ENCRYPT_SECRET_KEY` 换过 / 多副本不一致 / 长度不对时，对话发出去只看到前端兜底的「连接中途断开」，
用户那句话也没了；「测试连接」是一个无说明的 500。原因只在服务端日志里（硬纪律 9）。
**根因**：`AESCipher.decrypt()` 抛裸 `ValueError`（padding 错）或 `UnicodeDecodeError`，`chat_service.stream()` 只接
`BaseExceptionError` —— 200 头已经发出，生成器抛异常；长度不对的密钥 `AESCipher(key)` 照样建得出来，到加解密那一刻才抛。
**修法**：`provider_service._cipher` 校验 16 / 24 / 32 字节，`_decrypt_api_key` 把解密异常翻成说明原因的 `ServerError`
（同 `config/secret.py`）；`chat_service._prepare` 把准备阶段的任何失败变成一帧 `error`，**并和用户那句话一起落库** ——
只发帧的话，流一结束前端重拉历史就把它冲掉（读 `use-chat-session.ts` 推断的，`no_provider` 原来也是这样；**没在浏览器里看过**）。「测试连接」解不开时回 `ok: false` + 那句原因。
**实测证据**（2026-11-21）：`tests/test_ai_key_and_lock.py`，修前：换密钥 / 长度不对两种 `build_client` 抛裸 `ValueError`
（`Invalid padding bytes` · `Invalid key size (40) for AES`）、对话流抛异常而不是 `error` 帧、「测试连接」在 TestClient 里冒出
`ValueError`；修后全绿，AI 插件 179 条全过。非十六进制的密钥修前就是业务错误（那条参数修前也绿）。
