# Galaxy World

**Build. Explore. Survive. Reach the Stars.**

Космическая песочница: процедурная планета, выживание, добыча, крафт, база и EVA.

Доступны две версии:

1. **Браузер** (Three.js) — быстрый запуск без установки движка
2. **Godot 4** — нативный прототип для macOS / desktop

---

## Браузерная версия (рекомендуется)

### Запуск

```bash
cd "/Users/annaivannikova/Yandex.Disk.localized/MacBook Air/Project/Galaxy World"
python3 serve_web.py
```

Откройте в браузере: [http://127.0.0.1:8080/](http://127.0.0.1:8080/)

Или любой статический сервер из папки `web/`:

```bash
cd web && python3 -m http.server 8080
```

> Нужен локальный сервер: браузер блокирует ES-модули с `file://`.

### Управление

| Клавиша | Действие |
|---------|----------|
| WASD | Движение |
| Shift | Спринт |
| Пробел | Прыжок |
| Мышь / клик | Обзор (pointer lock) |
| ЛКМ | Добыча / размещение постройки |
| E | Обломки Aurora |
| Tab | Инвентарь |
| C | Крафт |
| B | Строительство |
| 1–5 | Выбор модуля |
| Esc | Отпустить мышь |

### Игровой цикл

1. New Game → капсула на зелёной планете  
2. Добыча Stone / Iron / Copper / Silicon / Organic  
3. Крафт Metal Plate → Wire → Circuit → Generator  
4. Строительство Habitat / Generator (O2 в радиусе 10 м)  
5. Ядро Aurora → Vertical Slice Complete  

Файлы: `web/index.html`, `web/js/*`, `web/css/style.css`

---

## Godot 4 (desktop)

### Требования

- macOS 12+
- [Godot 4.3+](https://godotengine.org/download)

### Запуск

1. Откройте `project.godot` в Godot  
2. **F5** → **New Game**

```bash
godot --path . res://scenes/ui/main_menu.tscn
```

### Тесты (Godot)

```bash
./run_tests.sh
```

---

## Структура

```
web/                 # Браузерная игра (Three.js)
scenes/ scripts/     # Godot-версия
resources/           # Предметы Godot
tests/               # Unit-тесты Godot
serve_web.py         # Локальный сервер для браузера
```

## Следующий этап

- Орбита и шаттл L1
- Вторая планета
- Save/Load
- Звук и улучшенная графика
- Godot HTML5 export (опционально)
