`one-two-three-four.wav` is synthetic speech generated locally with eSpeak NG's
`en-us` voice at 140 words/minute: "One. Two. Three. Four." It contains no user
recording. The browser integration test attenuates it before feeding the real
AudioWorklet and on-device Whisper worker.
