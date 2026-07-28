extends Control

@onready var label: Label = $Panel/Margin/Label

var _timer := 0.0

const MESSAGES := {
	"start": "Пилот, критическое повреждение корабля. Связь с Землёй отсутствует. Координаты неизвестны. Рекомендуемая задача: выжить.",
	"first_mine": "Отлично. Ресурсы — основа выживания.",
	"first_craft": "Технологии восстанавливаются по одному шагу.",
	"first_build": "База — ваш дом в этой галактике.",
	"aurora_core": "Сигнал от главного ядра Aurora. Мы на верном пути.",
}

func _ready() -> void:
	modulate.a = 0.0
	EventBus.eva_message.connect(_show_message)
	EventBus.game_started.connect(func(): _show_message(MESSAGES.start))
	EventBus.first_mine.connect(func(): _show_message(MESSAGES.first_mine))
	EventBus.first_craft.connect(func(): _show_message(MESSAGES.first_craft))
	EventBus.first_build.connect(func(): _show_message(MESSAGES.first_build))
	EventBus.aurora_core_reached.connect(func(): _show_message(MESSAGES.aurora_core))

func _process(delta: float) -> void:
	if _timer > 0.0:
		_timer -= delta
		if _timer <= 0.0:
			var tween := create_tween()
			tween.tween_property(self, "modulate:a", 0.0, 0.5)

func _show_message(text: String) -> void:
	label.text = "EVA: " + text
	modulate.a = 1.0
	_timer = 6.0
