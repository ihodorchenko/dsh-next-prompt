# dsh-next-prompt

[![CI](https://github.com/ihodorchenko/dsh-next-prompt/actions/workflows/ci.yml/badge.svg)](https://github.com/ihodorchenko/dsh-next-prompt/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/ihodorchenko/dsh-next-prompt?display_name=release)](https://github.com/ihodorchenko/dsh-next-prompt/releases/latest)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Предлагаемый следующий запрос в поле сообщения DeepSeek Harness.**

После каждого ответа агента плагин генерирует короткий вариант следующего сообщения и показывает его прямо в поле ввода серым «призрачным» текстом — ровно там, где обычно стоит placeholder. Нажмите **Tab** (или кликните по тексту), чтобы вставить вариант в поле и отредактировать/отправить, **Esc** — чтобы скрыть. Запрос не отправляется автоматически и не меняет диалог, пока вы его не примете.

Плагин состоит из двух половин:

| Половина | Где живёт | Что делает |
|---|---|---|
| `index.js` (Host) | процесс Host (Node) | Слушает `turn/end` корневых сессий, собирает последний вопрос и ответ, одним небольшим запросом к модели просит 2–3 варианта следующего сообщения; при недоступности модели выдаёт эвристический вариант. Отдаёт результат браузеру по `GET /next-prompt/suggest`. |
| `lib/client.js` (Client) | Web GUI (браузер) | Регистрирует компонент в слоте `conversation.input.overlay` внутри карточки композера, показывает призрачный текст, обрабатывает Tab/клик/Esc и вставляет текст через `inputActions.setDraft`. |

Ничего не пишется в лог сессии, инструментов для модели не добавляется, история не меняется.

## Установка

### Через Plugin Manager / CLI (рекомендуется)

```bash
dsh plugin --profile desktop add link:/absolute/path/to/dsh-next-prompt
```

Команда добавляет зависимость `link:` в профиль и, увидев `dsh.bundle.patch`, дописывает `dsh-next-prompt` в `dsh.profile.bundles` — patch-слой самого пакета вставляет строку плагина при сборке профиля. При включённом HMR профиль пересобирается без перезапуска приложения.

Из GitHub (то же, что делает страница Plugins при установке по git-адресу):

```bash
dsh plugin --profile desktop add git+https://github.com/ihodorchenko/dsh-next-prompt.git
```

Либо в Web GUI: **Plugins** → установить по spec `link:/absolute/path/to/dsh-next-prompt` или git-адресу.

### Вручную

Добавьте в `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: next-prompt
      name: dsh-next-prompt
```

и убедитесь, что пакет доступен профилю (зависимость `link:` в `package.json` профиля + `dsh.profile.bundles` содержит `dsh-next-prompt`, или пакет лежит в `node_modules` профиля).

При ручном монтировании без bundle-канала клиентская половина всё равно подхватывается: система клиентских модулей сканирует включённые строки Loader и раздаёт `lib/client.js` по `/plugins`.

### Обновление и перемещение

При установке через `link:` профиль ссылается на каталог плагина: после правок в `index.js`/`lib/client.js` достаточно коснуться файлов (HMR пересоберёт профиль), но **перемещение или удаление каталога ломает установку** — переустановите плагин из нового пути. Git-установка обновляется через Plugin Manager (Update) или повторный `dsh plugin add`.

## Настройка

Все поля необязательны; значения по умолчанию — ниже.

| Поле | По умолчанию | Значение |
|---|---|---|
| `enabled` | `true` | `false` — Host не генерирует и не отдаёт подсказки. |
| `maxSuggestions` | `3` | Сколько вариантов запрашивать у модели. В поле показывается лучший. |
| `showGhost` | `true` | Показывать ли призрачный текст в поле (`false` — только API, без UI). |
| `language` | `auto` | `auto` — язык диалога; `ru`/`en` — принудительно. |
| `model` | `''` | Пусто — модель последнего запроса сессии, иначе модель профиля по умолчанию. Поддерживаются два вида: `provider/model` (например `deepseek-account/deepseek-flash`) и голый id модели (провайдер берётся из сессии/профиля). |
| `minAnswerChars` | `40` | Не генерировать варианты для совсем коротких ответов. |

Префикс HTTP-маршрутов фиксирован: `/next-prompt` (клиентская половина обращается к нему напрямую).

Пример:

```yaml
- insert:
    - id: next-prompt
      name: dsh-next-prompt
      config:
        language: ru
        maxSuggestions: 3
        model: deepseek-account/deepseek-flash
```

Если модель недоступна (нет ключа, ошибка адаптера, таймаут) — используется эвристический вариант, подобранный по тексту ответа и языку диалога; плагин никогда не блокирует интерфейс и не ломает ход сессии.

## Поведение

- Вариант появляется **только когда поле пустое** и ход завершён; набранный текст, вложения и черновик не перезаписываются.
- Пока агент работает, текст не показывается; после нового сообщения пользователя старый вариант сбрасывается.
- Ввод символов, отправка сообщения, смена сессии, Esc — скрывают подсказку.
- Клик по призрачному тексту или Tab вставляет его как обычный черновик через штатный `inputActions.setDraft` — дальше это обычный текст: можно править и отправлять Enter.
- Если DOM композера недоступен (другая версия app, другая раскладка) — компонент молча ничего не рисует.

## Как это устроено (кратко)

1. Host слушает `session/event`; на `turn/end` с причиной `completed` (и не для subagent-сессий) собирает последний `user/message` и `assistant/message`.
2. Через сервис `ctx.llm.stream()` делает один короткий запрос (system + последние реплики, ограничение вывода), парсит JSON-массив вариантов; при любой ошибке — эвристика.
3. Результат кладётся в память per-session и отдаётся по `GET /next-prompt/suggest?session=<id>` (`Cache-Control: no-store`); `GET /next-prompt/config` отдаёт настройки.
4. Client в слоте `conversation.input.overlay` следит за `useSessionStatus()` (переход `running` true→false) и `useInput()` (пустой черновик, `phase: "plain"`), делает fetch с повторами, пока Host отвечает `pending: true`.
5. Призрачный текст позиционируется по реальному `[data-composer-placeholder]`: измеряются `getBoundingClientRect()` и копируются computed font styles, поэтому текст совпадает по месту и шрифту в любой теме; настоящий placeholder на время скрывается и восстанавливается при очистке.
6. Принятие — Tab (на фазе всплытия: только когда подсказка видима, поле в фокусе и пусто, нет открытого меню, IME-композиции и модификаторов) или клик.

## Разработка

```
dsh-next-prompt/
├── index.js                 # Host-половина (ESM, без зависимостей)
├── lib/client.js            # клиентский half (lazy-CJS, без сборки)
├── cordis.patch.yml         # bundle-слой: вставка строки плагина
├── locale/                  # метаданные для Plugin Manager (en, ru)
├── test/                    # тесты без зависимостей: node test/run.mjs
└── .github/workflows/ci.yml # CI: Node 20/22/24
```

Тесты (host black-box, проверка формата бандла, рендер на fake DOM/React):

```bash
node test/run.mjs
```

Никаких `npm install` для тестов не нужно — только Node 20+. Подробности —
в [test/README.md](test/README.md). Изменения — в [CHANGELOG.md](CHANGELOG.md).

После правок `index.js`/`lib/client.js` при `link:`-установке достаточно
обновить файлы: HMR-наблюдатель профиля пересоберёт плагин (иногда — после
касания файла/перезагрузки страницы GUI).

## Ограничения

- «Призрачный» текст — это overlay-элемент поверх placeholder, а не содержимое Lexical-редактора: он не попадает в undo-историю и не считается черновиком, пока не принят.
- Список вариантов показывается только первым (лучшим) в поле; полный массив доступен API (`/next-prompt/suggest`).
- Варианты не кэшируются между перезапусками приложения; после рестарта подсказок нет до следующего ответа.
- Призрачный слой рассчитан на штатный композер web-GUI; если другая тема/плагин меняет разметку поля ввода, слой может быть не виден (без ошибок).

## Диагностика

- Проверить, что route жив: `curl 'http://127.0.0.1:<port>/next-prompt/config'`.
- Проверить, что клиентская половина попала в граф: SSE `GET /plugins/events` — в `entries` должна быть строка `dsh-next-prompt` с `url` на `client.js`.
- Если подсказка не появляется: убедитесь, что ход завершён (не «Остановлено»), поле пустое, плагин включён в **Plugins**, и в `config.enabled` не стоит `false`.

## English

Shows a suggested next prompt as ghost text inside DeepSeek Harness's message field after each answer. The Host half listens for completed turns, asks the model for a few short suggestions (heuristic fallback), and serves them at `/next-prompt/suggest`; the Client half renders the best one over the composer placeholder and inserts it on Tab/click. Nothing is sent automatically, and the session log/model context is untouched. Configuration table above; install with `dsh plugin --profile <name> add link:<dir>`.

## Лицензия

MIT
