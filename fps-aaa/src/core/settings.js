// Runtime tunables + quality presets. Persisted to localStorage.

const KEY = 'fps-aaa.settings.v1';

const defaults = {
	sensitivity: 0.0022,
	adsSensitivityScale: 0.62,
	fov: 82,
	adsFovScale: 0.72,
	invertY: false,
	masterVolume: 0.85,
	sfxVolume: 1.0,
	musicVolume: 0.5,
	quality: 'high', // low | medium | high
	showFps: true,
	motionBlurStrength: 0.55,
	crosshairScale: 1.0,
};

export const QUALITY = {
	low: {
		pixelRatioCap: 1.0,
		shadowMapSize: 1024,
		shadowsEnabled: true,
		bloom: true,
		ssao: false,
		particleScale: 0.5,
		decalLimit: 40,
		anisotropy: 2,
	},
	medium: {
		pixelRatioCap: 1.35,
		shadowMapSize: 2048,
		shadowsEnabled: true,
		bloom: true,
		ssao: false,
		particleScale: 0.85,
		decalLimit: 90,
		anisotropy: 4,
	},
	high: {
		pixelRatioCap: 1.75,
		shadowMapSize: 2048,
		shadowsEnabled: true,
		bloom: true,
		ssao: true,
		particleScale: 1.0,
		decalLimit: 160,
		anisotropy: 8,
	},
};

function load() {
	try {
		const raw = localStorage.getItem( KEY );
		if ( ! raw ) return { ...defaults };
		return { ...defaults, ...JSON.parse( raw ) };
	} catch ( e ) {
		return { ...defaults };
	}
}

export const settings = load();

export function saveSettings() {
	try { localStorage.setItem( KEY, JSON.stringify( settings ) ); } catch ( e ) { /* ignore */ }
}

export function qualityPreset() {
	return QUALITY[ settings.quality ] || QUALITY.high;
}

export default settings;
