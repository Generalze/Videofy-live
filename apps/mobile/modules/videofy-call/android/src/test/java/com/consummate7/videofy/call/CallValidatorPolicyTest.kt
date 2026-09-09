package com.consummate7.videofy.call

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CallValidatorPolicyTest {
  @Test
  fun prePresentationValidationFitsInsideTheRingStartupBudget() {
    val policy = CallValidatorPolicy.PrePresentation

    assertEquals(1, policy.attempts)
    assertTrue(policy.connectTimeoutMs <= 1_000)
    assertTrue(policy.readTimeoutMs <= 1_000)
    assertTrue(policy.worstCaseBudgetMs < CallValidatorPolicy.PRE_PRESENTATION_DEADLINE_MS)
  }

  @Test
  fun postPresentationAckIsBoundedToo() {
    val policy = CallValidatorPolicy.PostPresentation

    assertEquals(1, policy.attempts)
    assertTrue(policy.worstCaseBudgetMs <= 2_000)
  }
}
