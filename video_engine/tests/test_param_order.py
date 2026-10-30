"""
Regression test — LTX positional argument order.

This exists specifically to prevent reintroducing the old bug where
width/height were swapped or enhance_prompt/seed/randomize_seed were
placed in the wrong slots, and to lock in the linoyts/LTX-2-3-First-Last-Frame
Space's generate_video signature (which added first_image/last_image/
input_audio ahead of the original single-image contract).

Correct order (verified against the live Space's generate_btn.click()
wiring — fn=generate_video):
    0 first_image
    1 last_image
    2 input_audio
    3 prompt
    4 duration
    5 enhance_prompt
    6 seed
    7 randomize_seed
    8 height
    9 width
"""
from pathlib import Path

from video_engine.providers.ltx import build_predict_args, _resolve_frames


def test_ltx_positional_argument_order(tmp_path):
    first_frame_url = "https://example.com/predecessor_end_frame.jpg"
    last_frame_url = "https://example.com/current_still.jpg"

    args = build_predict_args(
        first_frame_url,  # first_image
        last_frame_url,  # last_image
        "cinematic push in",  # prompt
        8.0,  # duration
        False,  # enhance_prompt
        123456,  # seed
        False,  # randomize_seed
        1536,  # height
        1024,  # width
    )

    assert len(args) == 10

    # args[0]/args[1] are handle_file(...) FileData wrappers for the image URLs.
    assert args[2] is None  # input_audio — unused by StreamVerse
    assert args[3] == "cinematic push in"
    assert args[4] == 8.0
    assert args[5] is False  # enhance_prompt
    assert args[6] == 123456  # seed
    assert args[7] is False  # randomize_seed
    assert args[8] == 1536  # height
    assert args[9] == 1024  # width

    # Explicitly guard against the previously-reported wrong order:
    # ..., WIDTH, HEIGHT instead of HEIGHT, WIDTH
    wrong_order_would_have = (args[8], args[9]) == (1024, 1536)
    assert not wrong_order_would_have, "height/width appear swapped — regression!"


def test_ltx_single_image_mode_has_no_last_frame():
    args = build_predict_args(
        "https://example.com/only_frame.jpg",
        None,
        "cinematic push in",
        8.0,
        False,
        123456,
        False,
        1536,
        1024,
    )
    assert args[1] is None  # last_image absent in single-image mode


def test_resolve_frames_uses_ordered_continuity_pair():
    # len >= 2: refs[0] is the predecessor's terminal frame (first_image),
    # refs[-1] is the freshly rendered current-shot still (last_image).
    first_url, last_url = _resolve_frames(
        "https://example.com/ignored_when_refs_present.jpg",
        ["https://example.com/predecessor_end_frame.jpg", "https://example.com/current_still.jpg"],
    )
    assert first_url == "https://example.com/predecessor_end_frame.jpg"
    assert last_url == "https://example.com/current_still.jpg"


def test_resolve_frames_falls_back_to_single_image():
    first_url, last_url = _resolve_frames("https://example.com/only_frame.jpg", None)
    assert first_url == "https://example.com/only_frame.jpg"
    assert last_url is None
