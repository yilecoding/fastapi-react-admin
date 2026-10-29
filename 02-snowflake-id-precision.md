# 雪花 ID 丢精度不只在 JSON.parse：我在一个中后台里找到了 5 个出口

先说事故现场：在角色管理的权限矩阵里，给角色 A 勾了几个权限，点保存，提示成功。

**权限被存到了列表第一个角色身上。** 界面上没有任何报错。

原因是一个 19 位的 ID 在路上被改了一位。这篇把这一类问题在项目里出现过的地方挨个列出来。大家都知道「后端要把 ID 转成字符串」，但那只堵住了第一个出口。

---

## 为什么会丢

雪花 ID 大约是 2^61 量级，而 JS 的 `Number` 是双精度浮点，能精确表示的最大整数是 `Number.MAX_SAFE_INTEGER`，也就是 2^53 − 1：

```js
JSON.parse('2049629108245233664')   // 2049629108245233700
JSON.parse('2049629108245233665')   // 2049629108245233700
```

不光是末尾变成了 00，**相邻的 ID 会塌缩成同一个数**。项目里实测，连续 6 个菜单 ID 解析成了同一个值。拿这个值回传去更新、删除，命中的就是另一条记录。

---

## 出口 1：接口响应 —— 只转 `id` 字段是不够的

后端是 FastAPI。最初的做法和很多项目一样，在 Pydantic 基类上给 `id` 挂一个序列化器：

```python
@field_serializer('id')
def serialize_id(self, v: int) -> str: ...
```

问题是它**只认字段名 `id`**。这些都漏了：

- 外键：`dept_id`、`parent_id`、`role_id`……
- 不走 Pydantic 模型、直接返回 dict 的接口

所以最后在**编码层**统一处理：响应在序列化成 JSON 之前递归走一遍，超出安全范围的整数转成字符串：

```python
JS_MAX_SAFE_INT = 2**53 - 1

def stringify_unsafe_ints(obj):
    if isinstance(obj, bool):          # bool 是 int 的子类，必须先排除
        return obj
    if isinstance(obj, int):
        return str(obj) if abs(obj) > JS_MAX_SAFE_INT else obj
    if isinstance(obj, dict):
        return {k: stringify_unsafe_ints(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [stringify_unsafe_ints(v) for v in obj]
    return obj

class MsgSpecJSONResponse(JSONResponse):
    def render(self, content):
        return json.encode(stringify_unsafe_ints(content))
```

两个细节：

- **只转超范围的**。分页的 `total`、状态码 `status` 这些小整数还是数字，前端不用到处 `Number()` 回来。
- **`bool` 要先判断**。Python 里 `isinstance(True, int)` 是 `True`。

## 出口 2：URL 参数 —— 路由库替你 `JSON.parse` 了

开头那个事故就出在这里。

页面的选中项写在 URL 里：`/system/role?role=2202097973238829056`。后端已经下发字符串了，前端代码里也没有任何 `Number()`。

但 **TanStack Router 默认会对每个 search 参数的值跑一次 `JSON.parse`**：

```js
JSON.parse('2202097973238829056')   // 2202097973238829000
```

页面拿到的是一个不存在的 ID。详情面板回落到列表第一项，保存时提交的也是那一项。业务代码再小心也挡不住，因为它发生在路由层。

修法是给 router 换一个解析函数：纯整数且超出安全范围的，保持字符串，不交给 `JSON.parse`：

```ts
import { parseSearchWith } from '@tanstack/react-router'

const UNSAFE_INT = /^-?\d+$/

function parseValue(raw: string): unknown {
  if (UNSAFE_INT.test(raw) && !Number.isSafeInteger(Number(raw))) return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export const parseSearch = parseSearchWith(parseValue)

// router.ts
createRouter({ routeTree, parseSearch, stringifySearch })
```

序列化方向顺手也改了：默认的 `JSON.stringify` 会给字符串加引号，地址栏里会出现 `?role="2202…"`。现在的规则是，字符串能被 `parseValue` 原样读回来就不加引号，读不回来（比如 `"123"`、`"true"`）才加。两个方向用同一个判据，写出去的一定读得回来。

这个修复有一条 E2E 守着。写完之后我故意把那一行判断注释掉，测试立刻报：

```
Expected: "PM-…-B"
Received: "普通员工"
```

「普通员工」是种子数据里的第一个角色，和当初的事故现象完全一样。**守卫型测试一定要故意打断一次，确认它真的会红。**

## 出口 3：业务代码里的 `Number()` —— 比较两个 ID

审批流的表单支持条件，比如「申请部门 = 研发部」时显示某个字段。前端要即时算出显示哪些字段，原来的比较是这样写的：

```ts
Number(left) === Number(right)   // ❌
```

部门 ID 是雪花 ID，两个相邻的部门转成 double 之后会**相等**。而后端用的是 Python 的任意精度整数，分得清它们。

于是同一个条件，前端和后端算出了相反的结论：后端认为某个必填字段应该显示，前端把它藏起来了。用户怎么提交都被挡住，却看不到要填的是哪一项。

修法是按十进制字符串精确比较，不经过浮点数：

```ts
// 简化版：去掉前导零，先比长度，再按字典序比
function cmpDec(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}
```

项目里的完整实现还处理了负数和小数，和后端 `Decimal` 的比较口径一致。

## 出口 4：类型系统 —— 它不会拦你写 `Number(id)`

前端的接口类型是从 OpenAPI 生成的。一个常见的错觉是：「有类型就不会传错」。

实测 `openapi-fetch` 对**查询参数名**检查很严，拼错一个字母就报 `TS2561`。但对**路径参数的值完全不检查**：

```ts
api.GET('/api/v1/sys/users/{pk}', { params: { path: { pk: idStr } } })        // ✅ 0 错误
api.GET('/api/v1/sys/users/{pk}', { params: { path: { pk: Number(idStr) } } }) // ✅ 也是 0 错误
api.GET('/api/v1/sys/users', { params: { query: { usernamee: 'x' } } })      // ❌ TS2561
```

后端把 `pk` 声明成 `int`，生成的类型是 `number`，写 `Number(id)` 反而「更符合类型」。编译通过，运行时打开的是另一条记录。

请求体这一侧，后端加了一层只影响 JSON Schema 声明的标注，让生成出来的类型是 `string | number`：

```python
SnowflakeIdIn = Annotated[
    int,
    WithJsonSchema({'anyOf': [{'type': 'string'}, {'type': 'integer'}]}, mode='validation'),
]
```

Python 那边仍然是 `int`。Pydantic 在默认的宽松模式下会把 `"2202…"` 无损转成 Python 的任意精度整数，所以**前端发字符串、后端声明 `int`** 是对的组合。

## 出口 5：导出 Excel —— 后端也会丢

前面四个都在前端。这一个在后端。

导出 xlsx 用的是 openpyxl。整数写进单元格时，会被当成**数字**存。Excel 的数字也是双精度浮点，打开文件看到的是：

```
2.0496291082452337e+18
```

和 JS 一样的问题，只是换了个软件。修法是 ID 列一律按文本写：

```python
def id_cell(value) -> Cell:
    """雪花 ID：一律文本"""
    if value is None or value == '':
        return EMPTY
    return Cell(CellKind.TEXT, str(int(value)))
```

---

## 总结

| 出口 | 怎么丢的 | 怎么堵 |
|---|---|---|
| 接口响应 | 只转了 `id`，外键和裸 dict 漏了 | 在编码层递归转换 |
| URL 参数 | 路由库对 search 值跑 `JSON.parse` | 自定义 `parseSearch`，超范围的整数保持字符串 |
| 业务比较 | `Number(a) === Number(b)` | 按十进制字符串比较 |
| 类型系统 | 路径参数不做类型检查，`Number(id)` 能编译通过 | 靠规范和代码审查；请求体声明成 `string \| number` |
| 导出 Excel | 整数存成双精度 | ID 列写文本 |

项目里的规矩只有一句：**所有 ID 都是 string，永远不要 `Number()` 它。**

但这句话只管得住自己写的代码。路由库、序列化器、Excel，这些「别人替你解析」的地方才是真正的出口，得一个个去找。

文中代码来自我的开源项目 [fastapi-react-admin](https://github.com/yilecoding/fastapi-react-admin)，一个 FastAPI + React 19 的中后台底座。相关实现在：

- `apps/api/backend/utils/serializers.py`
- `apps/web/src/lib/search-params.ts`
- `apps/api/backend/common/dataio/cells.py`

你们的项目是怎么处理雪花 ID 的？还遇到过别的出口吗？欢迎评论区补充。
