export const QWEN_TTS_ENV = "FRAMEYARD_QWEN_TTS";
export const SHERPA_ONNX_TTS_ENV = "FRAMEYARD_SHERPA_ONNX_TTS";
export const WHISPER_CLI_ENV = "FRAMEYARD_WHISPER_CLI";

/**
 * The qwentts.cpp, sherpa-onnx, and whisper.cpp revisions whose CLI surfaces
 * these wrappers target. Real-model integration tests are opt-in and must name
 * the exact revision they exercise; doctor reports these values so generated
 * provenance is interpretable.
 */
export const QWEN_TTS_REFERENCE_REVISION = "5916bf7c79dbb4e66fc059cdc507a79a23a28bb4";
export const SHERPA_ONNX_REFERENCE_REVISION = "af2d8d81dbfa61c4cea4c568da78f3982edca005"; // v2.0.1
export const WHISPER_CPP_REFERENCE_REVISION = "284029c07012d2000941a08d38a31ffb71f4734e";

export const QWEN_TTS_COMMAND = "qwen-tts";
export const SHERPA_ONNX_TTS_COMMAND = "sherpa-onnx-offline-tts";
export const WHISPER_CLI_COMMAND = "whisper-cli";

export const QWEN_TTS_INSTALL_HINT = "Build qwentts.cpp and make its qwen-tts executable available on PATH.";
export const SHERPA_ONNX_TTS_INSTALL_HINT =
  "Install sherpa-onnx v2.0.1 and make its sherpa-onnx-offline-tts executable available on PATH.";
export const WHISPER_CLI_INSTALL_HINT = "Build whisper.cpp and make its whisper-cli executable available on PATH.";
