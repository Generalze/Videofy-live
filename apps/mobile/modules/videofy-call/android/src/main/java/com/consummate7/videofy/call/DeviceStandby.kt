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
 * FOUR ANSWERS, NOT THREE. The first version of this file answered a nullable
 * Boolean, and null stood for three different things: an Android with no such
 * setting, a PowerManager the cast could not obtain, and an exception from the
 * read itself. The JS side turned every null into "this Android version has no
 * battery budget", so a read that FAILED told the person their phone had no
 * problem and hid the button that would fix it -- the exact defect this file
 * was written to stop. Now the answer is a word, and "unreadable" is its own
 * word: only a genuine pre-Marshmallow device may say there is nothing here.
 *
 * A third thing this file CANNOT read: the battery managers Samsung and the
 * Chinese OEMs layer on top of Android's own. No API reaches them; only the
 * person can, in their phone's settings. The JS side says so in words rather
 * than letting the exemption stand for the whole answer.
 */
object DeviceStandby {
  /** Android reports this app as ignoring battery optimisations. */
  const val GRANTED = "granted"
  /** Android reports this app as NOT exempt: the request is worth making. */
  const val NOT_GRANTED = "not-granted"
  /** Before Android 6 there is no such setting; the ONLY case with nothing to allow. */
  const val NOT_APPLICABLE = "not-applicable"
  /** The platform has the setting and the read could not be performed. Not a clean bill of health. */
  const val UNREADABLE = "unreadable"

  /**
   * One of the four words above, as Android reports it right now. Every
   * failure of the read is UNREADABLE, never NOT_APPLICABLE: the second is a
   * fact about the Android version, the first is a fact about this attempt.
   */
  fun batteryExemption(context: Context): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return NOT_APPLICABLE
    val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return UNREADABLE
    return try {
      if (pm.isIgnoringBatteryOptimizations(context.packageName)) GRANTED else NOT_GRANTED
    } catch (_: Exception) {
      UNREADABLE
    }
  }

  /**
   * The same answer as a plain number for the ring timeline, which carries
   * numbers only: 1 granted, 0 not granted, -1 not applicable, -2 unreadable.
   * The table is transcribed in src/push/ringingReadiness.ts (TIMELINE_EXEMPTION_CODES)
   * and proven there, since this file cannot be run from the workstation.
   */
  fun batteryExemptionCode(word: String): Long = when (word) {
    GRANTED -> 1L
    NOT_GRANTED -> 0L
    NOT_APPLICABLE -> -1L
    else -> -2L
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
