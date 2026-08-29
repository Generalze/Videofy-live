package com.consummate7.videofy.call

import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * The telephone's three questions, asked from native code.
 *
 *   should I ring for this push?   GET  /calls/direct/:callId
 *   I am ringing                   POST /calls/direct/:callId/ringing
 *   the person declined            POST /calls/direct/:callId/decline
 *
 * A push is only a wake-up (founder ruling 2026-08-28): the server decides
 * whether the call is still live. Every failure resolves to "do not ring"
 * or "no effect"; nothing here throws into a messaging service. Short
 * timeouts and one retry, because the ringing window is thirty seconds and
 * every second here is a second the person does not hear the phone.
 */
class CallValidator(private val gatewayUrl: String, private val token: String) {

  data class Verdict(
    val ring: Boolean,
    val state: String,
    val callerName: String,
    val callerAccountId: String,
    val mode: String,
    val unauthorized: Boolean,
  )

  fun check(callId: String): Verdict? {
    val body = request("GET", "/calls/direct/${encode(callId)}") ?: return null
    if (body.first == 401) return Verdict(false, "unauthorized", "", "", "normal", true)
    val json = body.second ?: return null
    return Verdict(
      ring = json.optBoolean("ring", false),
      state = json.optString("state", ""),
      callerName = json.optString("callerName", "Caller"),
      callerAccountId = json.optString("callerAccountId", ""),
      mode = if (json.optString("mode") == "translated") "translated" else "normal",
      unauthorized = false,
    )
  }

  fun ackRinging(callId: String): Boolean =
    request("POST", "/calls/direct/${encode(callId)}/ringing")?.second?.optBoolean("live", false) ?: false

  /** The person tapped Answer: the gateway holds the ringing window open while the app comes up. */
  fun answering(callId: String): Boolean =
    request("POST", "/calls/direct/${encode(callId)}/answering")?.second?.optBoolean("held", false) ?: false

  fun decline(callId: String): Boolean =
    request("POST", "/calls/direct/${encode(callId)}/decline")?.second?.optBoolean("declined", false) ?: false

  private fun encode(value: String): String = java.net.URLEncoder.encode(value, "UTF-8")

  /** (status, json) or null when the gateway could not be reached twice. */
  private fun request(method: String, path: String): Pair<Int, JSONObject?>? {
    repeat(2) { attempt ->
      try {
        val connection = (URL(gatewayUrl + path).openConnection() as HttpURLConnection).apply {
          requestMethod = method
          connectTimeout = 3000
          readTimeout = 3000
          setRequestProperty("Authorization", "Bearer $token")
          setRequestProperty("Accept", "application/json")
          if (method == "POST") {
            doOutput = true
            setRequestProperty("Content-Length", "0")
          }
        }
        val status = connection.responseCode
        val stream = if (status < 400) connection.inputStream else connection.errorStream
        val text = stream?.bufferedReader()?.use(BufferedReader::readText) ?: ""
        connection.disconnect()
        val json = try { if (text.isNotBlank()) JSONObject(text) else null } catch (_: Exception) { null }
        return Pair(status, json)
      } catch (_: Exception) {
        if (attempt == 1) return null
      }
    }
    return null
  }
}
