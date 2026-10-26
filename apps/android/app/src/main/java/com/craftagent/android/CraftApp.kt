package com.craftagent.android

import android.app.Application

class CraftApp : Application() {
  override fun onCreate() {
    super.onCreate()
    NotificationHelper.ensureChannel(this)
  }
}
