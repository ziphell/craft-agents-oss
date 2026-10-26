package com.craftagent.android

import android.content.Context
import kotlin.math.roundToInt

/**
 * WebView 整页缩放（根元素 CSS zoom）。1f = 100%。
 *
 * WebUI 的 viewport.ts 会读取 `getComputedStyle(html).zoom` 并把 `#root` 的宽高
 * 除以这个值，所以调大缩放等价于用更窄的逻辑视口渲染，而不是把页面裁掉。
 */
object DisplaySettings {
  private const val PREFS = "craft_display"
  private const val KEY_ZOOM = "webview_zoom"

  val zoomOptions = listOf(0.8f, 0.85f, 0.9f, 0.95f, 1f)

  fun zoom(context: Context): Float {
    val value = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getFloat(KEY_ZOOM, 1f)
    return if (zoomOptions.any { it == value }) value else 1f
  }

  fun setZoom(context: Context, zoom: Float) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putFloat(KEY_ZOOM, zoom)
      .apply()
  }

  fun percent(zoom: Float): Int = (zoom * 100).roundToInt()
}
