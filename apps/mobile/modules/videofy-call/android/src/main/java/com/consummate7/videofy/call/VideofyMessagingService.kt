package com.consummate7.videofy.call

import android.content.Intent
import android.os.Build
import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * The first thing a push meets on the phone.
 *
 * THIS SERVICE OUTRANKS expo-notifications' (intent-filter priority 1 vs
 * -1), so Firebase delivers EVERY message here. A call (data.kind == "call")
 * is handled natively: it is data-only, there is nothing to draw, and it
 * goes to IncomingCallService, a phone-call foreground service that
 * validates the call with the gateway and rings. Everything else -- chat
 * pushes, token rotation, deleted-message signals -- is handed to
 * expo-notifications' own delegate so those behave exactly as before.
 *
 * THE HAND-OFF IS BY REFLECTION, because an autolinked module cannot depend
 * on the expo-notifications Gradle project (the first build failed exactly
 * there), and a compile-time class reference would need that. The delegate's
 * class name and constructor are stable across the SDK 57 line; if it is
 * ever missing the failure is logged, never thrown into Firebase.
 *
 * Runs in every app state, foreground included. T4 is stamped here: the
 * moment the push arrived on the device.
 */
class VideofyMessagingService : FirebaseMessagingService() {

  private val expoDelegate: Any? by lazy {
    try {
      val cls = Class.forName("expo.modules.notifications.service.delegates.FirebaseMessagingDelegate")
      cls.getConstructor(android.content.Context::class.java).newInstance(this)
    } catch (error: Throwable) {
      Log.w(TAG, "expo-notifications delegate unavailable: ${error.javaClass.simpleName}")
      null
    }
  }

  private fun forward(method: String, argType: Class<*>, arg: Any) {
    val delegate = expoDelegate ?: return
    try {
      delegate.javaClass.getMethod(method, argType).invoke(delegate, arg)
    } catch (error: Throwable) {
      Log.w(TAG, "expo-notifications $method failed: ${error.javaClass.simpleName}")
    }
  }

  override fun onNewToken(token: String) {
    forward("onNewToken", String::class.java, token)
  }

  override fun onDeletedMessages() {
    val delegate = expoDelegate ?: return
    try {
      delegate.javaClass.getMethod("onDeletedMessages").invoke(delegate)
    } catch (_: Throwable) {}
  }

  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    val data = remoteMessage.data
    if (data["kind"] != "call") {
      forward("onMessageReceived", RemoteMessage::class.java, remoteMessage)
      return
    }
    val callId = data["callId"] ?: return
    val expiresAt = data["expiresAt"]?.toLongOrNull() ?: 0L
    val store = RingStore(this)
    store.mark(callId, "t4_push_received")
    /*
     * WHAT THE PHONE'S STANDING WAS WHEN THE PUSH ARRIVED. The absence of T4
     * is what proved the 27 Sep defect; these two stamps are what tells the
     * next one apart. A T4 that arrives late with the bucket at RARE or
     * RESTRICTED says "delivered, but rationed"; no T4 at all still says
     * "never delivered". Both travel to the gateway with the timeline as
     * plain numbers (the timing route keeps any numeric stamp), so a person
     * diagnosing a ringing complaint reads them from one log line.
     */
    val bucket = DeviceStandby.standbyBucket(this)
    val exempt = DeviceStandby.batteryExemption(this)
    store.note(callId, "t4_standby_bucket", bucket.toLong())
    store.note(callId, "t4_battery_exempt", DeviceStandby.batteryExemptionCode(exempt))
    Log.i(TAG, "call push arrived; standby bucket=$bucket batteryExemption=$exempt")
    if (expiresAt > 0 && System.currentTimeMillis() > expiresAt) {
      // Stale: the ringing window has already closed. Post-and-cancel keeps
      // the high-priority quota honest without ringing anybody. The stamps
      // STAY: "arrived after its window" is a diagnosis, and the next
      // foreground reports it (src/push/unreportedTimelines.ts).
      Log.i(TAG, "call push expired before arrival")
      store.notRung(callId, NOT_RUNG_EXPIRED)
      IncomingCallService.postAndCancelExpired(this, callId)
      return
    }
    val intent = Intent(this, IncomingCallService::class.java).apply {
      action = IncomingCallService.ACTION_RING
      putExtra(IncomingCallService.EXTRA_CALL_ID, callId)
      putExtra(IncomingCallService.EXTRA_CALLER_ID, data["fromAccountId"] ?: "")
      putExtra(IncomingCallService.EXTRA_CALLER_NAME, data["fromName"] ?: "Caller")
      putExtra(IncomingCallService.EXTRA_MODE, data["mode"] ?: "normal")
      putExtra(IncomingCallService.EXTRA_EXPIRES_AT, expiresAt)
    }
    /*
     * ANDROID MAY REFUSE THE START. From Android 12 a background app in a
     * restricted bucket can be refused a foreground service
     * (ForegroundServiceStartNotAllowedException), and that is precisely a
     * push that arrived and rang nobody. It used to throw out of Firebase's
     * callback and leave no trace; now it is stamped with its reason and the
     * next foreground carries the evidence to the gateway.
     */
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent) else startService(intent)
    } catch (error: Exception) {
      Log.w(TAG, "the ring service could not be started: ${error.javaClass.simpleName}")
      store.notRung(callId, NOT_RUNG_SERVICE_REFUSED)
    }
  }

  companion object {
    private const val TAG = "VideofyCall"
    /** RingStore.notRung reason codes stamped here; the table lives on RingStore.notRung. */
    private const val NOT_RUNG_EXPIRED = 6L
    private const val NOT_RUNG_SERVICE_REFUSED = 7L
  }
}
