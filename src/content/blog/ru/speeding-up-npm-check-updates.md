---
title: "Ускоряем проверку npm-зависимостей в 3 раза"
date: "2026-07-01"
excerpt: "npm-check-updates загружает для каждого пакета всю его историю. Заменить это небольшим запросом несложно, но замеры показали, что главная проблема кроется в другом."
tags:
  - nodejs
  - typescript
  - open-source
  - performance
---

`npm-check-updates` находит новые версии пакетов, от которых зависит проект. Я пользуюсь им почти каждый день, и на среднем проекте результата приходится ждать около трёх секунд. Чтобы понять почему, я первым делом посмотрел, какие запросы он отправляет в registry.

## Что возвращает registry

Информацию о пакете можно получить из npm registry двумя способами:

```bash
$ curl -s https://registry.npmjs.org/typescript | wc -c
15788071
$ curl -s https://registry.npmjs.org/typescript/latest | wc -c
4833
```

Первый адрес возвращает всю историю пакета: каждую версию, её зависимости и дату выхода. Для `typescript` это 15 мегабайт JSON. Второй адрес отдаёт только последнюю версию.

![GET /typescript возвращает 15.8 МБ, GET /typescript/latest всего 4.8 КБ](/sketches/npm/payload.svg)

`ncu` обращается к первому адресу, и на то есть веская причина: режимы вроде `--target minor` без истории версий не работают. Переписать слой запросов, сохранив все эти возможности, было бы большим и рискованным изменением. Мне же ни одна из них не была нужна, поэтому я решил написать отдельный небольшой инструмент.

## fast-ncu

Вся основная работа выполняется в одной функции:

```ts
async function fetchLatestVersion(name: string): Promise<string | null> {
  const encodedName = name.startsWith("@")
    ? `@${encodeURIComponent(name.substring(1))}`
    : encodeURIComponent(name);

  const response = await fetch(`https://registry.npmjs.org/${encodedName}/latest`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry responded with status ${response.status}`);

  const data = (await response.json()) as { version?: string };
  return data.version ?? null;
}
```

В scoped-пакетах символ `/` кодируется, иначе registry не поймёт запрос: для `@types/node` адрес будет `@types%2Fnode/latest`. Полученные версии на пять минут сохраняются во временный файл, поэтому при обновлении с `-u` сразу после проверки повторного обращения к сети не происходит:

```ts
const CACHE_FILE = path.join(os.tmpdir(), "fast-ncu-cache.json");
const DEFAULT_CACHE_TTL = 5 * 60 * 1000;
```

## Что показали замеры

Замеры проводились на проекте с 78 зависимостями, а именно на репозитории самого `ncu`:

| Инструмент | Параллельные запросы | Время |
| --- | --- | --- |
| `ncu` | по умолчанию | 2.75 с |
| `fast-ncu` | 15 | 2.70 с |
| `fast-ncu` | 30 | 0.88 с |

![Проверка 78 зависимостей: ncu 2.75 с, fast-ncu 2.70 с при 15 запросах, 0.88 с при 30](/sketches/npm/race.svg)

Хотя ответ стал в три тысячи раз меньше, во второй строке время почти не изменилось. Значит, время уходит не на загрузку данных, а на ожидание каждого ответа:

```bash
$ curl -s -o /dev/null -w '%{time_total}\n' https://registry.npmjs.org/react/latest
0.304698
```

Даже для ответа размером пять килобайт путь туда и обратно занимает 0.3 секунды. В таких условиях действенный способ только один: отправлять больше запросов одновременно. Увеличение числа параллельных запросов до 30 сократило время втрое. Повторная проверка из кэша завершается за 10 миллисекунд, но сравнивать её с `ncu` нельзя, потому что в этом случае к сети вообще не обращаются.

```bash
npx fast-ncu
npx fast-ncu -u --concurrency 30
```

`fast-ncu` проверяет только тег `latest`. Если нужны монорепозитории, lockfile или `--target minor`, правильным выбором остаётся сам `ncu`.
