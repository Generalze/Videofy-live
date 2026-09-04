package com.consummate7.videofy.call

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The full-screen incoming call, on a locked or dark phone.
 *
 * Deliberately native and deliberately plain: it exists for the seconds
 * before the person answers, on top of the lock screen, with no JS running.
 * Same ground and words as the app's own screen (navy, the caller's name,
 * "is calling you on C7", the mode), two buttons. Answer and Decline go
 * through CallActionReceiver, exactly like the notification's buttons.
 */
class IncomingCallActivity : Activity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    showOverLockScreen()
    val callId = intent.getStringExtra(IncomingCallService.EXTRA_CALL_ID) ?: return finish()
    val callerId = intent.getStringExtra(IncomingCallService.EXTRA_CALLER_ID) ?: ""
    val callerName = intent.getStringExtra(IncomingCallService.EXTRA_CALLER_NAME) ?: "Caller"
    val mode = intent.getStringExtra(IncomingCallService.EXTRA_MODE) ?: "normal"

    val density = resources.displayMetrics.density
    fun dp(value: Int) = (value * density).toInt()

    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_HORIZONTAL
      setBackgroundColor(Color.parseColor("#070b12"))
      setPadding(dp(28), dp(120), dp(28), dp(60))
    }
    root.addView(TextView(this).apply {
      text = "C7"
      setTextColor(Color.parseColor("#3ec9c0"))
      textSize = 18f
      typeface = Typeface.DEFAULT_BOLD
      letterSpacing = 0.2f
    })
    root.addView(TextView(this).apply {
      text = callerName
      setTextColor(Color.parseColor("#eef3f7"))
      textSize = 34f
      typeface = Typeface.SERIF
      gravity = Gravity.CENTER
      setPadding(0, dp(48), 0, dp(6))
    })
    root.addView(TextView(this).apply {
      text = if (mode == "translated") "is calling you on C7 · translated call" else "is calling you on C7"
      setTextColor(Color.parseColor("#8d99a6"))
      textSize = 16f
      gravity = Gravity.CENTER
    })
    root.addView(View(this), LinearLayout.LayoutParams(0, 0, 1f))
    val buttons = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER
    }
    fun roundButton(label: String, color: String, onClick: () -> Unit): LinearLayout {
      val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setPadding(dp(24), 0, dp(24), 0) }
      column.addView(Button(this).apply {
        text = if (label == "Answer") "☎" else "✕"
        textSize = 26f
        setTextColor(Color.WHITE)
        background = android.graphics.drawable.GradientDrawable().apply {
          shape = android.graphics.drawable.GradientDrawable.OVAL
          setColor(Color.parseColor(color))
        }
        layoutParams = LinearLayout.LayoutParams(dp(76), dp(76))
        setOnClickListener { onClick() }
      })
      column.addView(TextView(this).apply {
        text = label
        setTextColor(Color.parseColor("#8d99a6"))
        textSize = 13f
        setPadding(0, dp(10), 0, 0)
      })
      return column
    }
    buttons.addView(roundButton("Decline", "#e0453a") {
      CallActionReceiver.decline(this, callId)
      finish()
    })
    buttons.addView(roundButton("Answer", "#22a06b") {
      CallActionReceiver.answer(this, callId, callerId, callerName, mode)
      finish()
    })
    root.addView(buttons)
    setContentView(root)
  }

  private fun showOverLockScreen() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
      (getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager)?.requestDismissKeyguard(this, null)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
          WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
          WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
      )
    }
  }

  companion object {
    fun intent(context: Context, callId: String, callerId: String, callerName: String, mode: String): Intent =
      Intent(context, IncomingCallActivity::class.java).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        putExtra(IncomingCallService.EXTRA_CALL_ID, callId)
        putExtra(IncomingCallService.EXTRA_CALLER_ID, callerId)
        putExtra(IncomingCallService.EXTRA_CALLER_NAME, callerName)
        putExtra(IncomingCallService.EXTRA_MODE, mode)
      }
  }
}
