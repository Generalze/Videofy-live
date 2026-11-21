package com.consummate7.videofy.call

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Base64
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicLong

/**
 * Translated speech, coming out of the phone.
 *
 * WHY THIS EXISTS. The gateway emits translated audio as PCM16, 16 kHz, mono,
 * in ~20 ms frames, while the sentence is still being synthesised -- 305 frames
 * over a 55-second call, measured in production on 19 Sep 2026. There is no
 * file and no URL, so nothing in expo-audio can play it: its player takes a
 * source. AudioTrack in MODE_STREAM takes samples, which is what we have.
 *
 * MODE_STREAM IS A QUEUE, and that is the whole reason it was chosen over
 * anything that schedules. What is written plays immediately after what was
 * written before it, with no gap, for as long as the queue does not run dry.
 * The browser's sink has to rebuild that property by scheduling each frame at
 * the exact time the previous one ends; here it is the platform's default and
 * cannot drift.
 *
 * NOTHING IS WRITTEN ON THE JS THREAD. AudioTrack.write blocks until the buffer
 * can take the data -- by design, that is how it applies back-pressure at
 * realtime -- so a write from the JS thread would stall the whole app for up to
 * a buffer's worth of audio, every frame. Frames are handed to a queue and a
 * daemon thread does the blocking write.
 *
 * VOICE_COMMUNICATION, not MEDIA. Translated speech is the call: it must follow
 * the earpiece/loudspeaker route the call already sets (see
 * src/call/audioRoute.ts) and share the call's audio focus rather than
 * competing with it for a separate stream.
 */
object TranslatedAudioTrack {

  private const val CHANNEL = AudioFormat.CHANNEL_OUT_MONO
  private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
  private const val BYTES_PER_FRAME = 2

  /**
   * The jitter cushion, in milliseconds of audio.
   *
   * Frames arrive from a socket, not from a clock, so they come in bursts and
   * pauses. Too small and the queue runs dry between bursts, which is heard as
   * a stutter; too large and every sentence starts late. 250 ms is roughly a
   * dozen frames and is a STARTING POINT, not a measured optimum -- it has
   * never been listened to on a handset. Tuning it must never require touching
   * anything else, which is why it is one named constant.
   */
  private const val BUFFER_MS = 250

  /**
   * Past this the phone is not jittering, it is behind.
   *
   * A queue seconds deep means every later frame is later still, and the reply
   * a person is waiting to hear arrives after they have already spoken again.
   * Refusing the write says so to the JS side instead of silently growing.
   */
  private const val MAX_QUEUED_MS = 4000

  private class Chunk(val generation: Int, val bytes: ByteArray)

  private class Output(val track: AudioTrack, val sampleRate: Int) {
    /** Its OWN queue and thread, so a re-open can never feed a released track. */
    val pending = LinkedBlockingQueue<Chunk>()
    val enqueuedFrames = AtomicLong(0)
    @Volatile var generation = 0
    @Volatile var running = true
    var writer: Thread? = null
  }

  @Volatile private var current: Output? = null

  /** True when this device accepted an output. Idempotent for the same rate. */
  @Synchronized
  fun open(sampleRate: Int): Boolean {
    if (sampleRate <= 0) return false
    val existing = current
    if (existing != null && existing.sampleRate == sampleRate) return true
    close()

    val minBytes = AudioTrack.getMinBufferSize(sampleRate, CHANNEL, ENCODING)
    if (minBytes <= 0) return false
    val wanted = sampleRate * BYTES_PER_FRAME * BUFFER_MS / 1000
    val built = try {
      AudioTrack.Builder()
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        )
        .setAudioFormat(
          AudioFormat.Builder()
            .setEncoding(ENCODING)
            .setSampleRate(sampleRate)
            .setChannelMask(CHANNEL)
            .build()
        )
        .setBufferSizeInBytes(maxOf(minBytes, wanted))
        .setTransferMode(AudioTrack.MODE_STREAM)
        .build()
    } catch (error: Exception) {
      // An unsupported format or a device with no free output. Reported as
      // false so the JS side can SAY translated audio is unavailable rather
      // than play nothing and look like a translation that never arrived.
      return false
    }
    if (built.state != AudioTrack.STATE_INITIALIZED) {
      built.release()
      return false
    }

    val output = Output(built, sampleRate)
    // Started empty: AudioTrack in MODE_STREAM simply waits for data, and
    // starting here means the first frame is not also paying for a state
    // change.
    try {
      built.play()
    } catch (error: IllegalStateException) {
      built.release()
      return false
    }
    val writer = Thread({ pump(output) }, "videofy-translated-audio")
    writer.isDaemon = true
    output.writer = writer
    current = output
    writer.start()
    return true
  }

  /**
   * Queue one frame. Returns the bytes accepted, or -1 when refused.
   *
   * Refusal is never silent truncation: a half-written frame shifts every later
   * sample by a byte and the rest of the sentence decodes as noise rather than
   * as speech.
   */
  @Synchronized
  fun write(pcmBase64: String): Int {
    val output = current ?: return -1
    val bytes = try {
      Base64.decode(pcmBase64, Base64.DEFAULT)
    } catch (error: IllegalArgumentException) {
      return -1
    }
    if (bytes.isEmpty()) return 0
    if (bytes.size % BYTES_PER_FRAME != 0) return -1
    if (queuedMsOf(output) > MAX_QUEUED_MS) return -1
    output.enqueuedFrames.addAndGet((bytes.size / BYTES_PER_FRAME).toLong())
    output.pending.offer(Chunk(output.generation, bytes))
    return bytes.size
  }

  /**
   * Drop what has not been heard. Returns the milliseconds discarded.
   *
   * Only the unheard part is counted: audio already presented is in somebody's
   * ear and cannot be recalled, and reporting it as cancelled would claim a
   * control over sound that nothing has.
   *
   * ONE CHUNK MAY STILL LAND. The writer thread can be inside a blocking write
   * when this runs, and up to that chunk -- 20 ms -- can reach the track after
   * the flush. Holding a lock across the write would fix it and would also mean
   * this call blocks the JS thread for a buffer's worth of audio, which is a
   * worse trade for 20 ms.
   */
  @Synchronized
  fun flush(): Int {
    val output = current ?: return 0
    val discarded = queuedMsOf(output)
    output.generation += 1
    output.pending.clear()
    try {
      output.track.pause()
      // Documented to reset the playback head to zero, which is why the
      // enqueued counter is reset with it: the two are only meaningful as a
      // difference.
      output.track.flush()
      output.track.play()
    } catch (error: IllegalStateException) {
      return 0
    }
    output.enqueuedFrames.set(0)
    return discarded
  }

  /** Written and not yet presented, in milliseconds. */
  @Synchronized
  fun queuedMs(): Int {
    val output = current ?: return 0
    return queuedMsOf(output)
  }

  /** Release the track. Safe when never opened, and safe to call twice. */
  @Synchronized
  fun close() {
    val output = current ?: return
    current = null
    output.running = false
    output.generation += 1
    output.pending.clear()
    output.writer?.interrupt()
    output.writer = null
    try {
      output.track.pause()
      output.track.flush()
      output.track.stop()
    } catch (error: IllegalStateException) {
      // Never started, or already stopped. Release still has to happen.
    }
    output.track.release()
  }

  private fun queuedMsOf(output: Output): Int {
    // Unsigned: getPlaybackHeadPosition returns an Int that wraps, and at
    // 16 kHz that is 74 hours of one call. Read as signed it would go negative
    // and the queue would look empty forever.
    val head = output.track.playbackHeadPosition.toLong() and 0xffffffffL
    val queued = output.enqueuedFrames.get() - head
    if (queued <= 0) return 0
    return (queued * 1000 / output.sampleRate).toInt()
  }

  private fun pump(output: Output) {
    while (output.running) {
      val chunk = try {
        output.pending.take()
      } catch (error: InterruptedException) {
        return
      }
      // Queued before a flush, or before a close. The platform has moved on and
      // playing it would speak a sentence that was withdrawn.
      if (chunk.generation != output.generation) continue
      var offset = 0
      while (offset < chunk.bytes.size && output.running) {
        val written = try {
          output.track.write(chunk.bytes, offset, chunk.bytes.size - offset)
        } catch (error: IllegalStateException) {
          // The track was released underneath us. This thread's work is over.
          return
        }
        if (written <= 0) return
        offset += written
      }
    }
  }
}
