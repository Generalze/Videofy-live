"""P6.3 Stage B2 gate: OpenVoice + MeloTTS import without disturbing CUDA.

No checkpoints are loaded and no models are downloaded. This proves only that
the runtime is importable on Windows/Python 3.9 and that the proven
torch 2.7.1+cu128 / sm_120 stack survived dependency installation.
"""

import torch
import numpy

from openvoice.api import ToneColorConverter  # noqa: F401
from melo.api import TTS  # noqa: F401

print(f"python numpy     : {numpy.__version__}")
print(f"torch            : {torch.__version__}")
print(f"cuda build       : {torch.version.cuda}")
print(f"cuda available   : {torch.cuda.is_available()}")
print(f"device name      : {torch.cuda.get_device_name(0)}")
print(f"capability       : {torch.cuda.get_device_capability(0)}")
print("openvoice        : ToneColorConverter imported")
print("melotts          : TTS imported")

x = torch.randn(1024, 1024, device="cuda")
y = x @ x
torch.cuda.synchronize()
assert torch.isfinite(y).all(), "CUDA matmul produced non-finite values"
print(f"cuda matmul      : {y.device} mean={y.mean().item():.6f}")

# The exact stack that must not have moved.
assert torch.__version__ == "2.7.1+cu128", f"torch changed: {torch.__version__}"
assert torch.cuda.get_device_capability(0) == (12, 0), "capability changed"

print("\nRESULT: PASS — imports succeed and the CUDA stack is intact")
