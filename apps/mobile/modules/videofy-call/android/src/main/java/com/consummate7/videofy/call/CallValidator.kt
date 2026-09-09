package com.consummate7.videofy.call

import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

data class CallValidatorRequestPolicy(
  val connectTimeoutMs: Int,
  val readTimeoutMs: Int,
  val attempts: Int,
) {
  init {
    require(connectTimeoutMs > 0)
    require(readTimeoutMs > 0)
    require(attempts > 0)
  }

  val worstCaseBudgetMs: Int
    get() = (connectTimeoutMs + readTimeoutMs) * attempts
}

object CallValidatorPolicy {
  const val PRE_PRESENTATION_DEADLINE_MS = 2_500

  val PrePresentation = CallValidatorRequestPolicy(
    connectTimeoutMs = 1_000,
    readTimeoutMs = 1_000,
    attempts = 1,
  )

  val PostPresentation = CallValidatorRequestPolicy(
    connectTimeoutMs = 1_000,
    readTimeoutMs = 1_000,
    attempts = 1,
  )
}

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
 * The pre-presentation read is short and single-shot: every second here is a
 * second the person does not hear the phone. Once the phone is already ringing,
 * acknowledgements and actions use the same bounded request policy but failure
 * only tears down the current native ring.
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
    val body =
      request("GET", "/calls/direct/${encode(callId)}", CallValidatorPolicy.PrePresentation)
        ?: return null
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
    request("POST", "/calls/direct/${encode(callId)}/ringing", CallValidatorPolicy.PostPresentation)
      ?.second
      ?.optBoolean("live", false)
      ?: false

  /** The person tapped Answer: the gateway holds the ringing window open while the app comes up. */
  fun answering(callId: String): Boolean =
    request("POST", "/calls/direct/${encode(callId)}/answering", CallValidatorPolicy.PostPresentation)
      ?.second
      ?.optBoolean("held", false)
      ?: false

  fun decline(callId: String): Boolean =
    request("POST", "/calls/direct/${encode(callId)}/decline", CallValidatorPolicy.PostPresentation)
      ?.second
      ?.optBoolean("declined", false)
      ?: false

  private fun encode(value: String): String = java.net.URLEncoder.encode(value, "UTF-8")

  /** (status, json) or null when the gateway could not be reached within the policy. */
  private fun request(
    method: String,
    path: String,
    policy: CallValidatorRequestPolicy,
  ): Pair<Int, JSONObject?>? {
    repeat(policy.attempts) { attempt ->
      var connection: HttpURLConnection? = null
      try {
        connection = (URL(gatewayUrl + path).openConnection() as HttpURLConnection).apply {
          requestMethod = method
          connectTimeout = policy.connectTimeoutMs
          readTimeout = policy.readTimeoutMs
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
        val json = try { if (text.isNotBlank()) JSONObject(text) else null } catch (_: Exception) { null }
        return Pair(status, json)
      } catch (_: Exception) {
        if (attempt == policy.attempts - 1) return null
      } finally {
        try {
          connection?.disconnect()
        } catch (_: Exception) {}
      }
    }
    return null
  }
}
