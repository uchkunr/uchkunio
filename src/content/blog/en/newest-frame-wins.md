---
title: "Preventing latency buildup in live video analysis"
date: "2026-07-28"
excerpt: "YardLens counts vehicles and people in a camera stream. The main lesson from building it is that a system which queues frames accumulates latency, while a system which drops them stays live."
tags:
  - python
  - computer-vision
  - concurrency
  - fastapi
---

[YardLens](https://github.com/uchkunr/yardlens) detects vehicles and people in a camera stream, tracks them, and counts the ones that cross a drawn line. YOLO handles detection, ByteTrack handles tracking, and the results are streamed live to a web dashboard. Below are the most important decisions in the project and the reasoning behind each one.

<video src="/media/yardlens-demo.mp4" poster="/media/yardlens-demo.jpg" width="900" height="562" autoplay loop muted playsinline aria-label="YardLens dashboard: live cameras, line crossings and real-time events"></video>

## A queue accumulates latency

Suppose the camera delivers 25 frames per second, while the model running on the CPU can analyze only 5 of them. If every frame goes into a queue, the number of unanalyzed frames grows without end:

```python
camera_fps, model_fps = 25, 5
for minutes in (1, 10, 60):
    backlog = (camera_fps - model_fps) * minutes * 60  # frames waiting in the queue
    print(f"{minutes:>2} min elapsed, latency: {backlog / model_fps / 60:.0f} min")
```

```text
 1 min elapsed, latency: 4 min
10 min elapsed, latency: 40 min
60 min elapsed, latency: 240 min
```

![With a queue the lag grows every second; keeping only the latest frame holds it under one frame](/sketches/yardlens/queue-vs-latest.svg)

After an hour, the system shows something that happened four hours ago as if it were live. That is why YardLens has no frame queue at all: the thread that reads the camera keeps only the latest frame, and each new frame replaces the previous one.

```python
with self._frame_ready:
    self._latest_frame = frame
    self._frame_seq += 1
    self._frame_ready.notify_all()
```

When the analysis thread wakes up, it takes the most recent frame rather than the next one in line. Frames the model could not get to are dropped, and the latency never exceeds a single frame:

```python
with self._frame_ready:
    while self._frame_seq == last_seq and not self._stop.is_set():
        self._frame_ready.wait(timeout=1.0)
    frame = self._latest_frame
    last_seq = self._frame_seq
```

![Per camera: the capture thread keeps only the newest frame; inference at 3 fps and rendering at 15 fps read it independently](/sketches/yardlens/threads.svg)

## Analysis and rendering run at different rates

Each camera has three threads: reading, analysis and rendering. Analysis runs 3 times per second, while the live view updates 15 times per second. To keep the bounding box from freezing in place between two analyses, the rendering thread moves it forward according to the object's smoothed velocity:

```python
elapsed = min(max(timestamp - motion.seen_at, 0.0), self._max_extrapolation)
box = (
    motion.box[0] + motion.velocity[0] * elapsed,
    motion.box[1] + motion.velocity[1] * elapsed,
    motion.box[2] + motion.velocity[2] * elapsed,
    motion.box[3] + motion.velocity[3] * elapsed,
)
```

The prediction is capped at `max(1.5 / fps, 0.3)` seconds, which at 3 analyses per second means no more than half a second. As a result, the picture looks smooth even on a slow CPU. Event snapshots, however, show only the model's actual output, and predicted boxes never end up in them.

## One model, one lock

The Ultralytics model is not designed for several concurrent `predict` calls. Loading a separate model for each camera would multiply memory use by the number of cameras, so all the threads take turns using a single model:

```python
with self._lock:
    model = self._model
    # ...
    results = model.predict(frame, conf=confidence, classes=class_ids, device=self._device, verbose=False)
```

The price is throughput: on a CPU, the nano model handles a few cameras at 2-5 frames per second, and anything beyond that requires a GPU.

## The threads know nothing about the database

The camera threads are unaware of both asyncio and the database. All they do is hand each event over to the event loop:

```python
def on_event(self, event: WorkerEvent) -> None:
    self._loop.call_soon_threadsafe(self._on_event, event)
```

There, events are collected in batches of 100 or over 250 milliseconds and written to the database in a single transaction. The queue is capped at 10 000 events: if the database falls that far behind, dropping the event with a warning is better than stopping the camera.

```python
self._queue: asyncio.Queue[WorkerEvent] = asyncio.Queue(maxsize=10_000)

def submit(self, event: WorkerEvent) -> None:
    try:
        self._queue.put_nowait(event)
    except asyncio.QueueFull:
        logger.warning("Event queue full; dropping event", extra={"type": event.type.value})
```

## The browser imposes a limit too

Over HTTP/1.1 a browser opens at most six connections to a single host, and every MJPEG stream keeps one of them permanently busy. If a page shows eight cameras live, the remaining requests get stuck waiting in line. That is why only four tiles receive a stream at any given time, while the rest refresh their snapshot every second:

```ts
const MAX_STREAMS = 4;

granted(key: string) {
  const index = this.holders.indexOf(key);
  return index >= 0 && index < MAX_STREAMS;
}
```

All of these decisions, along with their limitations, are documented in the project's [README](https://github.com/uchkunr/yardlens#design-decisions).
