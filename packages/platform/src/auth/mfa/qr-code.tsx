import * as React from 'react'
import { encode } from 'uqr'

import { cn } from '@admin/ui/lib/utils'

/**
 * 把 `otpauth://` 链接画成二维码给认证器扫（#181）。自己按模块画 `<rect>`，不往 DOM 里塞 SVG 字符串。
 *
 * ⚠️ **永远白底黑块**，不跟深色主题反色：不少认证器（含系统相机）认不出反色二维码，扫半天没反应、也不报错。
 * 外圈留 2 个模块的白边（静区），贴着卡片边框的二维码同样容易扫不出来。
 */
export function QrCode({ value, size = 176, className }: { value: string; size?: number; className?: string }) {
  const qr = React.useMemo(() => encode(value, { ecc: 'M', border: 2 }), [value])
  const cells: React.ReactNode[] = []
  qr.data.forEach((row, y) =>
    row.forEach((on, x) => {
      if (on) cells.push(<rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} />)
    })
  )
  return (
    <svg
      role="img"
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={cn('rounded-md bg-white', className)}
      data-testid="mfa-qr"
    >
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <g fill="#000">{cells}</g>
    </svg>
  )
}
