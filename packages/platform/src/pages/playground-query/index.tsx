import * as React from 'react'
import { IconPlus } from '@tabler/icons-react'

import { Badge } from '@admin/ui/components/badge'
import { Button } from '@admin/ui/components/button'
import { Card, CardContent } from '@admin/ui/components/card'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@admin/ui/components/table'
import {
  QueryBar, countActive, emptyQuery, toFilterTree, toQueryParams,
  type FilterField, type QueryValue,
} from '@admin/ui/components/query-bar'

import { PageHeader } from '../../shell/page-header'
import { StatusPill } from '../_shared/status'
import { STATUS_META, makeDemoRows, type DemoRow } from '../playground-table/data'

/**
 * 顶部查询区实验台。
 *
 * 右边实时显示两样东西：**发给后端的参数**和**条件树**。
 * 配查询区最容易翻车的就是「界面上勾了但没进请求」，把出参摊开放在旁边，
 * 点一下就知道有没有接上。
 */
const ROWS = makeDemoRows(200)

const FIELDS: FilterField[] = [
  {
    key: 'name', label: '姓名', type: 'text', group: '基本信息',
    defaultVisible: true, placeholder: '模糊匹配', showOperator: true,
  },
  { key: 'account', label: '账号', type: 'text', group: '基本信息' },
  { key: 'email', label: '邮箱', type: 'text', group: '基本信息' },
  {
    key: 'team', label: '团队', type: 'select', group: '归属', defaultVisible: true,
    options: [...new Set(ROWS.map((r) => r.team))].map((v) => ({ value: v, label: v })),
  },
  {
    // 多选：一次查几个角色。出参是 csv（`role=开发者,测试`）
    key: 'role', label: '角色', type: 'multiSelect', group: '归属',
    options: [...new Set(ROWS.map((r) => r.role))].map((v) => ({ value: v, label: v })),
  },
  {
    key: 'status', label: '状态', type: 'select', group: '状态',
    options: Object.entries(STATUS_META).map(([v, m]) => ({ value: Number(v), label: m.label })),
  },
  {
    key: 'city', label: '城市', type: 'select', group: '归属',
    options: [...new Set(ROWS.map((r) => r.city))].map((v) => ({ value: v, label: v })),
  },
  {
    key: 'score', label: '评分', type: 'number', group: '指标',
    defaultOperator: 'between', min: 0, max: 100, rangeParams: ['score_min', 'score_max'],
  },
  { key: 'amount', label: '额度', type: 'number', group: '指标', showOperator: true },
  {
    // 时间区间：快捷区间（今天 / 近 7 天 / 本月…）+ 日历 + 时分秒，
    // 一个字段拆成两个入参
    key: 'createdAt', label: '创建时间', type: 'dateTimeRange', group: '时间',
    defaultVisible: true, rangeParams: ['start_time', 'end_time'],
  },
]

export function PlaygroundQueryPage() {
  const [value, setValue] = React.useState<QueryValue>(() => emptyQuery(FIELDS))
  // 「已提交的那一份」和「正在编辑的那一份」要分开：
  // 不分开的话边输边过滤，就退化成即时搜索，显式「搜索」按钮也就没意义了
  const [submitted, setSubmitted] = React.useState<QueryValue>(() => emptyQuery(FIELDS))

  const params = toQueryParams(submitted, FIELDS)

  /**
   * 前端假过滤，只为了让示例「点了搜索有反应」。
   *
   * 出参已经是**后端入参名**了（`score_min` / `start_time`），所以这里得按
   * 入参名反查回列名 —— 真页面不用干这活，它把 params 原样丢给接口。
   */
  const rows = React.useMemo(() => {
    if (submitted.mode === 'advanced') return ROWS.slice(0, 20)
    const scoreMin = params.score_min as number | undefined
    const scoreMax = params.score_max as number | undefined
    return ROWS.filter((r) => {
      const cell = (k: string) => (r as never as Record<string, unknown>)[k]
      if (scoreMin !== undefined && r.score < scoreMin) return false
      if (scoreMax !== undefined && r.score > scoreMax) return false
      for (const [k, v] of Object.entries(params)) {
        if (k.startsWith('score_') || k === 'start_time' || k === 'end_time') continue
        if (v === undefined || v === '') continue
        const c = cell(k)
        // 多选出参是 csv —— 命中任意一个就算
        if (typeof v === 'string' && v.includes(',')) {
          if (!v.split(',').includes(String(c))) return false
        } else if (typeof c === 'string' && typeof v === 'string') {
          if (!c.includes(v)) return false
        } else if (String(c) !== String(v)) return false
      }
      return true
    }).slice(0, 20)
  }, [params, submitted.mode])

  const total = submitted.mode === 'advanced' ? ROWS.length : undefined

  return (
    <div className="flex flex-1 flex-col content-scroll:min-h-0">
      <div className="@container/main flex flex-1 flex-col gap-2 content-scroll:min-h-0">
        <div className="flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6">
          <PageHeader
            title="查询区（QueryBar）"
            description="字段声明式配置、默认不铺满、按需添加条件、显式搜索。右侧实时显示出参与条件树。"
          />

          <QueryBar
            fields={FIELDS}
            value={value}
            onChange={setValue}
            onSearch={(v) => setSubmitted(v)}
            applied={submitted}
            onReset={() => setSubmitted(emptyQuery(FIELDS))}
            advanced
            viewsStorageKey="qb:playground"
            actions={
              <Button size="sm" className="h-8" data-testid="pgq-add">
                <IconPlus className="size-4" />新增
              </Button>
            }
          />

          <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
            <div className="min-w-0 flex-1 overflow-x-auto rounded-lg border" data-testid="pgq-table">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>姓名</TableHead>
                    <TableHead>团队</TableHead>
                    <TableHead>角色</TableHead>
                    <TableHead>城市</TableHead>
                    <TableHead>评分</TableHead>
                    <TableHead>状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="h-32 text-center text-sm text-muted-foreground">
                        没有匹配的数据
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((r: DemoRow) => (
                      <TableRow key={r.id} data-testid={`pgq-row-${r.id}`}>
                        <TableCell className="text-sm font-medium">{r.name}</TableCell>
                        <TableCell className="text-sm">{r.team}</TableCell>
                        <TableCell className="text-sm">{r.role}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{r.city}</TableCell>
                        <TableCell className="text-sm tabular-nums">{r.score}</TableCell>
                        <TableCell>
                          <StatusPill tone={STATUS_META[r.status]!.tone}>{STATUS_META[r.status]!.label}</StatusPill>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            <Card className="w-full shrink-0 xl:w-96">
              <CardContent className="flex flex-col gap-3 p-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">本次提交</span>
                  <Badge variant="outline" className="font-normal" data-testid="pgq-mode">
                    {submitted.mode === 'basic' ? '基础筛选' : '高级筛选'}
                  </Badge>
                  <span className="text-xs text-muted-foreground" data-testid="pgq-count">
                    {countActive(submitted, FIELDS)} 个条件 · {total ?? rows.length} 条结果
                  </span>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">
                    发给后端的参数（<code>toQueryParams</code>）
                  </span>
                  <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-[11px]"
                       data-testid="pgq-params">
                    {JSON.stringify(params, null, 2)}
                  </pre>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">
                    条件树（<code>toFilterTree</code>，高级模式用）
                  </span>
                  <pre className="max-h-56 overflow-auto rounded-md bg-muted p-2 text-[11px]"
                       data-testid="pgq-tree">
                    {JSON.stringify(toFilterTree(submitted, FIELDS), null, 2)}
                  </pre>
                </div>

                <p className="text-[11px] text-muted-foreground">
                  高级模式的条件树后端目前吃不下（各列表接口只收平铺入参），
                  这里只演示出参形状。真要用得先给后端加过滤语法。
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
