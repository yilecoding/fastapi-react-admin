import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "@admin/ui/globals.css"

import { App } from "@/app"
// 副作用导入：i18next 必须在任何组件渲染前 init 完，
// 否则首帧的 useTranslation() 拿不到语言包
import "@/i18n"
import { usePreferences } from "@admin/platform/shell/preferences"
import { applyPreferencesNow } from "@admin/platform/shell/use-apply-preferences"

// 渲染前先把偏好贴到 <html>，否则深色/换过主题色的用户会先吃一帧默认样式。
// zustand 的 persist 走 localStorage，是同步 rehydrate 的，所以这里读得到已存的值。
applyPreferencesNow(usePreferences.getState())

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
