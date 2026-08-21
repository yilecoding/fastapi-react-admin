import type { DeviceEvent, DeviceInfo } from "@admin/platform/desktop/contract"

/**
 * 设备适配器接口。**每接一种硬件就实现一个,不要往主进程里直接塞设备代码。**
 *
 * 这个模板的定位是「后面别的项目也能直接套」,所以硬件必须是插件而不是内建:
 * 有的项目要身份证读卡器,别的项目可能要扫码枪、电子秤、门禁控制器。
 * 共用的是外壳(窗口/更新/认证/打印),不共用的是设备。
 */
export interface DeviceAdapter {
  readonly id: string
  readonly label: string

  /** 启动。已经在跑就直接返回当前状态,不要重复开设备 */
  start(emit: (event: DeviceEvent) => void): Promise<void>
  stop(): Promise<void>
  info(): DeviceInfo

  /**
   * 桩/调试用:手动触发一个事件。
   * 真实适配器可以不实现(留 undefined),界面上那个「模拟刷卡」按钮自然就失效。
   */
  simulate?(payload?: Record<string, unknown>): void
}
