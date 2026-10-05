# Model assets

`npm install` attempts to download the MediaPipe Face Landmarker float16 version-1 task from Google's versioned model bucket. `npm run assets` retries and fails visibly on error. `npm run build` requires it.

The model is generated locally, git-ignored, and served at `/models/face_landmarker.task`. No frames are sent to the download host. The setup script prints a SHA-256 so your team can record and compare it; that is **not** an independently verified upstream checksum. Review model licensing and verify an upstream checksum before a production release.

Source: https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
Documentation: https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker
