package com.craftagent.android

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import com.craftagent.android.databinding.ActivityServerEditBinding
import java.net.HttpURLConnection
import java.net.URL

class ServerEditActivity : AppCompatActivity() {
  companion object {
    private const val EXTRA_SERVER_ID = "server_id"

    fun intent(context: Context, serverId: String? = null): Intent =
      Intent(context, ServerEditActivity::class.java).apply {
        serverId?.let { putExtra(EXTRA_SERVER_ID, it) }
      }
  }

  private lateinit var binding: ActivityServerEditBinding
  private lateinit var store: ServerStore
  private var editing: ServerEntry? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    binding = ActivityServerEditBinding.inflate(layoutInflater)
    setContentView(binding.root)
    binding.root.applySystemBarInsets()

    store = ServerStore(this)
    editing = intent.getStringExtra(EXTRA_SERVER_ID)?.let { store.get(it) }
    editing?.let { entry ->
      binding.editTitle.setText(R.string.edit_server_title)
      binding.nameInput.setText(entry.name)
      binding.urlInput.setText(entry.url)
    }

    binding.saveButton.setOnClickListener { save() }
    binding.testButton.setOnClickListener { testConnection() }
  }

  private fun save() {
    val url = ServerStore.normalizeUrl(binding.urlInput.text?.toString().orEmpty())
    if (url == null) {
      binding.urlLayout.error = getString(R.string.error_invalid_url)
      return
    }
    binding.urlLayout.error = null

    val current = editing
    val name = binding.nameInput.text?.toString()?.trim().orEmpty()
    val entry = ServerEntry(
      id = current?.id ?: ServerStore.newId(),
      name = name.ifBlank { ServerStore.displayName(url) },
      url = url,
      // 新添加的服务器排到列表最上面；真正打开时会再刷新一次。
      lastUsedAt = current?.lastUsedAt ?: System.currentTimeMillis(),
    )
    store.save(entry)
    finish()
  }

  private fun testConnection() {
    val url = ServerStore.normalizeUrl(binding.urlInput.text?.toString().orEmpty())
    if (url == null) {
      binding.urlLayout.error = getString(R.string.error_invalid_url)
      return
    }
    binding.urlLayout.error = null
    binding.testButton.isEnabled = false
    binding.testButton.setText(R.string.testing)

    Thread({
      val message = try {
        val connection = (URL("$url/health").openConnection() as HttpURLConnection).apply {
          connectTimeout = 5000
          readTimeout = 5000
          requestMethod = "GET"
        }
        val code = connection.responseCode
        connection.disconnect()
        getString(R.string.test_result, code)
      } catch (error: Exception) {
        getString(R.string.test_failed, error.message ?: error.javaClass.simpleName)
      }
      runOnUiThread {
        if (isFinishing || isDestroyed) return@runOnUiThread
        binding.testButton.isEnabled = true
        binding.testButton.setText(R.string.test_connection)
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
      }
    }, "craft-server-test").start()
  }
}
