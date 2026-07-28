extends StaticBody3D

@export var building_id: int = GWTypes.BuildingId.FOUNDATION
var _preview_mode := false

func _ready() -> void:
	collision_layer = GWConstants.LAYER_BUILDING
	collision_mask = 0
	if building_id == GWTypes.BuildingId.GENERATOR:
		add_to_group("generator")

func set_preview_mode(enabled: bool) -> void:
	_preview_mode = enabled
	collision_layer = 0 if enabled else GWConstants.LAYER_BUILDING
	if enabled:
		_set_transparent(0.5)
	else:
		_set_transparent(1.0)

func _set_transparent(alpha: float) -> void:
	for child in get_children():
		if child is MeshInstance3D:
			var mesh_instance := child as MeshInstance3D
			if mesh_instance.mesh == null:
				continue
			var mat: StandardMaterial3D = mesh_instance.material_override
			if mat == null:
				mat = StandardMaterial3D.new()
				if mesh_instance.get_surface_override_material_count() > 0:
					var surface_mat := mesh_instance.get_surface_override_material(0)
					if surface_mat is StandardMaterial3D:
						mat.albedo_color = (surface_mat as StandardMaterial3D).albedo_color
			mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA if alpha < 1.0 else BaseMaterial3D.TRANSPARENCY_DISABLED
			mat.albedo_color.a = alpha
			mesh_instance.material_override = mat
