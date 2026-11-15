package com.craftagent.android

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.util.UUID

data class ServerEntry(
  val id: String,
  val name: String,
  val url: String,
  val lastUsedAt: Long = 0L,
)

/**
 * 服务器列表只保存在本机 SharedPreferences 里。
 * 会话凭据（craft_session cookie）由 WebView 的 CookieManager 按域名管理，这里不接触 token。
 */
class ServerStore(context: Context) {
  private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  fun all(): List<ServerEntry> = load().sortedByDescending { it.lastUsedAt }

  fun get(id: String): ServerEntry? = load().firstOrNull { it.id == id }

  fun save(entry: ServerEntry) {
    val entries = load()
    val index = entries.indexOfFirst { it.id == entry.id }
    if (index >= 0) entries[index] = entry else entries.add(entry)
    persist(entries)
  }

  fun delete(id: String) {
    persist(load().filterNot { it.id == id })
  }

  fun touch(id: String) {
    val entries = load()
    val index = entries.indexOfFirst { it.id == id }
    if (index < 0) return
    entries[index] = entries[index].copy(lastUsedAt = System.currentTimeMillis())
    persist(entries)
  }

  private fun load(): MutableList<ServerEntry> {
    val raw = prefs.getString(KEY_SERVERS, null) ?: return mutableListOf()
    val array = runCatching { JSONArray(raw) }.getOrNull() ?: return mutableListOf()
    val entries = mutableListOf<ServerEntry>()
    for (index in 0 until array.length()) {
      val item = array.optJSONObject(index) ?: continue
      val id = item.optString("id")
      val url = item.optString("url")
      if (id.isBlank() || url.isBlank()) continue
      entries.add(
        ServerEntry(
          id = id,
          name = item.optString("name").ifBlank { displayName(url) },
          url = url,
          lastUsedAt = item.optLong("lastUsedAt", 0L),
        ),
      )
    }
    return entries
  }

  private fun persist(entries: List<ServerEntry>) {
    val array = JSONArray()
    entries.forEach { entry ->
      array.put(
        JSONObject()
          .put("id", entry.id)
          .put("name", entry.name)
          .put("url", entry.url)
          .put("lastUsedAt", entry.lastUsedAt),
      )
    }
    prefs.edit().putString(KEY_SERVERS, array.toString()).apply()
  }

  companion object {
    private const val PREFS_NAME = "craft_servers"
    private const val KEY_SERVERS = "servers"

    fun newId(): String = UUID.randomUUID().toString()

    /**
     * 只接受 origin：WebUI 的静态资源与 API 都挂在服务器根路径上，
     * 带路径/查询的地址会被截断成 origin 后行为不一致，因此直接拒绝。
     */
    fun normalizeUrl(raw: String): String? {
      var value = raw.trim()
      if (value.isEmpty()) return null
      if (!value.contains("://")) value = "http://$value"
      val uri = runCatching { URI(value) }.getOrNull() ?: return null
      val scheme = uri.scheme?.lowercase() ?: return null
      if (scheme != "http" && scheme != "https") return null
      if (uri.host.isNullOrBlank()) return null
      if (uri.userInfo != null) return null
      val path = uri.path ?: ""
      if (path.isNotEmpty() && path != "/") return null
      if (uri.query != null || uri.fragment != null) return null
      val port = if (uri.port == -1) "" else ":${uri.port}"
      return "$scheme://${uri.host}$port"
    }

    fun displayName(url: String): String {
      val uri = runCatching { URI(url) }.getOrNull() ?: return url
      val host = uri.host ?: return url
      return if (uri.port == -1) host else "$host:${uri.port}"
    }
  }
}
