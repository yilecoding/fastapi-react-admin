import type { DeviceEvent, DeviceInfo } from "@admin/platform/desktop/contract"

import type { DeviceAdapter } from "./types"

/**
 * 设备注册表。主进程只跟它打交道,不认识任何具体设备。
 */

const adapters = new Map<string, DeviceAdapter>()
const listeners = new Set<(event: DeviceEvent) => void>()

export function registerDevice(adapter: DeviceAdapter): void {
  if (adapters.has(adapter.id)) {
    throw new Error(`设备 id 重复: ${adapter.id}`)
  }
  adapters.set(adapter.id, adapter)
}

function emit(event: DeviceEvent): void {
  for (const fn of listeners) fn(event)
}

/** 主进程用它把设备事件转发给渲染层 */
export function onDeviceEvent(fn: (event: DeviceEvent) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function must(id: string): DeviceAdapter {
  const adapter = adapters.get(id)
  if (!adapter) throw new Error(`未注册的设备: ${id}`)
  return adapter
}

export function listDevices(): DeviceInfo[] {
  return [...adapters.values()].map((a) => a.info())
}

export async function startDevice(id: string): Promise<DeviceInfo> {
  const adapter = must(id)
  await adapter.start(emit)
  return adapter.info()
}

export async function stopDevice(id: string): Promise<DeviceInfo> {
  const adapter = must(id)
  await adapter.stop()
  return adapter.info()
}

export function simulateDevice(id: string, payload?: Record<string, unknown>): void {
  const adapter = must(id)
  if (!adapter.simulate) throw new Error(`设备 ${id} 不支持模拟事件`)
  adapter.simulate(payload)
}

export async function stopAllDevices(): Promise<void> {
  // 退出时必须逐个 stop:厂商 SDK 大多要求成对的 open/close,
  // 漏掉 close 会把设备句柄留在被占用状态,下次启动直接「设备打不开」。
  await Promise.allSettled([...adapters.values()].map((a) => a.stop()))
}
