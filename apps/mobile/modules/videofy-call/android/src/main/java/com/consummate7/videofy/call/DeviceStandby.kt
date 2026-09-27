package com.consummate7.videofy.call

import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.Build
import android.os.PowerManager

/**
 * What Android has decided about this app's right to wake -- read, never assumed.
 *
 * WHY THIS EXISTS (27 Sep 2026). Three real calls in one evening: the server
 * sent a data-only, high-priority push with a TTL matching the ring window,
 * Google accepted all three in under a second, and the handset's timeline
 * showed NO t4_push_received at all. The phone never woke. Google's answer
 * means ACCEPTED FOR DELIVERY, not received; the only evidence a phone woke
 * is the phone saying so, and it did not.
 *
 * Two readings, both from the platform itself:
 *   - whether this app is exempt from battery optimisation (Doze and App
 *     Standby), which is what a person grants through
 *     ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS;
 *   - which standby bucket the app is filed in right now. RARE and
 *     RESTRICTED are where high-priority pushes are rationed and a
 *     foreground-service start may be refused.
 *
 * A third thing this file CANNOT read: the battery managers Samsung and the
 * Chinese OEMs layer on top of Android's own. No API reaches them; only the
 * person can, in their phone's settings. The JS side says so in words rather
 * than letting the exemption stand for the whole answer.
 */
object DeviceStandby {
  /** True or false as Android reports it; null where the platform has no such setting (before Android 6) or the read failed. */
  fun batteryExempt(context: Context): Boolean? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return null
    val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return null
    return try {
      pm.isIgnoringBatteryOptimizations(context.packageName)
    } catch (_: Exception) {
      null
    }
  }

  /**
   * The UsageStatsManager bucket constant (5 exempted, 10 active, 20 working
   * set, 30 frequent, 40 rare, 45 restricted, 50 never), or -1 where the
   * platform has no buckets (before Android 9) or the read failed. Kept as
   * the raw code: JS names it, and the ring timeline carries it as a number.
   */
  fun standbyBucket(context: Context): Int {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return -1
    val usage = context.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager ?: return -1
    return try {
      usage.appStandbyBucket
    } catch (_: Exception) {
      -1
    }
  }
}
