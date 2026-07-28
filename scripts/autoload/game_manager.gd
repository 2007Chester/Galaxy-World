extends Node

var state: int = GWTypes.GameState.MAIN_MENU
var mode: int = GWTypes.GameMode.SURVIVAL
var planet_config: GWTypes.PlanetConfig = GWTypes.PlanetConfig.new()
var spawn_position: Vector3 = Vector3.ZERO
var built_structures: Array = []
var game_started: bool = false
var vertical_slice_complete: bool = false

func start_new_game() -> void:
	planet_config = GWTypes.PlanetConfig.new()
	planet_config.seed = randi()
	spawn_position = Vector3.ZERO
	built_structures.clear()
	game_started = true
	vertical_slice_complete = false
	state = GWTypes.GameState.PLAYING
	InventorySystem.reset()
	EventBus.reset_triggers()
	EventBus.game_started.emit()

func set_spawn(pos: Vector3) -> void:
	spawn_position = pos

func register_building(data: Dictionary) -> void:
	built_structures.append(data)

func complete_vertical_slice() -> void:
	if vertical_slice_complete:
		return
	vertical_slice_complete = true
	state = GWTypes.GameState.COMPLETE
	EventBus.vertical_slice_complete.emit()

func pause_game() -> void:
	if state == GWTypes.GameState.PLAYING:
		state = GWTypes.GameState.PAUSED
		get_tree().paused = true

func resume_game() -> void:
	if state == GWTypes.GameState.PAUSED:
		state = GWTypes.GameState.PLAYING
		get_tree().paused = false

func is_survival() -> bool:
	return mode == GWTypes.GameMode.SURVIVAL or mode == GWTypes.GameMode.HARDCORE

func is_creative() -> bool:
	return mode == GWTypes.GameMode.CREATIVE
