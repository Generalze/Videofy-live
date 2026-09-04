package com.consummate7.videofy.call

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.telecom.CallAudioState
import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.util.Log

/**
 * Telecom, phase 2: a C7 call IS a call to Android.
 *
 * SELF-MANAGED. Videofy keeps its own screens (Telecom does not draw a UI
 * for self-managed apps); what Telecom gives in return is the call
 * lifecycle the OS understands -- audio focus and routing (the Speaker
 * control goes through the Connection, because Telecom overrides
 * AudioManager while it owns a call), "another call is ringing" busy logic,
 * Bluetooth and car integrations, and the guarantee that a killed process
 * takes its Connection with it.
 *
 * EVERY CONNECTION ENDS. A self-managed Connection that is never
 * disconnected and destroyed makes isIncomingCallPermitted() false for
 * every later call -- the phone would refuse to ring forever. So the app
 * MUST call reportCallEnded on every exit, and a watchdog ends a ringing
 * Connection that nobody answered within the ring window regardless.
 *
 * FALLBACK, NEVER FAILURE. If the phone account cannot be registered or
 * Telecom refuses the call (SecurityException, permission revoked, OEM
 * quirk), the phase-1 path -- CallStyle notification + full-screen
 * activity -- rings exactly as before. Telecom is an upgrade, not a gate.
 */
class VideofyConnectionService : ConnectionService() {

  override fun onCreateIncomingConnection(from: PhoneAccountHandle?, request: ConnectionRequest?): Connection {
    val extras = request?.extras ?: Bundle()
    val callId = extras.getString(IncomingCallService.EXTRA_CALL_ID) ?: return failed("no call id")
    val callerName = extras.getString(IncomingCallService.EXTRA_CALLER_NAME) ?: "Caller"
    val callerId = extras.getString(IncomingCallService.EXTRA_CALLER_ID) ?: ""
    val mode = extras.getString(IncomingCallService.EXTRA_MODE) ?: "normal"
    val connection = VideofyConnection(applicationContext, callId, callerId, callerName, mode, incoming = true)
    connection.setRinging()
    TelecomBridge.register(callId, connection)
    return connection
  }

  override fun onCreateOutgoingConnection(from: PhoneAccountHandle?, request: ConnectionRequest?): Connection {
    val extras = request?.extras ?: Bundle()
    val callId = extras.getString(IncomingCallService.EXTRA_CALL_ID) ?: return failed("no call id")
    val peerName = extras.getString(IncomingCallService.EXTRA_CALLER_NAME) ?: "Call"
    val connection = VideofyConnection(applicationContext, callId, "", peerName, "normal", incoming = false)
    connection.setDialing()
    TelecomBridge.register(callId, connection)
    return connection
  }

  override fun onCreateIncomingConnectionFailed(from: PhoneAccountHandle?, request: ConnectionRequest?) {
    val callId = request?.extras?.getString(IncomingCallService.EXTRA_CALL_ID)
    Log.w(TAG, "Telecom refused an incoming connection; falling back to the notification ring")
    if (callId != null) TelecomBridge.fallback(applicationContext, callId)
  }

  private fun failed(reason: String): Connection {
    Log.w(TAG, "connection request rejected: $reason")
    return Connection.createFailedConnection(DisconnectCause(DisconnectCause.ERROR, reason))
  }

  companion object {
    private const val TAG = "VideofyCall"
  }
}

/** One C7 call as Telecom sees it. */
class VideofyConnection(
  private val context: Context,
  val callId: String,
  private val callerId: String,
  private val displayName: String,
  private val mode: String,
  private val incoming: Boolean,
) : Connection() {
  private val handler = Handler(Looper.getMainLooper())
  @Volatile var ended = false
    private set

  init {
    connectionProperties = PROPERTY_SELF_MANAGED
    connectionCapabilities = CAPABILITY_MUTE or CAPABILITY_SUPPORT_HOLD
    audioModeIsVoip = true
    setCallerDisplayName(displayName, TelecomManager.PRESENTATION_ALLOWED)
    setAddress(Uri.fromParts("videofy", callerId.ifBlank { callId }, null), TelecomManager.PRESENTATION_ALLOWED)
    // The watchdog: a ring nobody answers ends here, whatever else happens.
    handler.postDelayed({ if (!ended && state == STATE_RINGING) end(DisconnectCause(DisconnectCause.MISSED)) }, WATCHDOG_MS)
  }

  /** Telecom asks the app to show its own incoming-call UI: the phase-1 ring, unchanged. */
  override fun onShowIncomingCallUi() {
    IncomingCallService.presentValidated(context, callId, callerId, displayName, mode)
  }

  override fun onAnswer() {
    setActive()
    CallActionReceiver.answer(context, callId, callerId, displayName, mode)
  }

  override fun onAnswer(videoState: Int) = onAnswer()

  override fun onReject() {
    CallActionReceiver.decline(context, callId)
    end(DisconnectCause(DisconnectCause.REJECTED))
  }

  override fun onDisconnect() {
    VideofyCallModule.emitDecline(callId)
    end(DisconnectCause(DisconnectCause.LOCAL))
  }

  override fun onAbort() {
    end(DisconnectCause(DisconnectCause.CANCELED))
  }

  override fun onCallAudioStateChanged(state: CallAudioState?) {
    // Reported for the diagnostics only; the app asks for routes through TelecomBridge.
    if (state != null) VideofyCallModule.emitAudioRoute(callId, routeName(state.route))
  }

  fun markActive() {
    if (!ended && state != STATE_ACTIVE) setActive()
  }

  fun route(speaker: Boolean): Boolean {
    if (ended) return false
    return try {
      setAudioRoute(if (speaker) CallAudioState.ROUTE_SPEAKER else CallAudioState.ROUTE_EARPIECE)
      true
    } catch (_: Exception) {
      false
    }
  }

  fun end(cause: DisconnectCause) {
    if (ended) return
    ended = true
    handler.removeCallbacksAndMessages(null)
    try {
      setDisconnected(cause)
    } catch (_: Exception) {}
    try {
      destroy()
    } catch (_: Exception) {}
    TelecomBridge.unregister(callId)
  }

  private fun routeName(route: Int): String = when (route) {
    CallAudioState.ROUTE_SPEAKER -> "speaker"
    CallAudioState.ROUTE_EARPIECE -> "earpiece"
    CallAudioState.ROUTE_BLUETOOTH -> "bluetooth"
    CallAudioState.ROUTE_WIRED_HEADSET -> "headset"
    else -> "unknown"
  }

  companion object {
    private const val WATCHDOG_MS = 75_000L
  }
}

/**
 * The one place that talks to TelecomManager. Registers the phone account
 * (re-registered on every use; some OEMs drop it on clear-data), offers
 * incoming calls, places outgoing ones, and hands routing and ending to the
 * live Connection. Every entry point answers false when Telecom is not
 * available, so callers fall back rather than fail.
 */
object TelecomBridge {
  private val connections = java.util.concurrent.ConcurrentHashMap<String, VideofyConnection>()
  private val pendingFallback = java.util.concurrent.ConcurrentHashMap<String, Array<String>>()

  fun handle(context: Context): PhoneAccountHandle =
    PhoneAccountHandle(ComponentName(context, VideofyConnectionService::class.java), "videofy")

  fun ensureAccount(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
    return try {
      val manager = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
      val account = PhoneAccount.builder(handle(context), "Videofy Live")
        .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
        .addSupportedUriScheme("videofy")
        .build()
      manager.registerPhoneAccount(account)
      true
    } catch (error: Exception) {
      Log.w("VideofyCall", "phone account registration failed: ${error.javaClass.simpleName}")
      false
    }
  }

  /** Offer a validated incoming call to Telecom. True = Telecom owns it and will ask for the UI. */
  fun offerIncoming(context: Context, callId: String, callerId: String, callerName: String, mode: String): Boolean {
    if (!ensureAccount(context)) return false
    return try {
      val manager = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
      val handle = handle(context)
      if (!manager.isIncomingCallPermitted(handle)) return false
      pendingFallback[callId] = arrayOf(callerId, callerName, mode)
      val extras = Bundle().apply {
        putString(IncomingCallService.EXTRA_CALL_ID, callId)
        putString(IncomingCallService.EXTRA_CALLER_ID, callerId)
        putString(IncomingCallService.EXTRA_CALLER_NAME, callerName)
        putString(IncomingCallService.EXTRA_MODE, mode)
      }
      manager.addNewIncomingCall(handle, extras)
      true
    } catch (error: Exception) {
      Log.w("VideofyCall", "Telecom refused the incoming call: ${error.javaClass.simpleName}")
      pendingFallback.remove(callId)
      false
    }
  }

  /** Tell Telecom this phone is placing a call, so audio focus and routing are owned properly. */
  fun placeOutgoing(context: Context, callId: String, peerName: String): Boolean {
    if (!ensureAccount(context)) return false
    return try {
      val manager = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
      val handle = handle(context)
      if (!manager.isOutgoingCallPermitted(handle)) return false
      val extras = Bundle().apply {
        putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
        putBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS, Bundle().apply {
          putString(IncomingCallService.EXTRA_CALL_ID, callId)
          putString(IncomingCallService.EXTRA_CALLER_NAME, peerName)
        })
      }
      manager.placeCall(Uri.fromParts("videofy", callId, null), extras)
      true
    } catch (error: Exception) {
      Log.w("VideofyCall", "Telecom refused the outgoing call: ${error.javaClass.simpleName}")
      false
    }
  }

  fun register(callId: String, connection: VideofyConnection) {
    connections[callId] = connection
    pendingFallback.remove(callId)
  }

  fun unregister(callId: String) {
    connections.remove(callId)
  }

  fun fallback(context: Context, callId: String) {
    val info = pendingFallback.remove(callId) ?: return
    IncomingCallService.presentValidated(context, callId, info[0], info[1], info[2])
  }

  fun has(callId: String): Boolean = connections.containsKey(callId)

  fun markActive(callId: String) {
    connections[callId]?.markActive()
  }

  fun route(callId: String, speaker: Boolean): Boolean = connections[callId]?.route(speaker) ?: false

  fun end(callId: String, missed: Boolean = false) {
    connections[callId]?.end(DisconnectCause(if (missed) DisconnectCause.MISSED else DisconnectCause.LOCAL))
  }

  fun endAll() {
    for (connection in connections.values.toList()) connection.end(DisconnectCause(DisconnectCause.LOCAL))
  }
}
