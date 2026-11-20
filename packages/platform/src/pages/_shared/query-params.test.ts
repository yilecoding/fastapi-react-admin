import { afterEach, describe, expect, it } from 'vitest'

import { getDisplayTimeZone, setDisplayTimeZone } from '@admin/i18n'
import type { FilterField, QueryValue } from '@admin/ui/components/query-bar'

import { toDisplayZoneQueryParams } from './query-params'

const fields: FilterField[] = [
  { key: 'time', label: '时间', type: 'dateTimeRange', rangeParams: ['start_time', 'end_time'] },
  { key: 'eventTime', label: '事件时间', type: 'dateTime', param: 'event_time' },
  { key: 'day', label: '日期', type: 'dateRange', rangeParams: ['start_day', 'end_day'] },
  { key: 'timedDay', label: '带时间的日期', type: 'dateRange', withTime: true, rangeParams: ['from_at', 'to_at'] },
]

const query = (time: [string, string], day: [string, string]): QueryValue => ({
  mode: 'basic',
  basic: [
    { id: 'time', field: 'time', op: 'between', value: time },
    { id: 'event', field: 'eventTime', op: 'eq', value: '2026-08-22 12:30:00' },
    { id: 'day', field: 'day', op: 'between', value: day },
    { id: 'timed-day', field: 'timedDay', op: 'between', value: ['2026-08-22 00:00:00', '2026-08-22 23:59:59'] },
  ],
  advanced: { id: 'root', logic: 'and', children: [] },
})

afterEach(() => setDisplayTimeZone(null))

describe('toQueryParams display timezone conversion', () => {
  it('serializes date-time ranges as instants in the user display timezone', () => {
    setDisplayTimeZone('UTC')

    expect(
      toDisplayZoneQueryParams(
        query(['2026-08-22 00:00:00', '2026-08-22 23:59:59'], ['2026-08-22', '2026-08-22']),
        fields
      )
    ).toEqual({
      start_time: '2026-08-22T00:00:00.000Z',
      end_time: '2026-08-22T23:59:59.000Z',
      event_time: '2026-08-22T12:30:00.000Z',
      start_day: '2026-08-22',
      end_day: '2026-08-22',
      from_at: '2026-08-22T00:00:00.000Z',
      to_at: '2026-08-22T23:59:59.000Z',
    })
  })

  it('uses the display zone offset on both ends of a range', () => {
    setDisplayTimeZone('America/Sao_Paulo')

    expect(
      toDisplayZoneQueryParams(
        query(['2026-07-15 00:00:00', '2026-07-15 23:59:59'], ['2026-07-15', '2026-07-15']),
        fields
      )
    ).toMatchObject({
      start_time: '2026-07-15T03:00:00.000Z',
      end_time: '2026-07-16T02:59:59.000Z',
    })
  })

  it('uses each side of a date range’s DST transition offset independently', () => {
    setDisplayTimeZone('America/New_York')

    expect(
      toDisplayZoneQueryParams(
        query(['2026-03-08 00:00:00', '2026-03-08 23:59:59'], ['2026-03-08', '2026-03-08']),
        fields
      )
    ).toMatchObject({
      start_time: '2026-03-08T05:00:00.000Z',
      end_time: '2026-03-09T03:59:59.000Z',
    })
  })

  it('interprets date-only endpoints as the start and end of the chosen display-zone day', () => {
    setDisplayTimeZone('America/Sao_Paulo')
    const dayQuery: QueryValue = {
      mode: 'basic',
      basic: [{ id: 'time', field: 'time', op: 'between', value: ['2026-07-15', '2026-07-15'] }],
      advanced: { id: 'root', logic: 'and', children: [] },
    }

    expect(toDisplayZoneQueryParams(dayQuery, [fields[0]!])).toEqual({
      start_time: '2026-07-15T03:00:00.000Z',
      end_time: '2026-07-16T02:59:59.000Z',
    })
  })

  it('converts a one-sided range limit without adding the missing end', () => {
    setDisplayTimeZone('America/Sao_Paulo')
    const value = query(['2026-07-15 00:00:00', ''], ['2026-07-15', '2026-07-15'])
    value.basic = value.basic.map((condition) =>
      condition.field === 'time' ? { ...condition, value: ['2026-07-15 00:00:00', undefined] } : condition
    )

    const params = toDisplayZoneQueryParams(value, fields)
    expect(params.start_time).toBe('2026-07-15T03:00:00.000Z')
    expect(params.end_time).toBeUndefined()
  })

  it('does not mutate display timezone or turn advanced trees into flat requests', () => {
    setDisplayTimeZone('America/Sao_Paulo')
    const originalZone = getDisplayTimeZone()
    const value: QueryValue = {
      mode: 'advanced',
      basic: [],
      advanced: {
        id: 'root',
        logic: 'and',
        children: [{ id: 'time', field: 'time', op: 'between', value: ['2026-07-15 00:00:00', '2026-07-15 23:59:59'] }],
      },
    }

    expect(toDisplayZoneQueryParams(value, fields)).toEqual({})
    expect(getDisplayTimeZone()).toBe(originalZone)
  })
})
