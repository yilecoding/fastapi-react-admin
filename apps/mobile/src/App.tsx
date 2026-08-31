import { useCallback, useRef, useState } from 'react'
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { WebView, type WebViewNavigation } from 'react-native-webview'
import type WebViewType from 'react-native-webview'

import { IS_DEFAULT_URL, WEB_URL } from './config'

/**
 * issue #39 的 B 路线 step 0：原生壳 + WebView 承载现有 web。
 *
 * 这一版**刻意只做壳**，不做鉴权托管、不做服务器地址设置屏、不做原生能力桥 ——
 * 那些是 step 1/2/4。step 0 唯一的目的是把「这条路到底通不通」和
 * 「触屏上那些落差实际有多难受」变成可观察的事实。
 *
 * 🔴 **加载失败必须是可见状态，不是白屏**（根 CLAUDE.md 硬纪律 9）。
 * WebView 的默认失败表现就是一片空白 —— 而 spike 阶段最需要区分的恰恰是
 * 「站点挂了」/「证书不对」/「网络不通」/「页面在转圈」这几种，都长成白屏的话
 * 这半天基本白花。所以这里把 `onError` / `onHttpError` 摊成一个带原因和重试的面板。
 */
export default function App() {
  const webRef = useRef<WebViewType>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [current, setCurrent] = useState(WEB_URL)

  const reload = useCallback(() => {
    setFailure(null)
    setLoading(true)
    webRef.current?.reload()
  }, [])

  const onNavStateChange = useCallback((nav: WebViewNavigation) => {
    setCurrent(nav.url)
  }, [])

  return (
    <View style={styles.root}>
      <StatusBar style="auto" />

      {failure === null ? (
        <WebView
          ref={webRef}
          source={{ uri: WEB_URL }}
          style={styles.web}
          // iOS 上不开这条，WebView 用的是自己那份隔离的 cookie 存储 ——
          // 而 refresh token 就在 httpOnly cookie 里（`fba_refresh_token`，7 天）。
          // 漏了它的表现是「登录能过、过一天回来又要重新登录」，隔一天才复现。
          sharedCookiesEnabled
          // Android 侧的第三方 cookie。同源部署下用不上，但远端加载一旦
          // 前后端分域就会需要，先开着比事后查一天便宜
          thirdPartyCookiesEnabled
          domStorageEnabled
          javaScriptEnabled
          // 让页面里的 `100svh` / safe-area 拿到正确的视口
          contentInsetAdjustmentBehavior="automatic"
          onNavigationStateChange={onNavStateChange}
          onLoadStart={() => setLoading(true)}
          onLoadEnd={() => setLoading(false)}
          onError={({ nativeEvent }) =>
            setFailure(`${nativeEvent.description ?? '未知错误'}（code ${nativeEvent.code}）`)
          }
          onHttpError={({ nativeEvent }) =>
            setFailure(`服务端返回 HTTP ${nativeEvent.statusCode}`)
          }
        />
      ) : (
        <View style={styles.failure}>
          <Text style={styles.failureTitle}>打不开这个站点</Text>
          <Text style={styles.failureUrl}>{WEB_URL}</Text>
          <Text style={styles.failureReason}>{failure}</Text>
          <Text style={styles.failureHint}>
            {Platform.OS === 'ios'
              ? '常见原因：证书不匹配（用 IP 而不是域名）· ATS 拦了明文 HTTP · 站点没起'
              : '常见原因：cleartext 被拦（明文 HTTP）· 证书不匹配 · 站点没起'}
          </Text>
          <Pressable style={styles.retry} onPress={reload}>
            <Text style={styles.retryText}>重试</Text>
          </Pressable>
        </View>
      )}

      {loading && failure === null && (
        <View style={styles.loading} pointerEvents="none">
          <ActivityIndicator size="large" />
        </View>
      )}

      {/* spike 专用的状态条：当前 URL + 是不是默认站点。
          正式版本里这一条要去掉（step 2 会有真正的服务器地址设置屏）。 */}
      <View style={styles.debugBar}>
        <Text style={styles.debugText} numberOfLines={1}>
          {IS_DEFAULT_URL ? '默认站点' : 'EXPO_PUBLIC_WEB_URL'} · {current}
        </Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0c0b11' },
  web: { flex: 1 },
  loading: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  failure: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 },
  failureTitle: { color: '#edecf3', fontSize: 18, fontWeight: '700' },
  failureUrl: { color: '#a493ff', fontSize: 13 },
  failureReason: { color: '#f1877d', fontSize: 14, textAlign: 'center' },
  failureHint: { color: '#8a87a0', fontSize: 12, textAlign: 'center', lineHeight: 18 },
  retry: {
    marginTop: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#5233de',
  },
  retryText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  debugBar: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#151420' },
  debugText: { color: '#8a87a0', fontSize: 10 },
})
