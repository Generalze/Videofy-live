# AI Runtime Setup

Repository owner: masterzee001

Date: 2026-07-28

> **P6-G0 profile:** Set `AI_RUNTIME_PROFILE=development-demo` for this local stack. This guide
> does not certify a commercial runtime. Commercial profiles must pass the machine-readable
> registry's complete fail-closed licence, rights, deployment, quality, security, and production
> gates before use; media-ingest currently rejects those profile values at startup.

This guide prepares the local P5.2 open-source provider runtime without changing the global Python installation. Use it for partner-preview machines that need the real local path:

`programme audio -> VAD-aware segmentation -> faster-whisper -> OPUS-MT -> Piper -> listener playback`

## Python Environment

Create and activate the isolated Python 3.11 environment from the repository root:

```powershell
py -3.11 -m venv .venv-ai
.\.venv-ai\Scripts\python.exe -m pip install --upgrade pip setuptools wheel
.\.venv-ai\Scripts\python.exe -m pip install -r services\media-ingest\requirements-ai.txt
.\.venv-ai\Scripts\python.exe -m pip check
```

The P5.2 validation environment used Python 3.11.9. Do not install these dependencies into the user's global Python 3.14 runtime.

## Model Cache

Store models in ignored local cache directories:

- `services/media-ingest/model_cache/faster-whisper`
- `services/media-ingest/model_cache/opus-mt`
- `services/media-ingest/model_cache/piper`

Prepare the validated English-to-Spanish path before starting services:

```powershell
$env:HF_HUB_DISABLE_XET = "1"
.\.venv-ai\Scripts\python.exe -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='Systran/faster-whisper-small.en', cache_dir='services/media-ingest/model_cache/faster-whisper')"
.\.venv-ai\Scripts\python.exe -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='Helsinki-NLP/opus-mt-en-es', cache_dir='services/media-ingest/model_cache/opus-mt')"
```

Piper requires a local executable and matching voice files:

- Executable: `services/media-ingest/model_cache/piper/bin/piper/piper.exe`
- Voice model: `services/media-ingest/model_cache/piper/es_ES-sharvard-medium/es_ES-sharvard-medium.onnx`
- Voice config: `services/media-ingest/model_cache/piper/es_ES-sharvard-medium/es_ES-sharvard-medium.onnx.json`

## Environment Variables

Example CPU configuration:

```powershell
$root = (Get-Location).Path
$env:AI_PYTHON_EXECUTABLE = "$root\.venv-ai\Scripts\python.exe"
$env:TRANSCRIPTION_PROVIDER = "faster-whisper"
$env:FASTER_WHISPER_PYTHON = "$root\.venv-ai\Scripts\python.exe"
$env:FASTER_WHISPER_MODEL_SIZE = "small.en"
$env:FASTER_WHISPER_DEVICE = "cpu"
$env:FASTER_WHISPER_COMPUTE_TYPE = "int8"
$env:FASTER_WHISPER_MODEL_CACHE_DIR = "$root\services\media-ingest\model_cache\faster-whisper"
$env:FASTER_WHISPER_ALLOW_MODEL_DOWNLOAD = "false"
$env:TIMESTAMPED_TRANSLATION_PROVIDER = "opus-mt"
$env:OPUS_MT_PYTHON = "$root\.venv-ai\Scripts\python.exe"
$env:OPUS_MT_MODELS = "en:es:Helsinki-NLP/opus-mt-en-es:$root\services\media-ingest\model_cache\opus-mt\models--Helsinki-NLP--opus-mt-en-es\snapshots\5bc4493d463cf000c1f0b50f8d56886a392ed4ab"
$env:OPUS_MT_ALLOW_MODEL_DOWNLOAD = "false"
$env:TEXT_TO_SPEECH_PROVIDER = "piper"
$env:PIPER_EXECUTABLE = "$root\services\media-ingest\model_cache\piper\bin\piper\piper.exe"
$env:PIPER_MODEL_PATH = "$root\services\media-ingest\model_cache\piper\es_ES-sharvard-medium\es_ES-sharvard-medium.onnx"
$env:PIPER_CONFIG_PATH = "$root\services\media-ingest\model_cache\piper\es_ES-sharvard-medium\es_ES-sharvard-medium.onnx.json"
$env:PIPER_VOICE_ID = "es_ES-sharvard-medium"
$env:PIPER_VOICE_LANGUAGE = "es"
$env:PIPER_FFMPEG = "ffmpeg"
```

Validated GPU transcription setting:

```powershell
$env:FASTER_WHISPER_DEVICE = "cuda"
$env:FASTER_WHISPER_COMPUTE_TYPE = "float16"
```

Do not use `cuda` plus `int8_float16` on the validated RTX 5060 Laptop GPU configuration until CTranslate2/cuBLAS compatibility is resolved; it failed with `CUBLAS_STATUS_NOT_SUPPORTED`.

## Health Checks

Run these before a partner-preview session:

```powershell
ffmpeg -version
services\media-ingest\model_cache\piper\bin\piper\piper.exe --version
.\.venv-ai\Scripts\python.exe -m pip check
.\.venv-ai\Scripts\python.exe -c "import faster_whisper, ctranslate2, transformers, silero_vad, torch, torchaudio, soundfile; print('ai runtime ok')"
```

Expected P5.2 versions:

- Piper `1.2.0`
- faster-whisper `1.2.1`
- CTranslate2 `4.8.1`
- Transformers `5.14.1`
- Silero VAD `6.2.1`
- Torch `2.13.0+cpu`
- Torchaudio `2.11.0+cpu`

## Runtime Notes

- Keep `.venv-ai`, `model_cache`, generated WAV files, browser evidence, and benchmark outputs ignored.
- Do not download models during an active partner session.
- Real providers must fail clearly on missing Python, FFmpeg, model cache, unsupported language, timeout, or provider failure.
- Mock providers are for tests only and must not be used as silent fallback.
- Piper voices may emit native sample rates such as 22.05 kHz; the service normalizes generated output to mono 16 kHz PCM 16-bit WAV before delivery.
