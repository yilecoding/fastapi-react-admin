import * as React from 'react'
import { IconPlus } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import { ToggleGroup, ToggleGroupItem } from '@admin/ui/components/toggle-group'
import {
  QueryBar, countActive, emptyQuery, toFilterTree, toQueryParams, toUrlParams,
  type FilterField, type QueryValue,
} from '@admin/ui/components/query-bar'

import { STATUS_META, makeDemoRows } from '../../playground-table/data'
import { b, n, s, type KnobValues } from '../kit'

/**
 * 沙箱里的 QueryBar demo。
 *
 * 舞台下面挂了四块出参面板 —— 配查询区最容易翻车的就是「界面上勾了但没进请求」，
 * 把 `toQueryParams`（发后端）/ `toSearchParams`（进 URL）/ `packQuery`（整份存 URL）
 * / `toFilterTree`（高级模式）的结果摊在旁边，点一下就知道接没接上。
 *
 * 字段集刻意**每种类型都摆一个**：查询区的坑基本都在「某个类型没接」上
 * （时间区间、多选、标签、自定义控件），一眼看不全就发现不了。
 */
const ROWS = makeDemoRows(120)
const uniq = (k: 'team' | 'role' | 'city') => [...new Set(ROWS.map((r) => r[k]))]

/** 全部 12 种字段类型各一个 —— 这一份同时是「支持哪些情况」的清单 */
const ALL_FIELDS: FilterField[] = [
  {
    key: 'name', label: '姓名', type: 'text', group: '基本信息',
    placeholder: '模糊匹配', defaultVisible: true,
    // 文本字段开运算符选择：默认「包含」，也能切「等于 / 开头是」
    showOperator: true,
  },
  { key: 'account', label: '账号', type: 'text', group: '基本信息' },
  {
    key: 'staffNo', label: '工号', type: 'tags', group: '基本信息',
    hint: '可粘贴多个',
    placeholder: '回车或逗号分隔',
  },
  {
    key: 'team', label: '团队', type: 'select', group: '归属',
    options: uniq('team').map((v) => ({ value: v, label: v })),
  },
  {
    key: 'role', label: '角色', type: 'multiSelect', group: '归属',
    options: uniq('role').map((v) => ({ value: v, label: v })),
    hint: '多选',
  },
  {
    key: 'city', label: '城市', type: 'select', group: '归属',
    // 选项超过 8 项会自动换成可搜索的下拉
    options: uniq('city').map((v) => ({ value: v, label: v })),
  },
  {
    key: 'status', label: '状态', type: 'select', group: '状态',
    defaultVisible: true,
    // 选项 value 是 number —— 条件里存字符串，出参时按 options 查回 number
    options: Object.entries(STATUS_META).map(([v, m]) => ({ value: Number(v), label: m.label })),
  },
  { key: 'onDuty', label: '在职', type: 'boolean', group: '状态' },
  {
    key: 'score', label: '评分', type: 'number', group: '指标',
    defaultOperator: 'between', min: 0, max: 100,
    rangeParams: ['score_min', 'score_max'],
  },
  { key: 'amount', label: '额度', type: 'number', group: '指标', showOperator: true },
  { key: 'joinedAt', label: '入职日期', type: 'date', group: '时间' },
  {
    key: 'createdAt', label: '创建时间', type: 'dateTimeRange', group: '时间',
    defaultVisible: true,
    // 一个字段 → 两个入参，名字由接口定
    rangeParams: ['start_time', 'end_time'],
  },
  { key: 'checkIn', label: '打卡时间', type: 'time', group: '时间' },
  {
    key: 'level', label: '等级', type: 'custom', group: '指标',
    hint: '自定义控件',
    // 内置类型都不合适时的逃生口：控件自己画，值仍然由查询区持有
    // variant 用默认的不用 outline：套在 InputGroup 里会「框里再套一圈框」
    render: ({ value, onChange }) => (
      <ToggleGroup
        value={value ? [String(value)] : []}
        onValueChange={(v: string[]) => onChange(v[0])}
        size="sm" spacing={0}
      >
        {['P5', 'P6', 'P7'].map((lv) => (
          <ToggleGroupItem key={lv} value={lv} className="h-8 px-2">{lv}</ToggleGroupItem>
        ))}
      </ToggleGroup>
    ),
  },
]

export function QueryBarDemo({ v }: { v: KnobValues }) {
  const fieldCount = n(v, 'fields')
  const spread = s(v, 'visible')
  const mode = s(v, 'mode') as 'basic' | 'advanced'

  /**
   * 旋钮改了字段集合就换一套 —— 字段是声明式的，重建比增量改省心。
   *
   * 「默认铺开」不做成「前 N 个」：那样一调小就把**时间区间**（声明里第 12 个）
   * 挤出去了，界面上看起来像「没有时间筛选」—— 这个 demo 原来就是这么骗人的。
   * 现在三档都尊重声明顺序里的 defaultVisible。
   */
  const fields = React.useMemo(
    () =>
      ALL_FIELDS.slice(0, fieldCount).map((f) => ({
        ...f,
        defaultVisible:
          spread === '全部铺开' ? true : spread === '一个都不铺' ? false : f.defaultVisible,
      })),
    [fieldCount, spread]
  )

  const [value, setValue] = React.useState<QueryValue>(() => ({ ...emptyQuery(fields), mode }))
  const [submitted, setSubmitted] = React.useState<QueryValue>(() => ({ ...emptyQuery(fields), mode }))

  /**
   * 字段集合或初始模式变了要重来，否则旧条件引用的字段已经不在列表里。
   *
   * ⚠️ **只在真的变了的时候重来。** 两个坑叠在一起：
   *
   * - 子组件的 effect 先跑、父组件的后跑 —— `QueryBar` 里「套用默认视图」刚把
   *   条件填好，这里立刻用 `emptyQuery` 盖掉，表现是「视图名字显示对了、
   *   条件却是空的」（实测踩到）。
   * - 所以不能只用「首次挂载」标志：StrictMode 开发期把 effect 跑两遍，
   *   第二遍那个 ref 已经是 true 了，照样会盖掉。
   *
   * 比上一次的值就都躲开了 —— 值没变就什么都不做。
   */
  const prev = React.useRef({ fields, mode })
  React.useEffect(() => {
    if (prev.current.fields === fields && prev.current.mode === mode) return
    prev.current = { fields, mode }
    const fresh = { ...emptyQuery(fields), mode }
    setValue(fresh)
    setSubmitted(fresh)
  }, [fields, mode])

  return (
    <div className="flex w-full flex-col gap-3">
      <QueryBar
        fields={fields}
        value={value}
        onChange={setValue}
        onSearch={setSubmitted}
        applied={submitted}
        onReset={() => setSubmitted({ ...emptyQuery(fields), mode: value.mode })}
        advanced={b(v, 'advanced')}
        viewsStorageKey={b(v, 'views') ? 'qb:sandbox' : undefined}
        collapseAfter={n(v, 'collapse')}
        actions={
          b(v, 'actions') ? (
            <Button size="sm" className="h-8"><IconPlus className="size-4" />新增</Button>
          ) : undefined
        }
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Out
          title="发给后端的参数"
          hint="toQueryParams —— 平铺 key:value，区间按 rangeParams 拆成两个入参"
          body={JSON.stringify(toQueryParams(submitted, fields), null, 2)}
          testId="qbd-params"
        />
        <Out
          title="写进 URL 的参数"
          hint="toUrlParams —— 键是字段 key、值压到最短；f 记「摆开但没填值」的格子"
          body={urlPreview(toUrlParams(submitted, fields))}
          testId="qbd-search"
        />
        <Out
          title="地址栏长什么样"
          hint="和上面同一份，拼成 query string —— 这才是用户复制出去的东西"
          body={queryString(toUrlParams(submitted, fields))}
          testId="qbd-packed"
        />
        <Out
          title="条件树"
          hint={`toFilterTree —— 高级模式用，已剪掉空条件（当前 ${countActive(submitted, fields)} 条生效）`}
          body={JSON.stringify(toFilterTree(submitted, fields), null, 2)}
          testId="qbd-tree"
        />
      </div>
    </div>
  )
}

/** 只展示真正会写出去的键（undefined 的是「清掉这个参数」，不进地址栏） */
const urlPreview = (p: Record<string, string | undefined>) =>
  JSON.stringify(
    Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)),
    null,
    2
  )

const queryString = (p: Record<string, string | undefined>) => {
  const parts = Object.entries(p)
    .filter(([, v]) => v !== undefined)
    // 和 apps/web 的 stringifySearch 同口径：: , ~ / 不编码
    .map(([k, v]) => `${k}=${encodeURIComponent(v!).replace(/%3A/gi, ':').replace(/%2C/gi, ',').replace(/%7E/gi, '~')}`)
  return parts.length ? `?${parts.join('&')}` : '(空)'
}

function Out({ title, hint, body, testId }: { title: string; hint: string; body: string; testId: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium">{title}</span>
      <span className="text-[11px] text-muted-foreground">{hint}</span>
      <pre className="max-h-44 overflow-auto rounded-md bg-muted p-2 text-[11px]" data-testid={testId}>
        {body}
      </pre>
    </div>
  )
}
