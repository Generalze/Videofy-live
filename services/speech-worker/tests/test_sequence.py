"""
Tests for event sequence ordering and monotonicity.
Ensures that a stream of mock phrases maintains strictly increasing sequence numbers
and that the video timestamp advances with each emission.
"""

from src.providers.mock import get_mock_phrase_pair
from src.translation_event import TranslationEvent


def make_events(count: int, start_sequence: int = 1) -> list[TranslationEvent]:
    """Simulate the sequence of events that MockWorker would produce."""
    events = []
    start_ms = 0
    for i in range(count):
        src, tgt = get_mock_phrase_pair(i)
        video_ts = start_ms + i * 4000
        event = TranslationEvent(
            event_id="demo-event",
            sequence=start_sequence + i,
            source_language="en",
            target_language="fr",
            source_text=src,
            translated_text=tgt,
            final=True,
            video_timestamp_ms=video_ts,
        )
        events.append(event)
    return events


class TestSequenceOrdering:
    def test_sequences_are_monotonically_increasing(self):
        events = make_events(10)
        sequences = [e.sequence for e in events]
        assert sequences == sorted(sequences)
        assert sequences == list(range(1, 11))

    def test_no_duplicate_sequences(self):
        events = make_events(20)
        sequences = [e.sequence for e in events]
        assert len(sequences) == len(set(sequences))

    def test_video_timestamps_are_non_decreasing(self):
        events = make_events(10)
        timestamps = [e.video_timestamp_ms for e in events]
        assert timestamps == sorted(timestamps)

    def test_all_events_are_final(self):
        events = make_events(5)
        assert all(e.final for e in events)

    def test_custom_start_sequence(self):
        events = make_events(5, start_sequence=100)
        assert events[0].sequence == 100
        assert events[-1].sequence == 104

    def test_event_dict_preserves_sequence(self):
        events = make_events(3)
        for event in events:
            d = event.to_dict()
            assert d["sequence"] == event.sequence
