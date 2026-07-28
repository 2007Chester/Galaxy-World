extends Node3D

@export var planet_seed: int = 42

@onready var terrain_mesh: MeshInstance3D = $TerrainMesh
@onready var terrain_body: StaticBody3D = $TerrainBody
@onready var sun: DirectionalLight3D = $Sun
@onready var sky_env: WorldEnvironment = $WorldEnvironment
@onready var decorations: Node3D = $Decorations
@onready var resource_spawner: Node3D = $ResourceSpawner
@onready var wreckage_spawner: Node3D = $WreckageSpawner

var _day_time := 0.0

const RESOURCE_SCENE := preload("res://scenes/world/resource_node.tscn")
const WRECKAGE_SCENE := preload("res://scenes/world/wreckage.tscn")

func _ready() -> void:
	if GameManager.game_started:
		planet_seed = GameManager.planet_config.seed
	_generate_terrain()
	_position_escape_pod()
	_spawn_resources()
	_spawn_wreckage()
	_create_sky_decor()

func _position_escape_pod() -> void:
	var pod: Node3D = $EscapePod
	if pod == null:
		return
	var h := get_surface_height(0.0, 0.0)
	pod.position = Vector3(0.0, h + 1.6, 0.0)
	GameManager.set_spawn(pod.position)

func _process(delta: float) -> void:
	_day_time += delta * 0.05
	var angle := _day_time * TAU
	sun.rotation = Vector3(-0.6 + sin(angle) * 0.3, angle, 0.0)
	sun.light_energy = 0.8 + maxf(sin(angle), 0.0) * 0.6

func get_surface_height(world_x: float, world_z: float) -> float:
	return PlanetGenerator.get_height_at(planet_seed, world_x, world_z, GWConstants.TERRAIN_HEIGHT)

func _generate_terrain() -> void:
	var mesh := PlanetGenerator.generate_mesh(
		planet_seed,
		GWConstants.PLANET_SIZE,
		GWConstants.PLANET_SCALE,
		GWConstants.TERRAIN_HEIGHT
	)
	terrain_mesh.mesh = mesh
	var mat := StandardMaterial3D.new()
	mat.vertex_color_use_as_albedo = true
	mat.roughness = 0.9
	terrain_mesh.material_override = mat

	var shape := PlanetGenerator.create_collision_shape(mesh)
	terrain_body.collision_layer = GWConstants.LAYER_WORLD
	terrain_body.collision_mask = 0
	var col := CollisionShape3D.new()
	col.shape = shape
	terrain_body.add_child(col)

func _spawn_resources() -> void:
	var rng := RandomNumberGenerator.new()
	rng.seed = planet_seed
	var types := [
		GWTypes.ItemId.STONE,
		GWTypes.ItemId.IRON,
		GWTypes.ItemId.COPPER,
		GWTypes.ItemId.SILICON,
		GWTypes.ItemId.ORGANIC,
	]
	for i in range(40):
		var x := rng.randf_range(-60, 60)
		var z := rng.randf_range(-60, 60)
		var y := get_surface_height(x, z)
		var node: Node3D = RESOURCE_SCENE.instantiate()
		node.position = Vector3(x, y + 0.5, z)
		node.setup(types[i % types.size()], rng.randi_range(2, 5))
		resource_spawner.add_child(node)

func _spawn_wreckage() -> void:
	var positions := [
		Vector3(15, 0, 10),
		Vector3(-20, 0, 25),
		Vector3(30, 0, -15),
		Vector3(-10, 0, -30),
		Vector3(45, 0, 35),
	]
	for i in range(positions.size()):
		var pos: Vector3 = positions[i]
		pos.y = get_surface_height(pos.x, pos.z) + 0.3
		var wreck: Node3D = WRECKAGE_SCENE.instantiate()
		wreck.position = pos
		wreck.setup(i == 0)
		wreckage_spawner.add_child(wreck)

func _create_sky_decor() -> void:
	var anomaly := MeshInstance3D.new()
	var sphere := SphereMesh.new()
	sphere.radius = 3.0
	sphere.height = 6.0
	anomaly.mesh = sphere
	anomaly.position = Vector3(-40, 35, -50)
	var amat := StandardMaterial3D.new()
	amat.albedo_color = Color(0.4, 0.2, 1.0)
	amat.emission_enabled = true
	amat.emission = Color(0.5, 0.3, 1.0)
	amat.emission_energy_multiplier = 2.0
	anomaly.material_override = amat
	decorations.add_child(anomaly)

	var ring := MeshInstance3D.new()
	var torus := TorusMesh.new()
	torus.inner_radius = 18.0
	torus.outer_radius = 22.0
	ring.mesh = torus
	ring.position = Vector3(0, 60, -80)
	ring.rotation_degrees = Vector3(70, 0, 15)
	var rmat := StandardMaterial3D.new()
	rmat.albedo_color = Color(0.7, 0.75, 0.85, 0.6)
	rmat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	rmat.emission_enabled = true
	rmat.emission = Color(0.3, 0.4, 0.6)
	rmat.emission_energy_multiplier = 0.5
	ring.material_override = rmat
	decorations.add_child(ring)

func raycast_surface(from: Vector3, to: Vector3) -> Dictionary:
	var space := get_world_3d().direct_space_state
	var query := PhysicsRayQueryParameters3D.create(from, to)
	query.collision_mask = GWConstants.LAYER_WORLD
	var result := space.intersect_ray(query)
	return result
