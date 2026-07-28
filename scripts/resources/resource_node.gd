extends StaticBody3D

var item_id: int = GWTypes.ItemId.STONE
var drop_amount: int = 3
var max_hp: float = 100.0
var current_hp: float = 100.0

func setup(p_item_id: int, p_drop: int = 3) -> void:
	item_id = p_item_id
	drop_amount = p_drop
	max_hp = 80.0 + p_drop * 10.0
	current_hp = max_hp

func _ready() -> void:
	collision_layer = GWConstants.LAYER_RESOURCE
	collision_mask = 0
	add_to_group("resource_node")
	_apply_visual()

func take_damage(amount: float) -> void:
	current_hp -= amount
	_pulse_damage()
	if current_hp <= 0.0:
		_mine_complete()

func _mine_complete() -> void:
	InventorySystem.add_item(item_id, drop_amount)
	EventBus.notify_mine(item_id, drop_amount)
	queue_free()

func _pulse_damage() -> void:
	var mesh_instance: MeshInstance3D = $MeshInstance3D
	var tween := create_tween()
	tween.tween_property(mesh_instance, "scale", mesh_instance.scale * 0.85, 0.05)
	tween.tween_property(mesh_instance, "scale", Vector3.ONE, 0.05)

func _apply_visual() -> void:
	var mesh_instance: MeshInstance3D = $MeshInstance3D
	if mesh_instance.mesh == null:
		mesh_instance.mesh = BoxMesh.new()
	var mat := StandardMaterial3D.new()
	match item_id:
		GWTypes.ItemId.STONE:
			mat.albedo_color = Color(0.5, 0.5, 0.5)
			mesh_instance.scale = Vector3.ONE
		GWTypes.ItemId.IRON:
			mat.albedo_color = Color(0.55, 0.35, 0.25)
			mesh_instance.scale = Vector3(0.9, 1.2, 0.9)
		GWTypes.ItemId.COPPER:
			mat.albedo_color = Color(0.8, 0.45, 0.2)
			mesh_instance.scale = Vector3(0.9, 0.9, 0.9)
		GWTypes.ItemId.SILICON:
			mat.albedo_color = Color(0.3, 0.7, 0.9)
			mesh_instance.scale = Vector3(0.85, 1.1, 0.85)
		GWTypes.ItemId.ORGANIC:
			mat.albedo_color = Color(0.2, 0.7, 0.3)
			mesh_instance.scale = Vector3(1.1, 1.1, 1.1)
	mesh_instance.material_override = mat
