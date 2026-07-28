extends Node

const SAVE_PATH := "user://galaxy_world_save.json"

func save_game() -> bool:
	var data := {
		"planet_seed": GameManager.planet_config.seed,
		"spawn": _vec3_to_dict(GameManager.spawn_position),
		"inventory": InventorySystem.slots.duplicate(true),
		"buildings": GameManager.built_structures.duplicate(true),
		"vertical_slice_complete": GameManager.vertical_slice_complete,
	}
	var file := FileAccess.open(SAVE_PATH, FileAccess.WRITE)
	if file == null:
		return false
	file.store_string(JSON.stringify(data, "\t"))
	return true

func load_game() -> bool:
	if not FileAccess.file_exists(SAVE_PATH):
		return false
	var file := FileAccess.open(SAVE_PATH, FileAccess.READ)
	if file == null:
		return false
	var parsed = JSON.parse_string(file.get_as_text())
	if parsed == null or typeof(parsed) != TYPE_DICTIONARY:
		return false
	GameManager.planet_config.seed = parsed.get("planet_seed", 42)
	GameManager.spawn_position = _dict_to_vec3(parsed.get("spawn", {}))
	InventorySystem.slots = parsed.get("inventory", InventorySystem.slots)
	GameManager.built_structures = parsed.get("buildings", [])
	GameManager.vertical_slice_complete = parsed.get("vertical_slice_complete", false)
	GameManager.state = GWTypes.GameState.PLAYING
	EventBus.inventory_changed.emit()
	return true

func has_save() -> bool:
	return FileAccess.file_exists(SAVE_PATH)

func _vec3_to_dict(v: Vector3) -> Dictionary:
	return {"x": v.x, "y": v.y, "z": v.z}

func _dict_to_vec3(d: Dictionary) -> Vector3:
	return Vector3(d.get("x", 0.0), d.get("y", 0.0), d.get("z", 0.0))
