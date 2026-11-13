import { describe, expect, it } from 'vitest'

import { createResumeStore, type ResumeEntry } from './resume'
import { memoryStorage } from './test-utils'

describe('用户各自的续传记录', () => {
  it('同名同尺寸文件分属两个账号，B 的清理不删除 A 的记录，A 下次登录仍可恢复', () => {
    const storage = memoryStorage()
    const a = createResumeStore('2048601263834267648', storage)
    const b = createResumeStore('2048601263834267649', storage)
    const entry: ResumeEntry = {
      upload_id: 'session-a',
      name: 'private.zip',
      size: 100,
      lastModified: 1,
      created_at: Date.now(),
    }
    a.set('same-file', entry)
    expect(b.list()).toEqual([])
    b.set('same-file', { ...entry, upload_id: 'session-b' })
    b.remove('same-file')
    expect(createResumeStore('2048601263834267648', storage).get('same-file')).toEqual(entry)
  })

  it('旧的无归属记录不会被当前用户认领或送到后端核对', () => {
    const storage = memoryStorage()
    storage.setItem(
      'admin:uploads:resume',
      JSON.stringify({ fp: { upload_id: 'unknown-owner', created_at: Date.now() } }),
    )
    expect(createResumeStore('user-b', storage).list()).toEqual([])
  })
})
