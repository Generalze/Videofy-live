package com.consummate7.videofy.call

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * The ring.
 *
 * A PHONE-CALL FOREGROUND SERVICE, because that is what Android lets ring a
 * locked phone. It validates the call with the gateway (T5), acknowledges
 * that it is ringing (T6/T7 -- the caller's "Ringing…" comes from this ack,
 * never from a push being sent), then posts a CallStyle notification with a
 * full-screen intent to IncomingCallActivity, the system ringtone on a
 * ringtone-class channel, and vibration. Answer and Decline are handled by
 * CallActionReceiver; the timer aligned to the ring's expiry ends it as a
 * missed call.
 *
 * ONE RING AT A TIME. A second call while ringing is declined as busy by
 * the server anyway; here it is simply ignored.
 */
class IncomingCallService : Service() {

  private val executor = Executors.newSingleThreadExecutor()
  private val handler = Handler(Looper.getMainLooper())
  private var wakeLock: PowerManager.WakeLock? = null
  private var ringing: String? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_RING -> ring(intent)
      ACTION_STOP -> stopRinging(intent.getStringExtra(EXTRA_CALL_ID), intent.getStringExtra(EXTRA_REASON) ?: "stopped")
      else -> stopSelf()
    }
    return START_NOT_STICKY
  }

  private fun ring(intent: Intent) {
    val callId = intent.getStringExtra(EXTRA_CALL_ID) ?: return stopSelf()
    val callerId = intent.getStringExtra(EXTRA_CALLER_ID) ?: ""
    var callerName = intent.getStringExtra(EXTRA_CALLER_NAME) ?: "Caller"
    var mode = intent.getStringExtra(EXTRA_MODE) ?: "normal"
    val expiresAt = intent.getLongExtra(EXTRA_EXPIRES_AT, 0L)
    if (ringing != null) return
    ringing = callId

    ensureChannel(this)
    /*
     * PREVALIDATION IS SILENT. Android needs a foreground notification within
     * seconds of the service starting, but nothing may RING until the account
     * (a bound, unexpired credential) and the server (ring: true) both say so.
     * So the service stands up on a silent, low-importance channel with no
     * sound, no vibration and no full-screen intent; the CallStyle ring on
     * the ringtone channel replaces it only after validation. Before this a
     * signed-out phone rang for a moment before discovering it had no
     * credential (founder review, 29 Aug).
     */
    startInForeground(SILENT_NOTIFICATION_ID, buildSilentNotification())
    acquireWakeLock()

    val store = RingStore(this)
    executor.execute {
      val credential = store.credential()
      if (credential == null) {
        Log.i(TAG, "no bound ring credential; the call is not for this phone")
        handler.post { finish(callId, "no-credential") }
        return@execute
      }
      val validator = CallValidator(credential.gatewayUrl, credential.token)
      val verdict = validator.check(callId)
      store.mark(callId, "t5_validated")
      if (verdict == null || !verdict.ring) {
        if (verdict?.unauthorized == true) store.clearAll()
        handler.post { finish(callId, if (verdict == null) "unreachable" else verdict.state) }
        return@execute
      }
      callerName = verdict.callerName.ifBlank { callerName }
      mode = verdict.mode
      val live = validator.ackRinging(callId)
      store.mark(callId, "t6_ringing_acked")
      if (!live) {
        handler.post { finish(callId, "not-live") }
        return@execute
      }
      handler.post {
        if (ringing != callId) return@post
        expiresAtFor[callId] = expiresAt
        val resolvedCallerId = verdict.callerAccountId.ifBlank { callerId }
        /*
         * Validated: now, and only now, the ring. Offered to Telecom first
         * (phase 2): when it accepts, it calls back onShowIncomingCallUi and
         * the same presentation runs from there; when it declines, the
         * phase-1 presentation runs directly. Either way the phone rings.
         */
        if (!TelecomBridge.offerIncoming(this@IncomingCallService, callId, resolvedCallerId, callerName, mode)) {
          present(callId, resolvedCallerId, callerName, mode)
        }
      }
    }
  }

  private val expiresAtFor = HashMap<String, Long>()

  /** The in-flight ring watch, so it can be cancelled the moment the ring ends. */
  private var ringWatch: Runnable? = null

  /** The ring itself: CallStyle on the ringtone channel, vibration, the incoming event, the timeout. */
  fun present(callId: String, callerId: String, callerName: String, mode: String) {
    if (ringing != callId) return
    val notification = buildNotification(callId, callerId, callerName, mode, validating = false)
    /*
     * A NEW NOTIFICATION, NOT A REWRITE. Android fires a full-screen intent
     * when a notification ARRIVES and never when an existing one is edited in
     * place, so the ring cannot reuse the id the silent placeholder is already
     * showing under -- it would keep the ringtone and the vibration and
     * quietly lose the screen (founder review, 2 Sep). The placeholder holds
     * its own id and is dismissed once the ring has taken over as the
     * service's foreground notification.
     */
    startInForeground(NOTIFICATION_ID, notification)
    notificationManager().cancel(SILENT_NOTIFICATION_ID)
    RingStore(this).mark(callId, "t7_presented")
    startVibration()
    VideofyCallModule.emitIncoming(callId, callerId, callerName, mode)
    val expiresAt = expiresAtFor[callId] ?: 0L
    val remaining = if (expiresAt > 0) expiresAt - System.currentTimeMillis() else 30_000L
    handler.postDelayed({ if (ringing == callId) finish(callId, "timeout") }, remaining.coerceIn(3_000L, 45_000L))
    startRingWatch(callId)
  }

  /**
   * Keep asking the server whether this is still a ring, for as long as it rings.
   *
   * The pre-ring check happens once, and cannot see a caller who hangs up a
   * second later. A ringing phone has no other relationship with the call --
   * it is not in the call room, it holds no seat, it only had a push -- so
   * without this it rings until its own timeout, long after the caller has
   * gone (founder review, 2 Sep). The fallback ring screen in JS has always
   * polled for exactly this reason; the native ring never did.
   *
   * A FAILED CHECK IS NOT A DISMISSAL. Only the server saying the call is no
   * longer ringable stops the ring; an unreachable server leaves it ringing,
   * which is the same rule `shouldDismissIncoming` follows in JS.
   */
  private fun startRingWatch(callId: String) {
    val tick = object : Runnable {
      override fun run() {
        if (ringing != callId) return
        val again = this
        executor.execute {
          val credential = RingStore(this@IncomingCallService).credential()
          val verdict =
            if (credential == null) null
            else CallValidator(credential.gatewayUrl, credential.token).check(callId)
          handler.post {
            if (ringing != callId) return@post
            if (verdict != null && !verdict.ring) finish(callId, verdict.state)
            else handler.postDelayed(again, RING_POLL_MS)
          }
        }
      }
    }
    ringWatch = tick
    handler.postDelayed(tick, RING_POLL_MS)
  }

  private fun stopRinging(callId: String?, reason: String) {
    if (callId != null && ringing != null && ringing != callId) return
    finish(ringing ?: callId ?: "", reason)
  }

  private fun finish(callId: String, reason: String) {
    ringWatch?.let { handler.removeCallbacks(it) }
    ringWatch = null
    if (reason == "timeout") VideofyCallModule.emitTimeout(callId)
    // A ring that ends before an answer also ends its Telecom connection.
    if (reason != "answered") TelecomBridge.end(callId, missed = reason == "timeout")
    expiresAtFor.remove(callId)
    ringing = null
    stopVibration()
    notificationManager().cancel(NOTIFICATION_ID)
    notificationManager().cancel(SILENT_NOTIFICATION_ID)
    releaseWakeLock()
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun startInForeground(id: Int, notification: Notification) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
    } else {
      startForeground(id, notification)
    }
  }

  /** The silent stand-in while the call is checked: no sound, no vibration, no full-screen. */
  private fun buildSilentNotification(): Notification =
    NotificationCompat.Builder(this, SILENT_CHANNEL_ID)
      .setSmallIcon(android.R.drawable.sym_call_incoming)
      .setContentTitle("Checking a call")
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setSilent(true)
      .setOngoing(true)
      .build()

  private fun buildNotification(callId: String, callerId: String, callerName: String, mode: String, validating: Boolean): Notification {
    val fullScreen = PendingIntent.getActivity(
      this,
      1,
      IncomingCallActivity.intent(this, callId, callerId, callerName, mode),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val answer = CallActionReceiver.pendingIntent(this, CallActionReceiver.ACTION_ANSWER, callId, callerId, callerName, mode, 2)
    val decline = CallActionReceiver.pendingIntent(this, CallActionReceiver.ACTION_DECLINE, callId, callerId, callerName, mode, 3)
    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.sym_call_incoming)
      .setContentTitle(callerName)
      .setContentText(if (validating) "Incoming C7 call" else if (mode == "translated") "Incoming translated call" else "Incoming C7 call")
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setAutoCancel(false)
      .setFullScreenIntent(fullScreen, true)
      .setContentIntent(fullScreen)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val person = androidx.core.app.Person.Builder().setName(callerName).setImportant(true).build()
      builder.setStyle(NotificationCompat.CallStyle.forIncomingCall(person, decline, answer))
    } else {
      builder.addAction(0, "Decline", decline).addAction(0, "Answer", answer)
    }
    return builder.build()
  }

  private fun acquireWakeLock() {
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "videofy:ring").apply { acquire(60_000L) }
  }

  private fun releaseWakeLock() {
    try { wakeLock?.takeIf { it.isHeld }?.release() } catch (_: Exception) {}
    wakeLock = null
  }

  private fun vibrator(): Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
    (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
  } else {
    @Suppress("DEPRECATION") getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
  }

  private fun startVibration() {
    try {
      val pattern = longArrayOf(0, 900, 700)
      vibrator()?.vibrate(VibrationEffect.createWaveform(pattern, 0))
    } catch (_: Exception) {}
  }

  private fun stopVibration() {
    try { vibrator()?.cancel() } catch (_: Exception) {}
  }

  private fun notificationManager(): NotificationManager =
    getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  override fun onDestroy() {
    if (instance === this) instance = null
    stopVibration()
    releaseWakeLock()
    executor.shutdown()
    super.onDestroy()
  }

  companion object {
    @Volatile private var instance: IncomingCallService? = null

    /** Telecom accepted the call and asks for the UI; the running service presents it. */
    fun presentValidated(context: Context, callId: String, callerId: String, callerName: String, mode: String) {
      val service = instance
      if (service != null) {
        service.handler.post { service.present(callId, callerId, callerName, mode) }
      } else {
        // The service is gone (rare: Telecom answered late); ring via a fresh start.
        val intent = Intent(context, IncomingCallService::class.java).apply {
          action = ACTION_RING
          putExtra(EXTRA_CALL_ID, callId)
          putExtra(EXTRA_CALLER_ID, callerId)
          putExtra(EXTRA_CALLER_NAME, callerName)
          putExtra(EXTRA_MODE, mode)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
      }
    }

    /**
     * How often a ringing phone re-asks the server. Short enough that a
     * cancelled call stops ringing while the caller is still looking at the
     * screen; long enough not to be a poll storm on a 45-second ring.
     */
    private const val RING_POLL_MS = 2_000L

    const val ACTION_RING = "com.consummate7.videofy.call.RING"
    const val ACTION_STOP = "com.consummate7.videofy.call.STOP"
    const val EXTRA_CALL_ID = "callId"
    const val EXTRA_CALLER_ID = "callerId"
    const val EXTRA_CALLER_NAME = "callerName"
    const val EXTRA_MODE = "mode"
    const val EXTRA_EXPIRES_AT = "expiresAt"
    const val EXTRA_REASON = "reason"
    const val CHANNEL_ID = "incoming_calls"
    const val SILENT_CHANNEL_ID = "call_check"
    const val NOTIFICATION_ID = 7001
    const val SILENT_NOTIFICATION_ID = 7002
    private const val TAG = "VideofyCall"

    /** The ringtone-class channel: system ringtone, vibration, lock-screen visible; and the silent check channel. */
    fun ensureChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (manager.getNotificationChannel(SILENT_CHANNEL_ID) == null) {
        manager.createNotificationChannel(
          NotificationChannel(SILENT_CHANNEL_ID, "Call checks", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Silent, while an incoming call is verified"
            setSound(null, null)
            enableVibration(false)
            lockscreenVisibility = Notification.VISIBILITY_SECRET
          },
        )
      }
      if (manager.getNotificationChannel(CHANNEL_ID) != null) return
      val channel = NotificationChannel(CHANNEL_ID, "Incoming calls", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Rings for C7 calls"
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        enableVibration(true)
        setBypassDnd(false)
        setSound(
          RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build(),
        )
      }
      manager.createNotificationChannel(channel)
    }

    /** Stop the ring from anywhere (JS reportCallEnded, the receiver, the activity). */
    fun stop(context: Context, callId: String?, reason: String) {
      val intent = Intent(context, IncomingCallService::class.java).apply {
        action = ACTION_STOP
        putExtra(EXTRA_CALL_ID, callId)
        putExtra(EXTRA_REASON, reason)
      }
      try { context.startService(intent) } catch (_: Exception) {}
    }

    /**
     * A high-priority data message that produces no visible notification
     * costs FCM quota; a stale call posts a silent, immediately-cancelled
     * notification so the account stays in good standing.
     */
    fun postAndCancelExpired(context: Context, callId: String) {
      ensureChannel(context)
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val notification = NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.sym_call_missed)
        .setContentTitle("Missed call")
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setSilent(true)
        .build()
      manager.notify(NOTIFICATION_ID + 1, notification)
      manager.cancel(NOTIFICATION_ID + 1)
      RingStore(context).forgetTimeline(callId)
    }

    fun payload(callId: String, callerId: String, callerName: String, mode: String): JSONObject =
      JSONObject().put("callId", callId).put("callerAccountId", callerId).put("callerName", callerName).put("mode", mode)
  }
}
