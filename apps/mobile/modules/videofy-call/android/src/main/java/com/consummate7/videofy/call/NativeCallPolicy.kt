package com.consummate7.videofy.call

enum class NativeCallPhase {
  RINGING,
  DIALING,
  ACTIVE,
  ENDED,
  OTHER,
}

enum class NativeDisconnectAction {
  DECLINE,
  END,
  IGNORE,
}

object NativeCallPolicy {
  fun disconnectAction(phase: NativeCallPhase): NativeDisconnectAction =
    when (phase) {
      NativeCallPhase.RINGING -> NativeDisconnectAction.DECLINE
      NativeCallPhase.DIALING,
      NativeCallPhase.ACTIVE -> NativeDisconnectAction.END
      NativeCallPhase.ENDED,
      NativeCallPhase.OTHER -> NativeDisconnectAction.IGNORE
    }
}
