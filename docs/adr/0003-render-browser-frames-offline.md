# Render browser frames offline

Production rendering will drive pinned Chromium through explicit frame seeks, capture each frame, and encode frames and timeline audio with FFmpeg instead of recording real-time browser playback. This accepts slower sequential rendering in exchange for frame accuracy under load, reproducible visual state, and parity between preview and production composition behavior.

ADR 0005 makes this offline capture loop optionally parallel while preserving ordered, frame-accurate encoding; sequential rendering remains the default.
