extends StaticBody3D

@export var is_core: bool = false
@export var loot_item: int = GWTypes.ItemId.CIRCUIT
@export var loot_amount: int = 2

var _looted := false
var _pending_core := false

func setup(core: bool = false) -> void:
	is_core = core
	if is_core:
		loot_item = GWTypes.ItemId.CIRCUIT
		loot_amount = 3
		_pending_core = true
		scale = Vector3(2.0, 1.5, 2.0)
	else:
		scale = Vector3.ONE * randf_range(0.8, 1.4)

func _ready() -> void:
	collision_layer = GWConstants.LAYER_WORLD
	collision_mask = 0
	add_to_group("interactable")
	if is_core:
		add_to_group("aurora_core")
		if _pending_core:
			$MeshInstance3D.material_override = _core_material()

func interact(_player: Node) -> void:
	if _looted:
		if is_core:
			EventBus.aurora_core_reached.emit()
			GameManager.complete_vertical_slice()
		return
	_looted = true
	InventorySystem.add_item(loot_item, loot_amount)
	EventBus.show_eva(
		"Обломок Aurora: получено %s x%d." % [GWConstants.item_name(loot_item), loot_amount]
	)
	if is_core:
		EventBus.aurora_core_reached.emit()
		GameManager.complete_vertical_slice()

func get_interact_prompt() -> String:
	if is_core:
		return "E — Исследовать ядро Aurora"
	return "E — Обыскать обломок"

func _core_material() -> StandardMaterial3D:
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(0.3, 0.5, 0.9)
	mat.emission_enabled = true
	mat.emission = Color(0.2, 0.4, 1.0)
	mat.emission_energy_multiplier = 1.5
	mat.metallic = 0.8
	return mat
