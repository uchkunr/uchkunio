---
title: "Jonli video tahlilida kechikishning oldini olish"
date: "2026-10-12"
excerpt: "YardLens kamera oqimidagi mashina va odamlarni sanaydi. Uni yozishdagi asosiy saboq: kadrlarni navbatga qo'ygan tizim kechikishni yig'adi, ularni tashlab yuborgan tizim esa jonli bo'lib qoladi."
tags:
  - python
  - computer-vision
  - concurrency
  - fastapi
---

[YardLens](https://github.com/uchkunr/yardlens) kamera oqimidan transport va odamlarni aniqlaydi, ularni kuzatib boradi va chizilgan chiziqdan o'tganlarni sanaydi. Aniqlashni YOLO, kuzatishni ByteTrack bajaradi, natijalar esa veb-panelga jonli uzatiladi. Quyida loyihadagi eng muhim qarorlar va ularning sababi keltirilgan.

## Navbat kechikishni yig'adi

Faraz qilaylik, kamera soniyasiga 25 kadr beradi, protsessordagi model esa ulardan atigi 5 tasini tahlil qila oladi. Har bir kadr navbatga qo'yilsa, tahlil qilinmagan kadrlar to'xtovsiz ko'payib boradi:

```python
camera_fps, model_fps = 25, 5
for minutes in (1, 10, 60):
    backlog = (camera_fps - model_fps) * minutes * 60  # navbatda kutayotgan kadrlar
    print(f"{minutes:>2} daqiqadan keyin kechikish: {backlog / model_fps / 60:.0f} daqiqa")
```

```text
 1 daqiqadan keyin kechikish: 4 daqiqa
10 daqiqadan keyin kechikish: 40 daqiqa
60 daqiqadan keyin kechikish: 240 daqiqa
```

Bir soatdan so'ng tizim to'rt soat oldingi voqeani jonli deb ko'rsatadi. Shu sababli YardLens'da kadrlar navbati umuman yo'q: kamerani o'qiydigan oqim faqat oxirgi kadrni saqlaydi va har bir yangi kadr oldingisining o'rnini egallaydi.

```python
with self._frame_ready:
    self._latest_frame = frame
    self._frame_seq += 1
    self._frame_ready.notify_all()
```

Tahlil oqimi uyg'onganda navbatdagi emas, eng so'nggi kadrni oladi. Model ulgurmagan kadrlar tashlab yuboriladi, kechikish esa bir kadrdan oshmaydi:

```python
with self._frame_ready:
    while self._frame_seq == last_seq and not self._stop.is_set():
        self._frame_ready.wait(timeout=1.0)
    frame = self._latest_frame
    last_seq = self._frame_seq
```

## Tahlil va tasvir turli tezlikda ishlaydi

Har bir kamera uchta oqimga ega: o'qish, tahlil va tasvirlash. Tahlil soniyasiga 3 marta, jonli tasvir esa 15 marta yangilanadi. Ikki tahlil oralig'ida ramka joyida qotib qolmasligi uchun tasvirlash oqimi uni obyektning silliqlangan tezligi bo'yicha oldinga suradi:

```python
elapsed = min(max(timestamp - motion.seen_at, 0.0), self._max_extrapolation)
box = (
    motion.box[0] + motion.velocity[0] * elapsed,
    motion.box[1] + motion.velocity[1] * elapsed,
    motion.box[2] + motion.velocity[2] * elapsed,
    motion.box[3] + motion.velocity[3] * elapsed,
)
```

Bashorat `max(1.5 / fps, 0.3)` soniya bilan chegaralangan, ya'ni soniyasiga 3 tahlilda yarim soniyadan oshmaydi. Natijada sekin protsessorda ham tasvir ravon ko'rinadi. Voqea suratlarida esa faqat modelning haqiqiy natijasi chiziladi, bashorat qilingan ramkalar u yerga tushmaydi.

## Bitta model, bitta qulf

Ultralytics modeli bir vaqtdagi bir nechta `predict` chaqiruviga mo'ljallanmagan. Har bir kamera uchun alohida model yuklash xotirani kameralar soniga ko'paytirardi, shu bois barcha oqimlar bitta modeldan navbat bilan foydalanadi:

```python
with self._lock:
    model = self._model
    # ...
    results = model.predict(frame, conf=confidence, classes=class_ids, device=self._device, verbose=False)
```

Buning bahosi o'tkazuvchanlikdir: nano model protsessorda bir necha kamerani soniyasiga 2-5 kadr bilan tortadi, undan ortig'i uchun GPU kerak bo'ladi.

## Oqimlar bazani bilmaydi

Kamera oqimlari asyncio va ma'lumotlar bazasidan bexabar. Ular voqeani event loop'ga uzatadi, xolos:

```python
def on_event(self, event: WorkerEvent) -> None:
    self._loop.call_soon_threadsafe(self._on_event, event)
```

U yerda voqealar 100 tadan yoki 250 millisekund ichida to'planib, bazaga bitta tranzaksiyada yoziladi. Navbat 10 000 voqea bilan chegaralangan: baza shu darajada ortda qolsa, kamerani to'xtatgandan ko'ra voqeani ogohlantirish bilan tashlab yuborish afzal.

```python
self._queue: asyncio.Queue[WorkerEvent] = asyncio.Queue(maxsize=10_000)

def submit(self, event: WorkerEvent) -> None:
    try:
        self._queue.put_nowait(event)
    except asyncio.QueueFull:
        logger.warning("Event queue full; dropping event", extra={"type": event.type.value})
```

## Brauzer ham chegara qo'yadi

HTTP/1.1 da brauzer bitta manzilga oltitagacha ulanish ochadi, har bir MJPEG oqimi esa ulardan birini doimiy band qiladi. Sahifada sakkizta kamera jonli ko'rsatilsa, qolgan so'rovlar navbatda qotib qoladi. Shuning uchun bir vaqtda faqat to'rtta plitka oqim oladi, qolganlari esa har soniyada suratini yangilaydi:

```ts
const MAX_STREAMS = 4;

granted(key: string) {
  const index = this.holders.indexOf(key);
  return index >= 0 && index < MAX_STREAMS;
}
```

Barcha qarorlar loyihaning [README](https://github.com/uchkunr/yardlens#design-decisions) faylida, cheklovlari bilan birga yozilgan.
