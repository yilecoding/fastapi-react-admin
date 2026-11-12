import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from './client'
import { ApiError } from './errors'

const jwt = (sub: string, session = 'one') => `e30.${btoa(JSON.stringify({ sub, session_uuid: session }))}.sig`
const response = (status: number, data: unknown = null) =>
  Response.json({ code: status, msg: status === 200 ? 'ok' : 'expired', data }, { status })
type TestPaths = {
  '/save': { put: { requestBody: { content: { 'application/json': Record<string, unknown> } }; responses: { 200: { content: { 'application/json': { saved: boolean } } } } } }
  '/read': { get: { responses: { 200: { content: { 'application/json': unknown } } } } }
}

afterEach(() => vi.unstubAllGlobals())

describe('refresh identity boundary (#324)', () => {
  function setup(nextUser: string) {
    let token: string | null = jwt('2048601263834267648')
    const sent: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
      sent.push(request.headers.get('Authorization') ?? '')
      return response(sent.length === 1 ? 401 : 200, { saved: true })
    }))
    const expired = vi.fn()
    const refresh = vi.fn(async () => ({ kind: 'ok' as const, token: jwt(nextUser, 'two') }))
    const client = createApiClient<TestPaths>({
      getBaseUrl: () => 'http://localhost', getLanguage: () => 'en-US',
      getToken: () => token, setToken: (value) => { token = value },
      clearToken: () => { token = null }, onSessionExpired: expired, refresh,
    })
    return { client, sent, expired, refresh, token: () => token, setToken: (value: string | null) => { token = value } }
  }

  it('never replays a write under a different account', async () => {
    const s = setup('2048601263834267649')
    await expect(s.client.PUT('/save', { body: { name: 'A data' } })).rejects.toBeInstanceOf(ApiError)
    expect(s.sent).toHaveLength(1)
    expect(s.token()).toBeNull()
    expect(s.expired).toHaveBeenCalledWith({ reason: 'replaced', message: null })
  })

  it('permits the same account to rotate sessions and replay once', async () => {
    const s = setup('2048601263834267648')
    await expect(s.client.PUT('/save', { body: {} })).resolves.toEqual({ saved: true })
    expect(s.sent).toHaveLength(2)
    expect(s.expired).not.toHaveBeenCalled()
  })

  it('retains the session on a transient refresh failure', async () => {
    const s = setup('2048601263834267648')
    const before = s.token()
    s.refresh.mockResolvedValueOnce({ kind: 'transient', error: new ApiError(503, 503, 'offline') } as never)
    await expect(s.client.GET('/read')).rejects.toMatchObject({ httpStatus: 503 })
    expect(s.token()).toBe(before)
    expect(s.sent).toHaveLength(1)
    expect(s.expired).not.toHaveBeenCalled()
  })

  it('does not install a stale refresh after local logout', async () => {
    const s = setup('2048601263834267648')
    s.refresh.mockImplementationOnce(async () => {
      s.setToken(null)
      return { kind: 'ok', token: jwt('2048601263834267648') }
    })
    await expect(s.client.PUT('/save', { body: {} })).rejects.toBeInstanceOf(ApiError)
    expect(s.token()).toBeNull()
    expect(s.sent).toHaveLength(1)
  })

  it('shares a refresh between concurrent 401 responses', async () => {
    const s = setup('2048601263834267648')
    const sends: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
      const auth = request.headers.get('Authorization') ?? ''
      sends.push(auth)
      return response(auth === `Bearer ${jwt('2048601263834267648')}` ? 401 : 200, {})
    }))
    // Recreate after changing fetch: openapi-fetch captures it at construction.
    const client = createApiClient<TestPaths>({
      getBaseUrl: () => 'http://localhost', getLanguage: () => 'en-US',
      getToken: s.token, setToken: s.setToken, clearToken: () => s.setToken(null),
      refresh: s.refresh, onSessionExpired: s.expired,
    })
    await Promise.all([client.GET('/read'), client.GET('/read')])
    expect(s.refresh).toHaveBeenCalledTimes(1)
    expect(sends).toHaveLength(4)
  })

  it('does not expire a newer explicit login while an old refresh completes', async () => {
    const s = setup('2048601263834267648')
    const newer = jwt('2048601263834267648', 'explicit-login')
    s.refresh.mockImplementationOnce(async () => {
      s.setToken(newer)
      return { kind: 'ok', token: jwt('2048601263834267648', 'stale-refresh') }
    })
    await expect(s.client.PUT('/save', { body: {} })).rejects.toBeInstanceOf(ApiError)
    expect(s.token()).toBe(newer)
    expect(s.expired).not.toHaveBeenCalled()
    expect(s.sent).toHaveLength(1)
  })
})
