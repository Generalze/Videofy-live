package com.consummate7.videofy.call

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import java.util.concurrent.Executors

/**
 * Answer and Decline, from the notification or the full-screen activity.
 *
 * ANSWER parks the action for JS (the app may be cold), stops the ring, and
 * brings the app to the front with the call in its extras. DECLINE tells the
 * gateway (POST /decline, so the caller reads "Call declined" at once) and
 * stops the ring. Both stamp the timeline.
 */
class CallActionReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context, intent: Intent) {
    val callId = intent.getStringExtra(IncomingCallService.EXTRA_CALL_ID) ?: return
    val callerId = intent.getStringExtra(IncomingCallService.EXTRA_CALLER_ID) ?: ""
    val callerName = intent.getStringExtra(IncomingCallService.EXTRA_CALLER_NAME) ?: "Caller"
    val mode = intent.getStringExtra(IncomingCallService.EXTRA_MODE) ?: "normal"
    when (intent.action) {
      ACTION_ANSWER -> answer(context, callId, callerId, callerName, mode)
      ACTION_DECLINE -> decline(context, callId)
    }
  }

  companion object {
    const val ACTION_ANSWER = "com.consummate7.videofy.call.ANSWER"
    const val ACTION_DECLINE = "com.consummate7.videofy.call.DECLINE"
    private val executor = Executors.newSingleThreadExecutor()

    fun pendingIntent(context: Context, action: String, callId: String, callerId: String, callerName: String, mode: String, code: Int): PendingIntent {
      val intent = Intent(context, CallActionReceiver::class.java).apply {
        this.action = action
        putExtra(IncomingCallService.EXTRA_CALL_ID, callId)
        putExtra(IncomingCallService.EXTRA_CALLER_ID, callerId)
        putExtra(IncomingCallService.EXTRA_CALLER_NAME, callerName)
        putExtra(IncomingCallService.EXTRA_MODE, mode)
      }
      return PendingIntent.getBroadcast(context, code, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    fun answer(context: Context, callId: String, callerId: String, callerName: String, mode: String) {
      val store = RingStore(context)
      store.mark(callId, "t8_answer_tapped")
      val payload = IncomingCallService.payload(callId, callerId, callerName, mode).put("action", "answer")
      store.setPendingAction(payload)
      IncomingCallService.stop(context, callId, "answered")
      // Tell the gateway the person answered BEFORE the app is up: a cold
      // start must not land on a call already marked no-answer.
      val credential = store.credential()
      val gateway = credential?.gatewayUrl
      val token = credential?.token
      if (gateway != null && token != null) {
        executor.execute { CallValidator(gateway, token).answering(callId) }
      }
      // To the front, call in hand. JS consumes the pending action on start
      // (cold) or the 'answer' event (warm) -- both lead to the same seat.
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        putExtra("videofyCallAnswer", callId)
      }
      if (launch != null) context.startActivity(launch)
      VideofyCallModule.emitAnswer(callId, callerId, callerName, mode)
    }

    fun decline(context: Context, callId: String) {
      val store = RingStore(context)
      store.mark(callId, "t8_decline_tapped")
      IncomingCallService.stop(context, callId, "declined")
      val credential = store.credential()
      val gateway = credential?.gatewayUrl
      val token = credential?.token
      if (gateway != null && token != null) {
        executor.execute { CallValidator(gateway, token).decline(callId) }
      }
      VideofyCallModule.emitDecline(callId)
    }
  }
}
