extends Control

@onready var oxygen_bar: ProgressBar = $Margin/VBox/Oxygen/Bar
@onready var energy_bar: ProgressBar = $Margin/VBox/Energy/Bar
@onready var health_bar: ProgressBar = $Margin/VBox/Health/Bar
@onready var temp_label: Label = $Margin/VBox/Temp/Value
@onready var crosshair: Label = $Crosshair
@onready var hint_label: Label = $HintLabel
@onready var complete_panel: Panel = $CompletePanel

func _ready() -> void:
	EventBus.suit_stats_changed.connect(_on_stats_changed)
	EventBus.vertical_slice_complete.connect(_on_complete)
	EventBus.build_mode_changed.connect(_on_build_mode)
	complete_panel.visible = false
	_update_hint()

func _on_stats_changed(stats: Dictionary) -> void:
	oxygen_bar.value = stats.get("oxygen", 100.0)
	energy_bar.value = stats.get("energy", 100.0)
	health_bar.value = stats.get("health", 100.0)
	temp_label.text = "%.0f°C" % stats.get("temperature", 22.0)

func _on_complete() -> void:
	complete_panel.visible = true
	get_tree().paused = true
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE

func _on_build_mode(active: bool) -> void:
	if active:
		hint_label.text = "B — выход | 1-5 модуль | ЛКМ — поставить"
	else:
		_update_hint()

func _update_hint() -> void:
	hint_label.text = "WASD — движение | ЛКМ — добыча | E — взаимодействие | Tab — инвентарь | C — крафт | B — строительство"

func _on_complete_ok_pressed() -> void:
	get_tree().paused = false
	get_tree().change_scene_to_file("res://scenes/ui/main_menu.tscn")
