// 开放接口签名（FRA1-HMAC-SHA256）—— Node.js 参考实现（>= 18，只用内置模块），可以整个文件拷走。
//
//   import { signHeaders } from './fra-open-sign.mjs'
//   const url = 'https://admin.example.com/api/open/v1/users?limit=500'
//   const headers = signHeaders('GET', url, '', { accessKey: 'fra_ak_…', secretKey: 'fra_sk_…' })
//   const res = await fetch(url, { headers })
//
// 🔴 请求体要签**实际发出去的那串字节**：先 JSON.stringify 得到字符串、签它、再原样当 body 发。
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

// RFC 3986：encodeURIComponent 不编码 ! ' ( ) *，这里补上
const encode = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

// 解析查询串时 `+` 当空格（和服务端一致），再按 RFC 3986 重新编码
const decode = (s) => decodeURIComponent(s.replace(/\+/g, ' '))

export function canonicalQuery(query) {
  if (!query) return ''
  const pairs = query
    .split('&')
    .filter(Boolean)
    .map((kv) => {
      const i = kv.indexOf('=')
      const k = i === -1 ? kv : kv.slice(0, i)
      const v = i === -1 ? '' : kv.slice(i + 1)
      return [encode(decode(k)), encode(decode(v))]
    })
  // 按编码后的字节序比较（不是 localeCompare）：两边都是 ASCII，直接比
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  return pairs.map(([k, v]) => `${k}=${v}`).join('&')
}

export function stringToSign(method, url, body, timestamp, nonce) {
  const u = new URL(url)
  return [
    method.toUpperCase(),
    u.pathname || '/',
    canonicalQuery(u.search.replace(/^\?/, '')),
    timestamp,
    nonce,
    createHash('sha256').update(body ?? '').digest('hex'),
  ].join('\n')
}

export function signHeaders(method, url, body, { accessKey, secretKey, timestamp, nonce } = {}) {
  const ts = timestamp ?? String(Date.now())
  const n = nonce ?? randomUUID().replace(/-/g, '')
  const sign = createHmac('sha256', secretKey).update(stringToSign(method, url, body, ts, n)).digest('hex')
  return { 'X-Access-Key': accessKey, 'X-Timestamp': ts, 'X-Nonce': n, 'X-Sign': sign }
}

// ── 接收 Webhook 事件（Standard Webhooks）────────────────────────────────────
//
// 🔴 body 要传**收到的原始字节**（Express 里用 express.raw({ type: 'application/json' })），
// 不要先 JSON.parse 再 JSON.stringify 回去 —— 字节一变签名就对不上。
// 密钥轮换的那 24 小时里一条消息带两个签名（空格分隔），任一个对上即可。对方会重试，请按 webhook-id 去重。
export function verifyWebhook(headers, body, secret, { tolerance = 300, now = Date.now() / 1000 } = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]))
  const id = h['webhook-id']
  const ts = Number(h['webhook-timestamp'])
  const sigs = h['webhook-signature']
  if (!id || !Number.isInteger(ts) || !sigs) return false
  if (Math.abs(now - ts) > tolerance) return false
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const expected = createHmac('sha256', key)
    .update(Buffer.concat([Buffer.from(`${id}.${ts}.`), Buffer.from(body)]))
    .digest()
  return sigs.split(' ').some((part) => {
    const [version, value] = part.split(',', 2)
    if (version !== 'v1' || !value) return false
    const got = Buffer.from(value, 'base64')
    return got.length === expected.length && timingSafeEqual(got, expected)
  })
}

