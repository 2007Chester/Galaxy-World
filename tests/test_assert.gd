class_name TestAssert
extends RefCounted

static var failures: int = 0
static var passed: int = 0

static func reset() -> void:
	failures = 0
	passed = 0

static func eq(actual, expected, label: String) -> void:
	if actual == expected:
		passed += 1
	else:
		failures += 1
		push_error("[FAIL] %s: expected=%s got=%s" % [label, str(expected), str(actual)])

static func true_(condition: bool, label: String) -> void:
	if condition:
		passed += 1
	else:
		failures += 1
		push_error("[FAIL] %s" % label)

static func false_(condition: bool, label: String) -> void:
	true_(not condition, label)

static func gt(actual, minimum, label: String) -> void:
	if actual > minimum:
		passed += 1
	else:
		failures += 1
		push_error("[FAIL] %s: expected > %s got %s" % [label, str(minimum), str(actual)])

static func summary() -> void:
	print("Tests passed: %d, failed: %d" % [passed, failures])
