extends Node

@onready var ray: RayCast3D = $"../Camera3D/MineRay"

var _cooldown := 0.0

func try_mine(delta: float) -> void:
	_cooldown -= delta
	if _cooldown > 0.0:
		return
	ray.force_raycast_update()
	if not ray.is_colliding():
		return
	var collider := ray.get_collider()
	if collider and collider.is_in_group("resource_node") and collider.has_method("take_damage"):
		collider.take_damage(GWConstants.MINE_DAMAGE)
		var suit := get_parent().get_node_or_null("SuitSystem")
		if suit:
			suit.notify_mining(delta)
		_cooldown = 0.25
