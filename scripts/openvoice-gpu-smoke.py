"""P6.3 Step B1 gate: can this Blackwell GPU actually execute PyTorch CUDA?

`torch.cuda.is_available()` returning True is not the gate. A GPU can announce
itself and then refuse to do any work — which is exactly the failure mode a
compute-capability mismatch produces. The tensor operation must genuinely run
and return a finite result.
"""

import time

import torch

print(f"torch            : {torch.__version__}")
print(f"cuda build       : {torch.version.cuda}")
print(f"cuda available   : {torch.cuda.is_available()}")

if not torch.cuda.is_available():
    print("\nRESULT: FAIL — no CUDA device visible to torch")
    raise SystemExit(1)

print(f"device name      : {torch.cuda.get_device_name(0)}")
capability = torch.cuda.get_device_capability(0)
print(f"capability       : {capability}")
print(f"arch list        : {torch.cuda.get_arch_list()}")

# The part that matters: real work on the device.
x = torch.randn(1024, 1024, device="cuda")
y = x @ x
torch.cuda.synchronize()
mean = y.mean().item()
print(f"matmul device    : {y.device}")
print(f"matmul mean      : {mean}")

if not torch.isfinite(torch.tensor(mean)):
    print("\nRESULT: FAIL — matmul produced a non-finite result")
    raise SystemExit(1)

# A crude throughput figure, purely to show the device is doing real work
# rather than silently falling back.
size = 4096
a = torch.randn(size, size, device="cuda")
b = torch.randn(size, size, device="cuda")
torch.cuda.synchronize()
started = time.perf_counter()
for _ in range(10):
    a @ b
torch.cuda.synchronize()
elapsed = time.perf_counter() - started
tflops = (10 * 2 * size**3) / elapsed / 1e12
print(f"matmul 4096^3 x10: {elapsed:.3f}s  ~{tflops:.1f} TFLOP/s")

allocated = torch.cuda.memory_allocated(0) / 1024**2
total = torch.cuda.get_device_properties(0).total_memory / 1024**2
print(f"vram allocated   : {allocated:.0f} MiB of {total:.0f} MiB")

print("\nRESULT: PASS — the GPU executed real work")
