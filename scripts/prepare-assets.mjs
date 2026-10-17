
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  cpSync,
  writeFileSync,
  renameSync,
  statSync,
  readFileSync
} from "node:fs";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dirname, "..");
const required = process.argv.includes("--required");

const model = resolve(
  root,
  "public/models/face_landmarker.task"
);

const url =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

// --------------------------------------------------
// MediaPipe Face Landmarker assets
// --------------------------------------------------

try {
  const require = createRequire(import.meta.url);

  const packageRoot = dirname(
    require.resolve("@mediapipe/tasks-vision")
  );

  const wasm = resolve(packageRoot, "wasm");

  if (!existsSync(wasm)) {
    throw new Error(
      "MediaPipe WASM directory not found. Re-run npm install without --ignore-scripts."
    );
  }

  mkdirSync(resolve(root, "public/mediapipe"), {
    recursive: true
  });

  cpSync(
    wasm,
    resolve(root, "public/mediapipe/wasm"),
    { recursive: true }
  );

  mkdirSync(dirname(model), {
    recursive: true
  });

  if (
    !existsSync(model) ||
    statSync(model).size < 1_000_000
  ) {
    console.log(
      "Downloading version-1 Face Landmarker model (build time only; no camera data is involved)..."
    );

    const response = await fetch(url, {
      signal: AbortSignal.timeout(45000),
      redirect: "error"
    });

    if (!response.ok) {
      throw new Error(
        `Model download returned HTTP ${response.status}.`
      );
    }

    const bytes = Buffer.from(
      await response.arrayBuffer()
    );

    if (
      bytes.length < 1_000_000 ||
      bytes.length > 30_000_000
    ) {
      throw new Error(
        "Unexpected model length; refusing to use it."
      );
    }

    writeFileSync(
      model + ".partial",
      bytes
    );

    renameSync(
      model + ".partial",
      model
    );
  }

  const hash = createHash("sha256")
    .update(readFileSync(model))
    .digest("hex");

  console.log(
    `Local model ready. SHA-256: ${hash}`
  );

  console.log(
    "WASM and model will be served from your own origin. No runtime third-party model downloads."
  );

} catch (error) {
  console.error(
    `Asset setup: ${error.message}`
  );

  console.error(
    "Retry with npm run assets. See DEPLOYMENT.md, step 2, for blocked-download recovery."
  );

  if (required) {
    process.exitCode = 1;
  }
}

// --------------------------------------------------
// Whisper Tiny on-device speech recognition
// --------------------------------------------------

const speechRepo =
  "onnx-community/whisper-tiny.en";

const speechRevision =
  "2575352d61be1bf7225cf8f8b268a4678025fc58";

const speechFiles = [
  {
    path: "config.json",
    size: 2197
  },
  {
    path: "generation_config.json",
    size: 1646
  },
  {
    path: "preprocessor_config.json",
    size: 339
  },
  {
    path: "tokenizer.json",
    size: 2405679
  },
  {
    path: "tokenizer_config.json",
    size: 282662
  },
  {
    path: "onnx/encoder_model_quantized.onnx",
    size: 10124993,
    sha256:
      "e93ec822f16a8fd264e7de972ad17d615ea7334b75a52d54c50c2e18dd503a25"
  },
  {
    path: "onnx/decoder_model_merged_quantized.onnx",
    size: 30718858,
    sha256:
      "c0592d0749413c960569e1c7fb806b060d5d18f3ebad4a95cbf9a77dc6e9be52"
  }
];

if (process.env.AEGIS_SKIP_SPEECH_MODEL === "1") {
  console.log(
    "Speech model skipped (AEGIS_SKIP_SPEECH_MODEL=1). Spoken digits will be mouth-motion only."
  );

} else {
  try {
    const require = createRequire(import.meta.url);

    // Resolve the installed browser ONNX runtime.
    // Transformers.js 4.x stores its WASM binaries
    // in the onnxruntime-web package.

    const ortEntry = require.resolve(
      "onnxruntime-web"
    );

    // The entry point may be nested inside dist.
    // Walk upward to locate the package root.
    let ortPackageRoot = dirname(ortEntry);

    while (
      !existsSync(
        resolve(ortPackageRoot, "package.json")
      )
    ) {
      const parent = dirname(ortPackageRoot);

      if (parent === ortPackageRoot) {
        throw new Error(
          "Could not locate onnxruntime-web package root."
        );
      }

      ortPackageRoot = parent;
    }

    const ortDist = resolve(
      ortPackageRoot,
      "dist"
    );

const runtimeFiles = [
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.asyncify.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.jspi.mjs",
  "ort-wasm-simd-threaded.jspi.wasm"
];

    const targetDir = resolve(
      root,
      "public/ort"
    );

    mkdirSync(targetDir, {
      recursive: true
    });

    for (const name of runtimeFiles) {
      const source = resolve(
        ortDist,
        name
      );

      if (!existsSync(source)) {
        throw new Error(
          `ONNX runtime file ${name} not found at ${source}`
        );
      }

      cpSync(
        source,
        resolve(targetDir, name)
      );
    }

    console.log(
      "ONNX WebAssembly runtime assets prepared successfully."
    );

    // ----------------------------------------------
    // Verify existing Whisper model files
    // ----------------------------------------------

    const ok = (file, target) =>
      existsSync(target) &&
      statSync(target).size === file.size &&
      (
        !file.sha256 ||
        createHash("sha256")
          .update(readFileSync(target))
          .digest("hex") === file.sha256
      );

    for (const file of speechFiles) {
      const target = resolve(
        root,
        "public/models/whisper",
        file.path
      );

      if (ok(file, target)) {
        continue;
      }

      console.log(
        `Downloading speech model file ${file.path} (build time only; no audio is involved)...`
      );

      mkdirSync(dirname(target), {
        recursive: true
      });

      const response = await fetch(
        `https://huggingface.co/${speechRepo}/resolve/${speechRevision}/${file.path}`,
        {
          signal: AbortSignal.timeout(300000)
        }
      );

      if (!response.ok) {
        throw new Error(
          `Speech model download returned HTTP ${response.status} for ${file.path}.`
        );
      }

      writeFileSync(
        target + ".partial",
        Buffer.from(
          await response.arrayBuffer()
        )
      );

      if (!ok(file, target + ".partial")) {
        throw new Error(
          `Unexpected length or checksum for ${file.path}; refusing to use it.`
        );
      }

      renameSync(
        target + ".partial",
        target
      );
    }

    console.log(
      `Speech model ready: ${speechRepo}@${speechRevision.slice(0, 12)} in public/models/whisper, runtime in public/ort.`
    );

  } catch (error) {
    console.error(
      `Speech asset setup: ${error.message}`
    );

    console.error(
      "Retry with npm run assets, or set AEGIS_SKIP_SPEECH_MODEL=1 to build without on-device digit recognition."
    );

    if (required) {
      process.exitCode = 1;
    }
  }
}
