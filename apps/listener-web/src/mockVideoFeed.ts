export interface MockVideoFeed {
  stream: MediaStream;
  stop(): void;
}

export function startMockVideoFeed(): MockVideoFeed {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Canvas 2D context is unavailable');
  }

  const startedAt = performance.now();
  let frame = 0;
  let animationFrame = 0;

  const draw = () => {
    const elapsedMs = performance.now() - startedAt;
    const elapsedSeconds = elapsedMs / 1000;
    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, '#101820');
    gradient.addColorStop(0.55, '#1f6f78');
    gradient.addColorStop(1, '#f2c14e');
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.fillStyle = 'rgba(255, 255, 255, 0.16)';
    for (let i = 0; i < 8; i += 1) {
      const x = ((elapsedSeconds * 90 + i * 180) % (canvas.width + 160)) - 80;
      context.fillRect(x, 120 + i * 55, 120, 16);
    }

    context.fillStyle = 'rgba(0, 0, 0, 0.42)';
    context.fillRect(72, 72, 590, 190);

    context.fillStyle = '#ffffff';
    context.font = '700 54px Inter, system-ui, sans-serif';
    context.fillText('Videofy Live', 104, 145);
    context.font = '400 30px Inter, system-ui, sans-serif';
    context.fillText('Mock Global Product Keynote', 106, 197);

    context.fillStyle = '#f2c14e';
    context.font = '700 34px Inter, system-ui, sans-serif';
    context.fillText(`LIVE ${formatTime(elapsedMs)}`, 106, 240);

    context.fillStyle = '#ffffff';
    context.beginPath();
    const pulse = 44 + Math.sin(frame / 18) * 8;
    context.arc(1020, 358, pulse, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#1f6f78';
    context.font = '700 42px Inter, system-ui, sans-serif';
    context.fillText('VL', 995, 373);

    frame += 1;
    animationFrame = requestAnimationFrame(draw);
  };

  draw();
  const stream = canvas.captureStream(30);

  return {
    stream,
    stop() {
      cancelAnimationFrame(animationFrame);
      for (const track of stream.getTracks()) {
        track.stop();
      }
    },
  };
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
