extends CharacterBody3D

@onready var camera: Camera3D = $Camera3D
@onready var suit_system: Node = $SuitSystem
@onready var mining_tool: Node = $MiningTool
@onready var interact_ray: RayCast3D = $Camera3D/InteractRay

var gravity: float = ProjectSettings.get_setting("physics/3d/default_gravity")
var _mouse_captured := true

func _ready() -> void:
	add_to_group("player")
	collision_layer = GWConstants.LAYER_PLAYER
	collision_mask = GWConstants.LAYER_WORLD | GWConstants.LAYER_RESOURCE | GWConstants.LAYER_BUILDING
	Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
	if GameManager.spawn_position != Vector3.ZERO:
		global_position = GameManager.spawn_position + Vector3(0, 1.5, 0)

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseMotion and _mouse_captured:
		rotate_y(-event.relative.x * GWConstants.MOUSE_SENSITIVITY)
		camera.rotate_x(-event.relative.y * GWConstants.MOUSE_SENSITIVITY)
		camera.rotation.x = clampf(camera.rotation.x, -1.4, 1.4)
	if event.is_action_pressed("cancel"):
		if _mouse_captured:
			Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
			_mouse_captured = false
		else:
			Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
			_mouse_captured = true

func _physics_process(delta: float) -> void:
	if not is_on_floor():
		velocity.y -= gravity * delta

	var input_dir := Input.get_vector("move_left", "move_right", "move_forward", "move_back")
	var direction := (transform.basis * Vector3(input_dir.x, 0, input_dir.y)).normalized()
	var speed := GWConstants.PLAYER_SPEED
	var sprinting := Input.is_action_pressed("sprint")
	if sprinting:
		speed *= GWConstants.PLAYER_SPRINT_MULT

	if direction:
		velocity.x = direction.x * speed
		velocity.z = direction.z * speed
		if suit_system:
			suit_system.notify_movement(sprinting, delta)
	else:
		velocity.x = move_toward(velocity.x, 0, speed)
		velocity.z = move_toward(velocity.z, 0, speed)

	if Input.is_action_just_pressed("jump") and is_on_floor():
		velocity.y = GWConstants.PLAYER_JUMP_VELOCITY

	move_and_slide()

	if Input.is_action_pressed("mine") and mining_tool and not _is_build_mode_active():
		mining_tool.try_mine(delta)

	if Input.is_action_just_pressed("interact"):
		_try_interact()

func _try_interact() -> void:
	interact_ray.force_raycast_update()
	if not interact_ray.is_colliding():
		return
	var collider := interact_ray.get_collider()
	if collider and collider.has_method("interact"):
		collider.interact(self)

func respawn() -> void:
	global_position = GameManager.spawn_position + Vector3(0, 1.5, 0)
	velocity = Vector3.ZERO
	if suit_system:
		suit_system.reset_stats()
	EventBus.player_respawned.emit()

func apply_generator_o2(amount: float) -> void:
	if suit_system:
		suit_system.restore_oxygen(amount)

func _is_build_mode_active() -> bool:
	var bs := get_tree().get_first_node_in_group("building_system")
	if bs and "build_mode_active" in bs:
		return bs.build_mode_active
	return false
