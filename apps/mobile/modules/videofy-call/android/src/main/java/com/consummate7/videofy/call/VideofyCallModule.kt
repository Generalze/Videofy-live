package com.consummate7.videofy.call

import android.content.Context
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationManagerCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

/**
 * The JS face of the native call layer.
 *
 * Functions:
 *   setRingCredential(gatewayUrl, token)  on sign-in; the receiver's key to the gateway
 *   clearRingCredential()                 on sign-out / expiry / revocation / 401
 *   consumePendingAction()                cold start: {action, callId, callerAccountId, callerName, mode} | null
 *   reportAnswered(callId)                the app's own Answer: ring stops, Telecom connection stays
 *   reportCallEnded(callId)               MANDATORY on every exit: stops the ring if still ringing, ends Telecom
 *   reportMediaConnected(callId)          T11: two-way audio proven
 *   timeline(callId)                      the device's T4..T11 stamps, then forgotten
 *   canUseFullScreenIntent()              Android 14+: the permission a person can revoke
 *
 * Events: 'incoming' (the native ring is up; the app may show its own
 * surface but must not ack again), 'answer', 'decline', 'timeout'.
 */
class VideofyCallModule : Module() {

  override fun definition() = ModuleDefinition {
    Name("VideofyCall")
    Events("incoming", "answer", "decline", "timeout", "audioRoute")

    OnCreate {
      instance = this@VideofyCallModule
      IncomingCallService.ensureChannel(context())
    }
    OnDestroy { if (instance === this@VideofyCallModule) instance = null }

    // Bound to the account and the session's expiry; see RingStore.
    Function("setRingCredential") { gatewayUrl: String, token: String, accountId: String, expiresAtMs: Double ->
      RingStore(context()).setCredential(gatewayUrl, token, accountId, expiresAtMs.toLong())
    }
    /*
     * SIGN-OUT, NATIVELY: the credential, any parked Answer, the ring
     * notification and the foreground service all go at once. A phone
     * nobody is signed in to has nothing that can ring.
     */
    Function("clearRingCredential") {
      RingStore(context()).clearAll()
      IncomingCallService.stop(context(), null, "signed-out")
      TelecomBridge.endAll()
    }

    Function("consumePendingAction") { accountId: String ->
      RingStore(context()).consumePendingAction(accountId)?.let { toBundle(it) }
    }

    /**
     * The app answered on its own screen: the ring stops, the Telecom
     * connection goes ACTIVE and stays -- it is the call now, not the ring.
     * (reportCallEnded here would have ended Telecom's ownership at answer.)
     */
    Function("reportAnswered") { callId: String ->
      IncomingCallService.stop(context(), callId, "answered")
      TelecomBridge.markActive(callId)
    }
    Function("reportCallEnded") { callId: String ->
      IncomingCallService.stop(context(), callId, "ended-by-app")
      // MANDATORY for Telecom: an un-ended Connection blocks every later call.
      TelecomBridge.end(callId)
    }
    Function("reportMediaConnected") { callId: String ->
      RingStore(context()).mark(callId, "t11_media_connected")
      TelecomBridge.markActive(callId)
    }
    /** The caller's side: let Telecom own the outgoing call too (audio focus, routing). */
    Function("reportOutgoingCall") { callId: String, peerName: String ->
      TelecomBridge.placeOutgoing(context(), callId, peerName)
    }
    /** Speaker / earpiece through the Connection while Telecom owns the call; false = not owned, use the app's own route. */
    Function("setAudioRoute") { callId: String, speaker: Boolean ->
      TelecomBridge.route(callId, speaker)
    }
    Function("timeline") { callId: String ->
      val store = RingStore(context())
      val out = toBundle(store.timeline(callId))
      store.forgetTimeline(callId)
      out
    }
    Function("canUseFullScreenIntent") {
      if (Build.VERSION.SDK_INT >= 34) NotificationManagerCompat.from(context()).canUseFullScreenIntent() else true
    }
  }

  private fun context(): Context = appContext.reactContext ?: throw IllegalStateException("no context")

  private fun emit(name: String, payload: Bundle) {
    try { sendEvent(name, payload) } catch (_: Exception) {}
  }

  companion object {
    @Volatile private var instance: VideofyCallModule? = null

    private fun toBundle(json: JSONObject): Bundle {
      val bundle = Bundle()
      for (key in json.keys()) {
        when (val value = json.get(key)) {
          is Long -> bundle.putLong(key, value)
          is Int -> bundle.putLong(key, value.toLong())
          is Boolean -> bundle.putBoolean(key, value)
          else -> bundle.putString(key, value.toString())
        }
      }
      return bundle
    }

    private fun callBundle(callId: String, callerId: String, callerName: String, mode: String): Bundle =
      Bundle().apply {
        putString("callId", callId)
        putString("callerAccountId", callerId)
        putString("callerName", callerName)
        putString("mode", mode)
      }

    fun emitIncoming(callId: String, callerId: String, callerName: String, mode: String) {
      instance?.emit("incoming", callBundle(callId, callerId, callerName, mode))
    }
    fun emitAnswer(callId: String, callerId: String, callerName: String, mode: String) {
      instance?.emit("answer", callBundle(callId, callerId, callerName, mode))
    }
    fun emitDecline(callId: String) {
      instance?.emit("decline", Bundle().apply { putString("callId", callId) })
    }
    fun emitTimeout(callId: String) {
      instance?.emit("timeout", Bundle().apply { putString("callId", callId) })
    }
    fun emitAudioRoute(callId: String, route: String) {
      instance?.emit("audioRoute", Bundle().apply { putString("callId", callId); putString("route", route) })
    }
  }
}
