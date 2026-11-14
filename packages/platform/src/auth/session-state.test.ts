import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { tokenStore } from '../api-client/token-store'
import { useAiDrawerStore } from '../pages/ai-chat/drawer-store'
import { useUploadStore } from '../shell/upload-store'
import { createResumeStore, fingerprint } from '../upload/resume'
import { deferred, memoryStorage } from '../upload/test-utils'
import { login, logout } from './session'

const client = vi.hoisted(() => ({
  api: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn() },
  uploadFile: vi.fn(),
  uploadBlob: vi.fn(),
  endSession: vi.fn(),
  restoreSession: vi.fn(),
}))
vi.mock('../api-client/client', () => client)
vi.mock('../upload/hash', () => ({ sha256File: async () => 'file-hash' }))

const jwt = (id: string, session = 's1') => `e30.${btoa(JSON.stringify({ sub: id, session_uuid: session }))}.sig`
const a = '2048601263834267648'
const b = '2048601263834267649'
const file = (name: string) => new File(['private bytes'], name, { lastModified: 1 })

beforeEach(() => {
  tokenStore.clear()
  useUploadStore.getState().reset()
  useAiDrawerStore.getState().reset()
  vi.resetAllMocks()
  vi.stubGlobal('localStorage', memoryStorage())
  client.api.GET.mockImplementation(async (path: string) => {
    if (path.includes('/check?')) return null
    if (path.endsWith('/upload-policy')) return { chunk_threshold: Infinity, chunk_size: 10 }
    throw new Error(`unexpected request ${path}`)
  })
  client.api.POST.mockImplementation(async (path: string) =>
    path.endsWith('/login') ? { access_token: jwt(b) } : null,
  )
  tokenStore.set(jwt(a))
})

afterEach(() => {
  tokenStore.clear()
  vi.unstubAllGlobals()
})

describe('上传与 AI 状态的身份边界', () => {
  it.each(['logout', 'expired', 'login'] as const)(
    '%s 会取消旧上传、清除文件名和 AI 会话，迟到的完成不能挂载附件',
    async (kind) => {
      const pending = deferred<{ id: string }>()
      const onDone = vi.fn()
      client.uploadFile.mockReturnValueOnce(pending.promise)
      useUploadStore.getState().enqueue([file('A-private.zip'), file('A-queued.zip')], { onDone })
      useUploadStore.getState().setCollapsed(true)
      useAiDrawerStore.getState().setOpen(true)
      useAiDrawerStore.getState().setConversationId('A-conversation')
      await vi.waitFor(() => expect(client.uploadFile).toHaveBeenCalledOnce())
      const signal = client.uploadFile.mock.calls[0]![3].signal as AbortSignal
      expect(useUploadStore.getState().items.map((item) => item.name)).toEqual(['A-private.zip', 'A-queued.zip'])

      const qc = new QueryClient()
      if (kind === 'logout') await logout(qc)
      else if (kind === 'login') await login(qc, { username: 'B', password: 'secret' })
      else tokenStore.clear() // 401 的 clearToken、socket endSession 都从这里清 token

      expect(signal.aborted).toBe(true)
      expect(useUploadStore.getState()).toMatchObject({ items: [], resumable: [], open: false, collapsed: false })
      expect(useAiDrawerStore.getState()).toMatchObject({ open: false, conversationId: undefined })
      pending.resolve({ id: 'A-file' })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(onDone).not.toHaveBeenCalled()
      expect(client.uploadFile).toHaveBeenCalledOnce()

      tokenStore.set(jwt(b))
      client.uploadFile.mockResolvedValueOnce({ id: 'B-file' })
      useUploadStore.getState().enqueue([file('B.zip')])
      await vi.waitFor(() => expect(useUploadStore.getState().items[0]?.status).toBe('done'))
      expect(useUploadStore.getState().items.map((item) => item.name)).toEqual(['B.zip'])
      qc.clear()
    },
  )

  it('同账号刷新 access token 不取消上传，也不关 AI 抽屉', async () => {
    const pending = deferred<{ id: string }>()
    client.uploadFile.mockReturnValueOnce(pending.promise)
    useUploadStore.getState().enqueue([file('A.zip')])
    useAiDrawerStore.getState().setOpen(true)
    useAiDrawerStore.getState().setConversationId('A-conversation')
    await vi.waitFor(() => expect(client.uploadFile).toHaveBeenCalledOnce())
    const signal = client.uploadFile.mock.calls[0]![3].signal as AbortSignal
    tokenStore.set(jwt(a, 'refreshed'))
    expect(signal.aborted).toBe(false)
    expect(useAiDrawerStore.getState()).toMatchObject({ open: true, conversationId: 'A-conversation' })
    pending.resolve({ id: 'A-file' })
    await vi.waitFor(() => expect(useUploadStore.getState().items[0]?.status).toBe('done'))
  })

  it.each([true, false])('续传核对晚于换人返回（旧会话存在：%s），不能显示 A 的文件或删掉 A 的断点', async (exists) => {
    const old = deferred<unknown>()
    const oldFile = file('A-private.zip')
    const newFile = file('B-private.zip')
    const entry = (f: File, upload_id: string) => ({
      name: f.name,
      size: f.size,
      lastModified: 1,
      created_at: Date.now(),
      upload_id,
    })
    const aResume = createResumeStore(a)
    aResume.set(fingerprint(oldFile), entry(oldFile, 'session-a'))
    aResume.set('next-a-file', entry(oldFile, 'session-a-next'))
    createResumeStore(b).set(fingerprint(newFile), entry(newFile, 'session-b'))
    const session = { upload_id: 'session-b', size: newFile.size, chunk_size: 10, total_parts: 2, uploaded_parts: [1] }
    client.api.GET.mockImplementation((path: string) =>
      path.endsWith('/session-a') ? old.promise : Promise.resolve(session),
    )
    useUploadStore.getState().bind(vi.fn())
    expect(client.api.GET).toHaveBeenCalledWith(expect.stringContaining('session-a'), expect.anything())
    tokenStore.set(jwt(b))
    useUploadStore.getState().bind(vi.fn())
    await vi.waitFor(() => expect(useUploadStore.getState().resumable).toHaveLength(1))
    old.resolve(exists ? { ...session, upload_id: 'session-a' } : null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useUploadStore.getState().resumable.map((item) => item.entry.name)).toEqual(['B-private.zip'])
    expect(aResume.get(fingerprint(oldFile))?.upload_id).toBe('session-a')
    expect(client.api.GET).toHaveBeenCalledTimes(2)
  })

  it('换人时还在等待上传策略，旧文件不能在策略返回后使用新账号上传', async () => {
    const pending = deferred<{ chunk_threshold: number; chunk_size: number }>()
    client.api.GET.mockImplementation(async (path: string) =>
      path.endsWith('/upload-policy') ? pending.promise : null,
    )
    useUploadStore.getState().enqueue([file('A.zip')])
    await vi.waitFor(() =>
      expect(client.api.GET).toHaveBeenCalledWith(expect.stringContaining('upload-policy'), expect.anything()),
    )
    tokenStore.set(jwt(b))
    pending.resolve({ chunk_threshold: 1, chunk_size: 10 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.uploadFile).not.toHaveBeenCalled()
    expect(client.api.POST).not.toHaveBeenCalled()
    expect(useUploadStore.getState().items).toEqual([])
  })
})
