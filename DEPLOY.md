# Как выложить на Deno Deploy (2 клика в браузере)

Репозиторий: https://github.com/reo889537-ui/checkers

1. Откройте https://console.deno.com → организация **countrywars** → приложение **countrywars**.
2. **Settings → Repository** → выберите `reo889537-ui/checkers` (если репозитория нет в списке:
   «Configure GitHub app permissions» → дайте Deno доступ к нему).
3. Проверьте конфигурацию сборки:
   - Source: GitHub, ветка `main`
   - Dynamic app, entrypoint: `server.ts`
   - Build command: пусто (или `deno cache server.ts`)
   - Install command: пусто
4. Нажмите **Deploy** (или сохраните — сборка начнётся сама после пуша).

Что появится после сборки:

| Адрес | Что отдаёт |
|---|---|
| `/` | новый сайт с кнопкой «Скачать для Windows» |
| `/play` | игра прямо в браузере |
| `/download/win` | Shashki.exe (Windows, один файл) |
| `/download/apk` | Shashki.apk (Android) |
| `/health` | `{"ok":true,...}` |

## Если что-то пошло не так

- Сборка упала → в логе сборки будет причина; чаще всего это доступ к приватному репозиторию.
- Нужно вернуть прежнюю версию → в приложении **Deployments → предыдущий → Rollback**.
- Данные: рейтинг старых игроков переносится автоматически из `seed/leaderboard.json`
  при первом запуске (однократно, флаг `["meta","seed"]` в KV).
