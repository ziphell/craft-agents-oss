package com.craftagent.android

import android.view.View
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * edge-to-edge 下把系统栏、刘海与输入法的高度补成根布局的 padding。
 *
 * WebView M136+ 会把 systemBars()/displayCutout() 通过 CSS `env(safe-area-inset-*)`
 * 透传给网页（M139+ 还会按 ime() 调整 visual viewport）。原生这里已经加过 padding，
 * 若把这些值继续下发给 WebView，WebUI 会再加一次，表现为状态栏高度那么大的空白。
 *
 * 因此用 Builder 把已处理的类型置为 NONE 后再传给子 View：既避免双重留白，
 * 又保留 inset 变化的通知（不用 CONSUMED，否则会产生“幽灵 padding”）。
 */
fun View.applySystemBarInsets() {
  ViewCompat.setOnApplyWindowInsetsListener(this) { view, insets ->
    val types = WindowInsetsCompat.Type.systemBars() or
      WindowInsetsCompat.Type.displayCutout() or
      WindowInsetsCompat.Type.ime()
    val bars = insets.getInsets(types)
    view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
    WindowInsetsCompat.Builder(insets)
      .setInsets(types, Insets.NONE)
      .build()
  }
}
