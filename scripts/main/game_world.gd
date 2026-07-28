extends Node3D

@onready var planet: Node3D = $Planet
@onready var player: CharacterBody3D = $Player
@onready var building_system: Node = $BuildingSystem
@onready var ui: CanvasLayer = $UI

func _ready() -> void:
	if not GameManager.game_started:
		GameManager.start_new_game()
	await get_tree().process_frame
	var pod := planet.get_node_or_null("EscapePod")
	if pod:
		player.global_position = pod.global_position + Vector3(0, 1.5, 2)
	EventBus.show_eva("Пилот, критическое повреждение корабля. Связь с Землёй отсутствует. Координаты неизвестны. Рекомендуемая задача: выжить.")

func _process(delta: float) -> void:
	if building_system:
		building_system.apply_generator_buffs(delta)
