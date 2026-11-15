package com.craftagent.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.TaskStackBuilder
import androidx.core.content.ContextCompat

object NotificationHelper {
  private const val CHANNEL_ID = "craft_messages"

  fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      context.getString(R.string.notification_channel_name),
      NotificationManager.IMPORTANCE_HIGH,
    ).apply {
      description = context.getString(R.string.notification_channel_description)
    }
    manager.createNotificationChannel(channel)
  }

  @SuppressLint("MissingPermission")
  fun show(
    context: Context,
    serverId: String,
    workspaceId: String?,
    sessionId: String?,
    title: String,
    body: String,
  ) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      return
    }
    ensureChannel(context)

    val intent = Intent(context, WebViewActivity::class.java).apply {
      putExtra(WebViewActivity.EXTRA_SERVER_ID, serverId)
      workspaceId?.let { putExtra(WebViewActivity.EXTRA_WORKSPACE_ID, it) }
      sessionId?.let { putExtra(WebViewActivity.EXTRA_SESSION_ID, it) }
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
    }
    // 同一会话的消息互相覆盖，不同会话各自保留一条。
    val notificationId = "craft:$serverId:${workspaceId.orEmpty()}:${sessionId ?: title}".hashCode()
    // 让服务器列表始终在 WebView 下面：根页返回时预测式手势才有可露出的目标。
    val pendingIntent = TaskStackBuilder.create(context)
      .addParentStack(WebViewActivity::class.java)
      .addNextIntent(intent)
      .getPendingIntent(
        notificationId,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )

    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(true)
      .setContentIntent(pendingIntent)
      .build()

    runCatching { NotificationManagerCompat.from(context).notify(notificationId, notification) }
  }
}
