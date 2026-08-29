package com.consummate7.videofy.call

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONObject

/**
 * What the native layer is allowed to remember.
 *
 * THE RING CREDENTIAL. To ask the gateway "should I ring for this push?" the
 * receiver needs the account's session token, and it runs when no JS exists
 * (app killed, phone locked). The token therefore has a sanctioned second
 * holder: EncryptedSharedPreferences (Android Keystore-backed), written by
 * the app on sign-in, cleared on sign-out, expiry, revocation and any 401.
 * Same lifetime as the JS session, never logged, never exported.
 *
 * THE PENDING ACTION. When a person answers from the lock screen the app may
 * be cold; the answer is parked here and consumed by JS on start.
 *
 * THE TIMELINE. T4..T9 device timestamps for one call, so the app can report
 * where a ring's seconds were spent. Metadata only: ids and times.
 */
class RingStore(context: Context) {
  private val prefs = EncryptedSharedPreferences.create(
    context,
    "videofy_ring",
    MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
  )

  fun setCredential(gatewayUrl: String, token: String) {
    prefs.edit().putString(KEY_GATEWAY, gatewayUrl.trimEnd('/')).putString(KEY_TOKEN, token).apply()
  }

  fun clearCredential() {
    prefs.edit().remove(KEY_GATEWAY).remove(KEY_TOKEN).apply()
  }

  fun gatewayUrl(): String? = prefs.getString(KEY_GATEWAY, null)
  fun token(): String? = prefs.getString(KEY_TOKEN, null)

  fun setPendingAction(action: JSONObject?) {
    val editor = prefs.edit()
    if (action == null) editor.remove(KEY_PENDING) else editor.putString(KEY_PENDING, action.toString())
    editor.apply()
  }

  /** Read-and-clear. */
  fun consumePendingAction(): JSONObject? {
    val raw = prefs.getString(KEY_PENDING, null) ?: return null
    prefs.edit().remove(KEY_PENDING).apply()
    return try { JSONObject(raw) } catch (_: Exception) { null }
  }

  fun mark(callId: String, point: String, atMs: Long = System.currentTimeMillis()) {
    prefs.edit().putLong("t:$callId:$point", atMs).apply()
  }

  fun timeline(callId: String): JSONObject {
    val out = JSONObject()
    for ((key, value) in prefs.all) {
      if (key.startsWith("t:$callId:") && value is Long) out.put(key.removePrefix("t:$callId:"), value)
    }
    return out
  }

  fun forgetTimeline(callId: String) {
    val editor = prefs.edit()
    for (key in prefs.all.keys) if (key.startsWith("t:$callId:")) editor.remove(key)
    editor.apply()
  }

  companion object {
    private const val KEY_GATEWAY = "gateway"
    private const val KEY_TOKEN = "token"
    private const val KEY_PENDING = "pending"
  }
}
