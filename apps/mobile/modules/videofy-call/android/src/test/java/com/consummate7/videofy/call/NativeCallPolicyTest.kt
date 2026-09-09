package com.consummate7.videofy.call

import org.junit.Assert.assertEquals
import org.junit.Test

class NativeCallPolicyTest {
  @Test
  fun ringingDisconnectDeclinesTheCall() {
    assertEquals(
      NativeDisconnectAction.DECLINE,
      NativeCallPolicy.disconnectAction(NativeCallPhase.RINGING),
    )
  }

  @Test
  fun activeAndDialingDisconnectEndTheCall() {
    assertEquals(
      NativeDisconnectAction.END,
      NativeCallPolicy.disconnectAction(NativeCallPhase.ACTIVE),
    )
    assertEquals(
      NativeDisconnectAction.END,
      NativeCallPolicy.disconnectAction(NativeCallPhase.DIALING),
    )
  }

  @Test
  fun endedOrUnknownConnectionsDoNotEmitAnotherAction() {
    assertEquals(
      NativeDisconnectAction.IGNORE,
      NativeCallPolicy.disconnectAction(NativeCallPhase.ENDED),
    )
    assertEquals(
      NativeDisconnectAction.IGNORE,
      NativeCallPolicy.disconnectAction(NativeCallPhase.OTHER),
    )
  }
}
