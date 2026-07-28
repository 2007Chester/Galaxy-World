extends Node

signal build_mode_toggled(active: bool)

var build_mode_active := false
var selected_building: int = GWTypes.BuildingId.FOUNDATION
var _preview: Node3D = null

const BUILDING_SCENES := {
	GWTypes.BuildingId.FOUNDATION: preload("res://scenes/buildings/foundation.tscn"),
	GWTypes.BuildingId.HABITAT: preload("res://scenes/buildings/habitat.tscn"),
	GWTypes.BuildingId.STORAGE: preload("res://scenes/buildings/storage.tscn"),
	GWTypes.BuildingId.GENERATOR: preload("res://scenes/buildings/generator.tscn"),
	GWTypes.BuildingId.OXYGEN_STATION: preload("res://scenes/buildings/oxygen_station.tscn"),
}

var buildings_root: Node3D

func _ready() -> void:
	buildings_root = get_parent().get_node("Planet/Buildings")
	add_to_group("building_system")
	set_process(false)
	set_process_unhandled_input(true)

func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("build_mode"):
		toggle_build_mode()
	if build_mode_active:
		if event.is_action_pressed("place_building"):
			_place_building()
		if event is InputEventKey and event.pressed:
			match event.keycode:
				KEY_1: select_building(GWTypes.BuildingId.FOUNDATION)
				KEY_2: select_building(GWTypes.BuildingId.HABITAT)
				KEY_3: select_building(GWTypes.BuildingId.STORAGE)
				KEY_4: select_building(GWTypes.BuildingId.GENERATOR)
				KEY_5: select_building(GWTypes.BuildingId.OXYGEN_STATION)

func _process(_delta: float) -> void:
	_update_preview()

func toggle_build_mode() -> void:
	build_mode_active = not build_mode_active
	set_process(build_mode_active)
	if build_mode_active:
		_create_preview()
	else:
		_clear_preview()
	build_mode_toggled.emit(build_mode_active)
	EventBus.build_mode_changed.emit(build_mode_active)

func select_building(id: int) -> void:
	selected_building = id
	if build_mode_active:
		_clear_preview()
		_create_preview()

func _create_preview() -> void:
	_clear_preview()
	if not BUILDING_SCENES.has(selected_building):
		return
	_preview = BUILDING_SCENES[selected_building].instantiate()
	_preview.set_preview_mode(true)
	buildings_root.add_child(_preview)

func _clear_preview() -> void:
	if _preview and is_instance_valid(_preview):
		_preview.queue_free()
	_preview = null

func _update_preview() -> void:
	if not _preview:
		return
	var cam := get_viewport().get_camera_3d()
	if not cam:
		return
	var from := cam.global_position
	var to := from - cam.global_basis.z * 20.0
	var space := get_viewport().get_world_3d().direct_space_state
	var query := PhysicsRayQueryParameters3D.create(from, to)
	query.collision_mask = GWConstants.LAYER_WORLD | GWConstants.LAYER_BUILDING
	var result := space.intersect_ray(query)
	if result.is_empty():
		return
	var pos: Vector3 = result.position
	pos = _snap_to_grid(pos)
	pos.y += 0.05
	_preview.global_position = pos

func _place_building() -> void:
	if not CraftingSystem.can_build(selected_building):
		return
	if not _preview:
		return
	var pos := _preview.global_position
	if not CraftingSystem.consume_build_cost(selected_building):
		return
	var building: Node3D = BUILDING_SCENES[selected_building].instantiate()
	building.global_position = pos
	buildings_root.add_child(building)
	var data := {"id": selected_building, "position": pos}
	GameManager.register_building(data)
	EventBus.notify_build(data)
	_create_preview()

func _snap_to_grid(pos: Vector3) -> Vector3:
	var g := GWConstants.BUILD_GRID_SIZE
	return Vector3(
		roundf(pos.x / g) * g,
		pos.y,
		roundf(pos.z / g) * g
	)

func apply_generator_buffs(delta: float) -> void:
	var player := get_tree().get_first_node_in_group("player")
	if not player:
		return
	for child in buildings_root.get_children():
		if child.is_in_group("generator") and child.global_position.distance_to(player.global_position) <= GWConstants.GENERATOR_O2_RADIUS:
			player.apply_generator_o2(GWConstants.GENERATOR_O2_RATE * delta)
