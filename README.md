# Galaxy World

**Build. Explore. Survive. Reach the Stars.**

Вертикальный срез космической песочницы от первого лица на Godot 4: процедурная планета, выживание в скафандре, добыча ресурсов, крафт, строительство базы и помощник EVA.

## Требования

- macOS 12+
- [Godot 4.3+](https://godotengine.org/download)

## Установка Godot на macOS

```bash
brew install --cask godot
```

Или скачайте Godot 4 с официального сайта и поместите в `/Applications`.

## Запуск

1. Откройте папку проекта в Godot: **Import** → выберите `project.godot`
2. Нажмите **F5** (Play) или кнопку Run
3. В главном меню выберите **New Game**

Из терминала (если `godot` в PATH):

```bash
cd "/Users/annaivannikova/Yandex.Disk.localized/MacBook Air/Project/Galaxy World"
godot --path . res://scenes/ui/main_menu.tscn
```

## Тесты

Запуск unit-тестов (headless):

```bash
./run_tests.sh
```

Или напрямую:

```bash
godot --headless --path . -s res://tests/run_tests.gd
```

Тесты покрывают: инвентарь, крафт, стоимость построек, генератор планеты, GameManager, EventBus, сохранения.

## Управление

| Клавиша | Действие |
|---------|----------|
| WASD | Движение |
| Shift | Спринт |
| Пробел | Прыжок |
| Мышь | Обзор |
| ЛКМ | Добыча ресурсов / размещение постройки |
| E | Взаимодействие с обломками |
| Tab | Инвентарь |
| C | Крафт |
| B | Режим строительства |
| 1–5 | Выбор модуля базы (в режиме строительства) |
| Esc | Освободить / захватить курсор |

## Игровой цикл

1. Проснитесь в аварийной капсуле на неизвестной планете
2. Добывайте ресурсы (камень, железо, медь, кремний, органика)
3. Крафтите Metal Plate, Wire, Circuit, Generator
4. Стройте модули базы (Foundation, Habitat, Generator и др.)
5. Подойдите к ядру Aurora и завершите вертикальный срез

## Структура проекта

```
scenes/          # Сцены Godot
scripts/         # GDScript (autoload, player, world, UI, building)
resources/       # Ресурсы предметов и рецептов
```

## Autoload-синглтоны

- `GameManager` — состояние игры
- `EventBus` — события и EVA-триггеры
- `InventorySystem` — инвентарь
- `CraftingSystem` — крафт и стоимость построек
- `SaveSystem` — заглушка сохранений

## Следующий этап (фаза 2)

- Орбита и шаттл L1
- Вторая планета
- Save/Load
- Звук и улучшенная графика
