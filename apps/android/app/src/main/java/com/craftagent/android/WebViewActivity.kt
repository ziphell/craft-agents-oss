package com.craftagent.android

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.os.Environment
import android.os.Message
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.craftagent.android.databinding.ActivityWebviewBinding
import org.json.JSONObject
import java.io.File
import java.net.URLDecoder

/**
 * 一个服务器一个 WebViewActivity 实例，直接加载该服务器自己的 WebUI。
 * 页面、REST、WebSocket 同源同端口，因此不需要在 App 内做反向代理。
 */
class WebViewActivity : AppCompatActivity() {
  companion object {
    private const val TAG = "CraftWebView"
    private const val BRIDGE_NAME = "craftBridge"

    const val EXTRA_SERVER_ID = "server_id"
    const val EXTRA_WORKSPACE_ID = "workspace_id"
    const val EXTRA_SESSION_ID = "session_id"

    fun intent(
      context: Context,
      serverId: String,
      workspaceId: String? = null,
      sessionId: String? = null,
    ): Intent = Intent(context, WebViewActivity::class.java).apply {
      putExtra(EXTRA_SERVER_ID, serverId)
      workspaceId?.let { putExtra(EXTRA_WORKSPACE_ID, it) }
      sessionId?.let { putExtra(EXTRA_SESSION_ID, it) }
    }
  }

  private lateinit var binding: ActivityWebviewBinding
  private lateinit var store: ServerStore
  private lateinit var server: ServerEntry
  private lateinit var serverUri: Uri

  private var isForeground = true
  private var pageLoaded = false
  private var loadFailed = false
  /** WebUI 的 SPA 历史状态；bridge ready 后以它为准，WebView 原生历史只作兜底。 */
  private var pageBridgeReady = false
  private var pageCanGoBack = false
  private var pendingNavigate: Pair<String?, String?>? = null
  private var filePathCallback: ValueCallback<Array<Uri>>? = null

  /**
   * 只在 WebView 还有历史时启用。禁用时把返回交还给系统，由预测式返回手势把当前页推出、
   * 露出下面的服务器列表；页内还有历史时，返回先走页面自己的 history。
   */
  private lateinit var backCallback: OnBackPressedCallback

  private val fileChooser =
    registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      val callback = filePathCallback ?: return@registerForActivityResult
      filePathCallback = null
      val data = result.data
      val uris = when {
        result.resultCode != RESULT_OK || data == null -> null
        data.clipData != null -> {
          val clip = data.clipData!!
          Array(clip.itemCount) { clip.getItemAt(it).uri }
        }
        data.data != null -> arrayOf(data.data!!)
        else -> null
      }
      callback.onReceiveValue(uris)
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    store = ServerStore(this)

    val requested = intent.getStringExtra(EXTRA_SERVER_ID)?.let { store.get(it) }
    if (requested == null) {
      Toast.makeText(this, R.string.server_not_found, Toast.LENGTH_LONG).show()
      startActivity(Intent(this, MainActivity::class.java))
      finish()
      return
    }
    server = requested
    serverUri = Uri.parse(server.url)

    binding = ActivityWebviewBinding.inflate(layoutInflater)
    setContentView(binding.root)
    binding.root.applySystemBarInsets()

    setupWebView()
    registerBridge()
    binding.retryButton.setOnClickListener {
      binding.errorView.visibility = View.GONE
      binding.webView.visibility = View.VISIBLE
      loadTarget()
    }

    backCallback = onBackPressedDispatcher.addCallback(this) {
      goBackInPage()
    }
    backCallback.isEnabled = false

    store.touch(server.id)
    loadTarget()
    updateBackState()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)

    val nextServerId = intent.getStringExtra(EXTRA_SERVER_ID)
    if (!nextServerId.isNullOrBlank() && nextServerId != server.id) {
      // 通知指向另一台服务器：沿用同一 Activity 会保留旧页面上下文，直接重建。
      recreate()
      return
    }

    val workspaceId = intent.getStringExtra(EXTRA_WORKSPACE_ID)
    val sessionId = intent.getStringExtra(EXTRA_SESSION_ID)
    if (workspaceId.isNullOrBlank() && sessionId.isNullOrBlank()) return
    if (pageLoaded) dispatchNavigate(workspaceId, sessionId) else pendingNavigate = workspaceId to sessionId
  }

  override fun onResume() {
    super.onResume()
    isForeground = true
    dispatchForeground()
    updateBackState()
  }

  override fun onPause() {
    isForeground = false
    dispatchForeground()
    CookieManager.getInstance().flush()
    super.onPause()
  }

  override fun onDestroy() {
    filePathCallback?.onReceiveValue(null)
    filePathCallback = null
    if (::binding.isInitialized) {
      (binding.webView.parent as? ViewGroup)?.removeView(binding.webView)
      binding.webView.destroy()
    }
    super.onDestroy()
  }

  // ── WebView ────────────────────────────────────────────────────────────────

  @SuppressLint("SetJavaScriptEnabled")
  private fun setupWebView() {
    if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)

    val web = binding.webView
    web.setBackgroundColor(ContextCompat.getColor(this, R.color.craft_background))
    web.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      allowContentAccess = true
      allowFileAccess = false
      setSupportMultipleWindows(true)
      javaScriptCanOpenWindowsAutomatically = true
      mediaPlaybackRequiresUserGesture = false
      mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
      builtInZoomControls = false
      displayZoomControls = false
      userAgentString = "$userAgentString CraftAgentsAndroid/${BuildConfig.VERSION_NAME}"
    }
    CookieManager.getInstance().apply {
      setAcceptCookie(true)
      setAcceptThirdPartyCookies(web, false)
    }

    web.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
      enqueueDownload(url, userAgent, contentDisposition, mimeType)
    }

    web.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val uri = request.url
        return when (uri.scheme?.lowercase()) {
          "http", "https" -> if (sameServer(uri)) false else {
            openExternal(uri)
            true
          }
          "about", "data", "blob", "javascript" -> false
          else -> {
            openExternal(uri)
            true
          }
        }
      }

      override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
        pageLoaded = false
        loadFailed = false
        pageBridgeReady = false
        pageCanGoBack = false
        binding.progress.visibility = View.VISIBLE
        updateBackState()
      }

      override fun onPageFinished(view: WebView, url: String?) {
        binding.progress.visibility = View.GONE
        // 主框架失败时 Chromium 也会回调 onPageFinished，不能在这里把错误页盖掉。
        if (loadFailed) return
        pageLoaded = true
        binding.errorView.visibility = View.GONE
        binding.webView.visibility = View.VISIBLE
        applyZoom()
        dispatchForeground()
        pendingNavigate?.let { (workspaceId, sessionId) ->
          pendingNavigate = null
          dispatchNavigate(workspaceId, sessionId)
        }
        updateBackState()
      }

      override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
        updateBackState()
      }

      override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (!request.isForMainFrame) return
        loadFailed = true
        showError(getString(R.string.webview_error_title), error.description?.toString().orEmpty())
      }

      override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
        val host = Uri.parse(error.url).host
        if (server.trustSelfSigned && host != null && host.equals(serverUri.host, ignoreCase = true)) {
          handler.proceed()
        } else {
          handler.cancel()
          loadFailed = true
          showError(getString(R.string.webview_error_title), error.toString())
        }
      }
    }

    web.webChromeClient = object : WebChromeClient() {
      override fun onProgressChanged(view: WebView, newProgress: Int) {
        binding.progress.progress = newProgress
        binding.progress.visibility = if (newProgress in 1..99) View.VISIBLE else View.GONE
      }

      override fun onCreateWindow(
        view: WebView,
        isDialog: Boolean,
        isUserGesture: Boolean,
        resultMsg: Message,
      ): Boolean {
        val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
        val popup = WebView(this@WebViewActivity)
        popup.webViewClient = object : WebViewClient() {
          override fun shouldOverrideUrlLoading(popupView: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            if (uri.scheme == "about") return false
            popupView.stopLoading()
            popupView.post { popupView.destroy() }
            if (sameServer(uri)) binding.webView.loadUrl(uri.toString()) else openExternal(uri)
            return true
          }
        }
        transport.webView = popup
        resultMsg.sendToTarget()
        return true
      }

      override fun onShowFileChooser(
        webView: WebView,
        callback: ValueCallback<Array<Uri>>,
        params: WebChromeClient.FileChooserParams,
      ): Boolean {
        filePathCallback?.onReceiveValue(null)
        filePathCallback = callback
        val chooser = params.createIntent().apply {
          addCategory(Intent.CATEGORY_OPENABLE)
          if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
          }
        }
        return try {
          fileChooser.launch(chooser)
          true
        } catch (error: ActivityNotFoundException) {
          filePathCallback = null
          callback.onReceiveValue(null)
          Toast.makeText(this@WebViewActivity, R.string.open_failed, Toast.LENGTH_LONG).show()
          true
        }
      }

      override fun onJsAlert(
        view: WebView,
        url: String?,
        message: String?,
        result: android.webkit.JsResult,
      ): Boolean {
        AlertDialog.Builder(this@WebViewActivity)
          .setMessage(message)
          .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
          .setOnCancelListener { result.cancel() }
          .show()
        return true
      }

      override fun onJsConfirm(
        view: WebView,
        url: String?,
        message: String?,
        result: android.webkit.JsResult,
      ): Boolean {
        AlertDialog.Builder(this@WebViewActivity)
          .setMessage(message)
          .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
          .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
          .setOnCancelListener { result.cancel() }
          .show()
        return true
      }

      override fun onJsPrompt(
        view: WebView,
        url: String?,
        message: String?,
        defaultValue: String?,
        result: android.webkit.JsPromptResult,
      ): Boolean {
        val input = EditText(this@WebViewActivity).apply {
          setText(defaultValue.orEmpty())
          setSelection(text.length)
        }
        val container = FrameLayout(this@WebViewActivity).apply {
          val density = resources.displayMetrics.density
          setPadding((20 * density).toInt(), (8 * density).toInt(), (20 * density).toInt(), 0)
          addView(input)
        }
        AlertDialog.Builder(this@WebViewActivity)
          .setMessage(message)
          .setView(container)
          .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm(input.text.toString()) }
          .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
          .setOnCancelListener { result.cancel() }
          .show()
        return true
      }

      override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
        Log.d(TAG, "${consoleMessage.message()} (${consoleMessage.sourceId()}:${consoleMessage.lineNumber()})")
        return true
      }
    }
  }

  private fun loadTarget() {
    binding.webView.loadUrl(targetUrl())
  }

  /**
   * 服务器列表里的显示设置：把整页缩放写到根元素，并触发 resize 让 WebUI
   * 按新的逻辑视口重新排一遍（viewport.ts 会把宽高除以 CSS zoom）。
   */
  private fun applyZoom() {
    val zoom = DisplaySettings.zoom(this)
    binding.webView.evaluateJavascript(
      "(function(){var d=document.documentElement;if(!d)return;d.style.zoom='$zoom';" +
        "window.dispatchEvent(new Event('resize'));})()",
      null,
    )
  }

  private fun targetUrl(): String {
    val base = if (server.url.endsWith("/")) server.url else "${server.url}/"
    val workspaceId = intent.getStringExtra(EXTRA_WORKSPACE_ID)
    val sessionId = intent.getStringExtra(EXTRA_SESSION_ID)
    if (workspaceId.isNullOrBlank() && sessionId.isNullOrBlank()) return base
    return Uri.parse(base).buildUpon().apply {
      if (!workspaceId.isNullOrBlank()) appendQueryParameter("workspace", workspaceId)
      if (!sessionId.isNullOrBlank()) appendQueryParameter("sessionId", sessionId)
    }.build().toString()
  }

  // ── Native bridge（通知 / 前后台） ─────────────────────────────────────────

  private fun registerBridge() {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      Log.w(TAG, "System WebView does not support WEB_MESSAGE_LISTENER")
      Toast.makeText(this, R.string.bridge_unsupported, Toast.LENGTH_LONG).show()
      return
    }

    WebViewCompat.addWebMessageListener(
      binding.webView,
      BRIDGE_NAME,
      setOf(originRule(serverUri)),
      object : WebViewCompat.WebMessageListener {
        override fun onPostMessage(
          view: WebView,
          message: WebMessageCompat,
          sourceOrigin: Uri,
          isMainFrame: Boolean,
          replyProxy: JavaScriptReplyProxy,
        ) {
          if (!isMainFrame || !sameServer(sourceOrigin)) return
          if (message.type != WebMessageCompat.TYPE_STRING) return
          val payload = runCatching { JSONObject(message.data ?: "") }.getOrNull() ?: return

          when (payload.optString("type")) {
            "ready" -> {
              pageBridgeReady = true
              dispatchForeground()
              updateBackState()
            }
            "navigationState" -> {
              pageBridgeReady = true
              pageCanGoBack = payload.optBoolean("canGoBack", false)
              updateBackState()
            }
            "openServerList" -> openServerList()
            "notification" -> {
              val title = payload.optString("title").trim().take(120)
              val body = payload.optString("body").trim().take(500)
              if (title.isEmpty() && body.isEmpty()) return
              NotificationHelper.show(
                context = this@WebViewActivity,
                serverId = server.id,
                workspaceId = payload.optString("workspaceId").takeIf { it.isNotBlank() },
                sessionId = payload.optString("sessionId").takeIf { it.isNotBlank() },
                title = title.ifEmpty { getString(R.string.app_name) },
                body = body,
              )
            }
          }
        }
      },
    )
  }

  private fun dispatchForeground() {
    dispatch(JSONObject().put("type", "foreground").put("foreground", isForeground))
  }

  private fun dispatchNavigate(workspaceId: String?, sessionId: String?) {
    val payload = JSONObject().put("type", "notificationNavigate")
    payload.put("workspaceId", workspaceId ?: JSONObject.NULL)
    payload.put("sessionId", sessionId ?: JSONObject.NULL)
    dispatch(payload)
  }

  /** 只向主框架投递；webui 的 native-bridge 会再校验消息形状。 */
  private fun dispatch(payload: JSONObject) {
    if (!::binding.isInitialized || !pageLoaded) return
    val quoted = JSONObject.quote(payload.toString())
    binding.webView.evaluateJavascript(
      "window.__craftNativeDispatch&&window.__craftNativeDispatch(JSON.parse($quoted))",
      null,
    )
  }

  private fun originRule(uri: Uri): String {
    val scheme = uri.scheme ?: "http"
    val defaultPort = if (scheme == "https") 443 else 80
    val portSuffix = if (uri.port == -1 || uri.port == defaultPort) "" else ":${uri.port}"
    return "$scheme://${uri.host}$portSuffix"
  }

  private fun sameServer(uri: Uri): Boolean {
    if (uri.scheme?.equals(serverUri.scheme, ignoreCase = true) != true) return false
    if (uri.host?.equals(serverUri.host, ignoreCase = true) != true) return false
    return effectivePort(uri) == effectivePort(serverUri)
  }

  private fun effectivePort(uri: Uri): Int = when {
    uri.port != -1 -> uri.port
    uri.scheme?.equals("https", ignoreCase = true) == true -> 443
    else -> 80
  }

  // ── 下载 / 外链 ────────────────────────────────────────────────────────────

  private fun enqueueDownload(
    url: String,
    userAgent: String?,
    contentDisposition: String?,
    mimeType: String?,
  ) {
    val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return
    if (uri.scheme != "http" && uri.scheme != "https") return
    try {
      val fileName = uniqueFileName(downloadFileName(uri, contentDisposition))
      val request = DownloadManager.Request(uri).apply {
        if (!mimeType.isNullOrBlank()) setMimeType(mimeType)
        CookieManager.getInstance().getCookie(url)?.takeIf { it.isNotBlank() }?.let {
          addRequestHeader("Cookie", it)
        }
        userAgent?.takeIf { it.isNotBlank() }?.let { addRequestHeader("User-Agent", it) }
        setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
      }
      (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
      Toast.makeText(this, R.string.download_started, Toast.LENGTH_SHORT).show()
    } catch (error: Exception) {
      Log.w(TAG, "enqueue download failed", error)
      Toast.makeText(this, getString(R.string.download_failed, error.message.orEmpty()), Toast.LENGTH_LONG).show()
    }
  }

  private fun downloadFileName(uri: Uri, contentDisposition: String?): String {
    val header = contentDisposition.orEmpty()
    val encoded = Regex("filename\\*=UTF-8''([^;]+)", RegexOption.IGNORE_CASE)
      .find(header)?.groupValues?.get(1)
    val plain = Regex("filename=\"?([^\";]+)\"?", RegexOption.IGNORE_CASE)
      .find(header)?.groupValues?.get(1)
    val candidate = encoded?.let { runCatching { URLDecoder.decode(it, "UTF-8") }.getOrNull() }
      ?: plain
      ?: uri.lastPathSegment
      ?: "craft-download"
    val sanitized = candidate.replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1f]"), "_").trim()
    return sanitized.ifBlank { "craft-download" }
  }

  private fun uniqueFileName(name: String): String {
    val directory = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
    if (!File(directory, name).exists()) return name
    val dot = name.lastIndexOf('.')
    val stem = if (dot > 0) name.substring(0, dot) else name
    val suffix = if (dot > 0) name.substring(dot) else ""
    var index = 1
    while (true) {
      val candidate = "$stem ($index)$suffix"
      if (!File(directory, candidate).exists()) return candidate
      index += 1
    }
  }

  private fun openExternal(uri: Uri) {
    try {
      startActivity(Intent(Intent.ACTION_VIEW, uri))
    } catch (error: ActivityNotFoundException) {
      Toast.makeText(this, R.string.open_failed, Toast.LENGTH_LONG).show()
    }
  }

  // ── UI ─────────────────────────────────────────────────────────────────────

  /** 退回服务器列表：WebUI 的 logo 菜单通过 bridge 调用。 */
  private fun openServerList() {
    startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
    finish()
  }

  /**
   * 页内还有历史时拦截系统返回，交给 SPA 的 history；没有历史时禁用回调，
   * 让预测式返回手势把当前页推出、露出下面的服务器列表。
   */
  private fun updateBackState() {
    if (!::binding.isInitialized || !::backCallback.isInitialized) return
    val nativeCanGoBack = binding.webView.copyBackForwardList().currentIndex > 0
    // WebUI 是 SPA，原生 WebView 历史不跟 pushState；bridge 就绪后以页面状态为准。
    backCallback.isEnabled = if (pageBridgeReady) pageCanGoBack else nativeCanGoBack
  }

  /** 有 SPA 历史时让页面自己 history.back()，否则退回 WebView 原生历史。 */
  private fun goBackInPage() {
    if (pageBridgeReady) {
      if (pageCanGoBack) dispatch(JSONObject().put("type", "navigateBack"))
    } else if (binding.webView.copyBackForwardList().currentIndex > 0) {
      binding.webView.goBackOrForward(-1)
    }
  }

  private fun showError(title: String, detail: String) {
    if (!::binding.isInitialized) return
    binding.progress.visibility = View.GONE
    binding.webView.visibility = View.INVISIBLE
    binding.errorView.visibility = View.VISIBLE
    binding.errorTitle.text = title
    binding.errorDetail.text = detail
  }
}
