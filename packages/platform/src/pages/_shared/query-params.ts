import { getDisplayTimeZone } from '@admin/i18n'
import { rangeParamNames, toQueryParams, type FilterField, type QueryValue } from '@admin/ui/components/query-bar'

import { wallTimeToIso } from './wall-time'

const WALL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
const WALL_DATE = /^\d{4}-\d{2}-\d{2}$/

/** QueryBar values are display-zone wall times; APIs receive ISO instants. */
export function toDisplayZoneQueryParams(
  value: QueryValue,
  fields: readonly FilterField[]
): Record<string, unknown> {
  const params = toQueryParams(value, fields)
  const timeZone = getDisplayTimeZone()

  for (const field of fields) {
    const hasTime = field.type === 'dateTime' || field.type === 'dateTimeRange' || Boolean(field.withTime)
    if (!hasTime) continue

    const names =
      field.type === 'dateTimeRange' || field.type === 'dateRange'
        ? rangeParamNames(field)
        : [field.param ?? field.key]

    for (const name of names) {
      const wall = params[name]
      if (typeof wall !== 'string') continue
      const normalized = WALL_DATE.test(wall) ? `${wall} ${name === names[0] ? '00:00:00' : '23:59:59'}` : wall
      if (!WALL_TIME.test(normalized)) continue
      const instant = wallTimeToIso(normalized, timeZone)
      if (instant) params[name] = instant
    }
  }

  return params
}
