package com.consummate7.videofy.call

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONObject

/**
 * What the native layer is allowed to remember -- and for whom.
 *
 * THE RING CREDENTIAL IS BOUND TO AN ACCOUNT AND AN EXPIRY. It lets the
 * receiver ask the gateway "should I ring?" when no JS exists. It is written
 * on sign-in with the account id and the session's expiry, read back only
 * while unexpired, and cleared on sign-out, expiry, revocation and any 401.
 *
 * THE PENDING ACTION IS BOUND THE SAME WAY. An Answer parked for a cold app
 * carries the account it was for and when it was parked; it is consumed only
 * by that account, only within a minute, and it is cleared with the
 * credential. Before this a stale lock-screen Answer could survive a
 * sign-out and be consumed after a later sign-in -- an old call turning
 * into a phantom one (founder review, 29 Aug).
 *
 * THE TIMELINE: T4..T11 device stamps for one call. Ids and times only.
 */
class RingStore(context: Context) {
  private val prefs = EncryptedSharedPreferences.create(
    context,
    "videofy_ring",
    MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
  )

  data class Credential(val gatewayUrl: String, val token: String, val accountId: String)

  fun setCredential(gatewayUrl: String, token: String, accountId: String, expiresAtMs: Long) {
    prefs.edit()
      .putString(KEY_GATEWAY, gatewayUrl.trimEnd('/'))
      .putString(KEY_TOKEN, token)
      .putString(KEY_ACCOUNT, accountId)
      .putLong(KEY_EXPIRES, expiresAtMs)
      .apply()
  }

  /** Everything the native layer holds for a person: credential AND parked actions. */
  fun clearAll() {
    prefs.edit().remove(KEY_GATEWAY).remove(KEY_TOKEN).remove(KEY_ACCOUNT).remove(KEY_EXPIRES).remove(KEY_PENDING).apply()
  }

  /** The credential, or null when absent or past its expiry (which also clears it). */
  fun credential(nowMs: Long = System.currentTimeMillis()): Credential? {
    val gateway = prefs.getString(KEY_GATEWAY, null) ?: return null
    val token = prefs.getString(KEY_TOKEN, null) ?: return null
    val account = prefs.getString(KEY_ACCOUNT, null) ?: return null
    val expires = prefs.getLong(KEY_EXPIRES, 0L)
    if (expires > 0 && nowMs >= expires) {
      clearAll()
      return null
    }
    return Credential(gateway, token, account)
  }

  fun accountId(): String? = prefs.getString(KEY_ACCOUNT, null)

  fun setPendingAction(action: JSONObject?) {
    val editor = prefs.edit()
    if (action == null) {
      editor.remove(KEY_PENDING)
    } else {
      action.put("accountId", accountId() ?: "")
      action.put("parkedAtMs", System.currentTimeMillis())
      editor.putString(KEY_PENDING, action.toString())
    }
    editor.apply()
  }

  /**
   * Read-and-clear, for THIS account and only while fresh. Anything else is
   * discarded: a stale Answer must never become another call.
   */
  fun consumePendingAction(forAccountId: String, nowMs: Long = System.currentTimeMillis()): JSONObject? {
    val raw = prefs.getString(KEY_PENDING, null) ?: return null
    prefs.edit().remove(KEY_PENDING).apply()
    val json = try { JSONObject(raw) } catch (_: Exception) { return null }
    if (json.optString("accountId") != forAccountId) return null
    if (nowMs - json.optLong("parkedAtMs", 0L) > PENDING_TTL_MS) return null
    return json
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
    private const val KEY_ACCOUNT = "account"
    private const val KEY_EXPIRES = "expires"
    private const val KEY_PENDING = "pending"
    private const val PENDING_TTL_MS = 60_000L
  }
}
