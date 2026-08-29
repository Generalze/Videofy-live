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
 *   reportCallEnded(callId)               MANDATORY on every exit: stops the ring if still ringing
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
    Events("incoming", "answer", "decline", "timeout")

    OnCreate {
      instance = this@VideofyCallModule
      IncomingCallService.ensureChannel(context())
    }
    OnDestroy { if (instance === this@VideofyCallModule) instance = null }

    Function("setRingCredential") { gatewayUrl: String, token: String ->
      RingStore(context()).setCredential(gatewayUrl, token)
    }
    Function("clearRingCredential") { RingStore(context()).clearCredential() }

    Function("consumePendingAction") {
      RingStore(context()).consumePendingAction()?.let { toBundle(it) }
    }

    Function("reportCallEnded") { callId: String ->
      IncomingCallService.stop(context(), callId, "ended-by-app")
    }
    Function("reportMediaConnected") { callId: String ->
      RingStore(context()).mark(callId, "t11_media_connected")
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
  }
}
