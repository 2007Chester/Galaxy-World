extends Node

var stats := GWTypes.SuitStats.new()
var _mining_active := false

func _ready() -> void:
	reset_stats()
	EventBus.player_died.connect(_on_player_died)

func _process(delta: float) -> void:
	if GameManager.state != GWTypes.GameState.PLAYING:
		return
	if not GameManager.is_survival():
		return
	stats.oxygen -= GWConstants.SUIT_O2_DRAIN_IDLE * delta
	stats.energy = maxf(stats.energy - 0.2 * delta, 0.0)
	_check_limits()
	_emit_stats()

func notify_movement(sprinting: bool, delta: float) -> void:
	if not GameManager.is_survival():
		return
	var o2_rate := GWConstants.SUIT_O2_DRAIN_MOVE
	var en_rate := GWConstants.SUIT_ENERGY_DRAIN_MOVE
	if sprinting:
		o2_rate *= 1.5
		en_rate *= 1.8
	stats.oxygen -= o2_rate * delta
	stats.energy -= en_rate * delta
	_check_limits()

func notify_mining(delta: float) -> void:
	if not GameManager.is_survival():
		return
	_mining_active = true
	stats.oxygen -= GWConstants.SUIT_O2_DRAIN_MINE * delta
	stats.energy -= GWConstants.SUIT_ENERGY_DRAIN_MINE * delta
	_check_limits()

func restore_oxygen(amount: float) -> void:
	stats.oxygen = minf(stats.oxygen + amount, 100.0)
	_emit_stats()

func restore_energy(amount: float) -> void:
	stats.energy = minf(stats.energy + amount, 100.0)
	_emit_stats()

func take_damage(amount: float) -> void:
	stats.health -= amount
	EventBus.player_damaged.emit(amount)
	_check_limits()

func reset_stats() -> void:
	stats.reset()
	_emit_stats()

func _check_limits() -> void:
	stats.oxygen = maxf(stats.oxygen, 0.0)
	stats.energy = maxf(stats.energy, 0.0)
	if stats.oxygen <= 0.0 or stats.health <= 0.0:
		EventBus.player_died.emit()

func _on_player_died() -> void:
	var player := get_parent()
	if player and player.has_method("respawn"):
		await get_tree().create_timer(1.5).timeout
		player.respawn()

func _emit_stats() -> void:
	EventBus.suit_stats_changed.emit({
		"oxygen": stats.oxygen,
		"energy": stats.energy,
		"health": stats.health,
		"temperature": stats.temperature,
	})
