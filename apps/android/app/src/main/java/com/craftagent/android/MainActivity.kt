package com.craftagent.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.ArrayAdapter
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.recyclerview.widget.LinearLayoutManager
import com.craftagent.android.databinding.ActivityMainBinding
import java.util.Locale
import kotlin.math.roundToInt

class MainActivity : AppCompatActivity() {
  private lateinit var binding: ActivityMainBinding
  private lateinit var store: ServerStore
  private lateinit var adapter: ServerAdapter

  private val notificationPermission =
    registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    binding = ActivityMainBinding.inflate(layoutInflater)
    setContentView(binding.root)
    binding.root.applySystemBarInsets()

    store = ServerStore(this)
    adapter = ServerAdapter(
      onClick = { openServer(it) },
      onEdit = { startActivity(ServerEditActivity.intent(this, it.id)) },
      onDelete = { confirmDelete(it) },
    )
    binding.serverList.layoutManager = LinearLayoutManager(this)
    binding.serverList.adapter = adapter

    binding.addServer.setOnClickListener { startActivity(ServerEditActivity.intent(this)) }
    binding.emptyAdd.setOnClickListener { startActivity(ServerEditActivity.intent(this)) }
    binding.displaySettingsButton.setOnClickListener { showDisplaySettings() }

    requestNotificationPermission()
  }

  override fun onResume() {
    super.onResume()
    val servers = store.all()
    adapter.submitList(servers)
    val empty = servers.isEmpty()
    binding.emptyState.visibility = if (empty) View.VISIBLE else View.GONE
    binding.serverList.visibility = if (empty) View.GONE else View.VISIBLE
  }

  private fun openServer(server: ServerEntry) {
    startActivity(WebViewActivity.intent(this, server.id))
  }

  private fun confirmDelete(server: ServerEntry) {
    AlertDialog.Builder(this)
      .setTitle(R.string.delete_server_title)
      .setMessage(getString(R.string.delete_server_message, server.name))
      .setPositiveButton(R.string.delete) { _, _ ->
        store.delete(server.id)
        val servers = store.all()
        adapter.submitList(servers)
        val empty = servers.isEmpty()
        binding.emptyState.visibility = if (empty) View.VISIBLE else View.GONE
        binding.serverList.visibility = if (empty) View.GONE else View.VISIBLE
      }
      .setNegativeButton(R.string.cancel, null)
      .show()
  }

  private fun requestNotificationPermission() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
    notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
  }

  /** 显示当前屏幕分辨率，并允许调整 WebView 的整页缩放。 */
  private fun showDisplaySettings() {
    val options = DisplaySettings.zoomOptions
    val current = DisplaySettings.zoom(this)
    var selected = options.indexOfFirst { it == current }.takeIf { it >= 0 } ?: options.indexOf(1f)
    val labels = options.map { getString(R.string.zoom_percent, DisplaySettings.percent(it)) }
    val density = resources.displayMetrics.density

    val summary = TextView(this).apply {
      val padding = (20 * density).toInt()
      setPadding(padding, padding, padding, padding / 2)
      textSize = 13f
      setTextColor(ContextCompat.getColor(this@MainActivity, R.color.craft_text))
      text = displaySummary(options[selected])
    }

    val list = ListView(this).apply {
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        (48 * density * labels.size).toInt(),
      )
      choiceMode = ListView.CHOICE_MODE_SINGLE
      adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_list_item_single_choice, labels)
      setItemChecked(selected, true)
      setOnItemClickListener { _, _, position, _ ->
        DisplaySettings.setZoom(this@MainActivity, options[position])
        summary.text = displaySummary(options[position])
      }
    }

    val container = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      addView(summary)
      addView(list)
    }

    AlertDialog.Builder(this)
      .setTitle(R.string.display_settings)
      .setView(container)
      .setPositiveButton(R.string.close, null)
      .show()
  }

  private fun displaySummary(zoom: Float): String {
    val metrics = resources.displayMetrics
    val density = metrics.density
    val screenWidth = (metrics.widthPixels / density).roundToInt()
    val screenHeight = (metrics.heightPixels / density).roundToInt()

    val bars = ViewCompat.getRootWindowInsets(binding.root)?.getInsets(
      WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
    )
    val contentWidth = ((metrics.widthPixels - (bars?.left ?: 0) - (bars?.right ?: 0)) / density / zoom).roundToInt()
    val contentHeight = ((metrics.heightPixels - (bars?.top ?: 0) - (bars?.bottom ?: 0)) / density / zoom).roundToInt()

    return listOf(
      getString(R.string.screen_logical_resolution, screenWidth, screenHeight),
      getString(R.string.screen_physical_resolution, metrics.widthPixels, metrics.heightPixels),
      getString(R.string.screen_density, String.format(Locale.US, "%.2f", density), metrics.densityDpi),
      "",
      getString(R.string.webview_zoom_value, DisplaySettings.percent(zoom)),
      getString(R.string.webview_viewport, contentWidth, contentHeight),
    ).joinToString("\n")
  }
}
