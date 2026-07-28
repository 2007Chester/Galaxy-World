const SAVE_KEY = "galaxy-world-save-v1";

export function hasSave() {
  return !!loadSave();
}

export function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || data.version !== 1 || typeof data.homeSeed !== "number") return null;
    return data;
  } catch {
    return null;
  }
}

export function writeSave(data) {
  const payload = {
    ...data,
    version: 1,
    updatedAt: Date.now(),
  };
  localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
  return payload;
}

export function clearSave() {
  localStorage.removeItem(SAVE_KEY);
}

export function createNewWorldSave({ name, seed } = {}) {
  const homeSeed = seed ?? ((Math.random() * 1e9) | 0);
  const worldName = (name && name.trim()) || `Сектор-${String(homeSeed).slice(-4)}`;
  const now = Date.now();
  return writeSave({
    version: 1,
    worldName,
    homeSeed,
    seed: homeSeed,
    planetIndex: 0,
    mode: "planet",
    createdAt: now,
    updatedAt: now,
    played: false,
    inventory: {
      slots: Array.from({ length: 28 }, () => ({ itemId: -1, amount: 0 })),
      equippedTool: -1,
      tankLevel: 0,
    },
    player: null,
    triggers: {
      mine: false,
      craft: false,
      build: false,
      aurora: false,
      hangar: false,
      ship: false,
    },
    planets: {
      0: {
        seed: homeSeed,
        harvested: [],
        explored: [],
        buildings: [],
        ships: [],
      },
    },
  });
}

export function formatSaveSummary(data) {
  if (!data) return "Мир ещё не сгенерирован";
  const when = data.updatedAt
    ? new Date(data.updatedAt).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
  const status = data.played ? "можно продолжить" : "готов к первому входу";
  return `${data.worldName} · seed ${data.homeSeed} · планета #${data.planetIndex ?? 0} · ${status} · ${when}`;
}
