import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { Sky } from "three/addons/objects/Sky.js";

/** Cinematic color grade + vignette + light film grain */
const ColorGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uExposure: { value: 1.02 },
    uContrast: { value: 1.07 },
    uSaturation: { value: 1.12 },
    uVignette: { value: 0.34 },
    uWarmth: { value: 0.035 },
    uTime: { value: 0 },
    uGrain: { value: 0.03 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uExposure;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uVignette;
    uniform float uWarmth;
    uniform float uTime;
    uniform float uGrain;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 col = tex.rgb * uExposure;
      col = (col - 0.5) * uContrast + 0.5;
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSaturation);
      col.r += uWarmth;
      col.b -= uWarmth * 0.55;
      float d = distance(vUv, vec2(0.5));
      col *= 1.0 - smoothstep(0.38, 0.98, d) * uVignette;
      float g = hash(vUv * vec2(1600.0, 900.0) + fract(uTime) * 17.0) - 0.5;
      col += g * uGrain;
      gl_FragColor = vec4(col, tex.a);
    }
  `,
};

export function setupRenderer(renderer) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}

export function createPostPipeline(renderer, scene, camera) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  composer.setSize(w, h);

  composer.addPass(new RenderPass(scene, camera));

  const bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.24, 0.48, 0.88);
  composer.addPass(bloomPass);

  const gradePass = new ShaderPass(ColorGradeShader);
  composer.addPass(gradePass);

  composer.addPass(new OutputPass());
  composer.addPass(new SMAAPass());

  return { composer, bloomPass, gradePass };
}

export function resizePostPipeline(pipeline, w, h) {
  pipeline.composer.setSize(w, h);
  if (pipeline.bloomPass?.resolution) pipeline.bloomPass.resolution.set(w, h);
}

export function createSky(scene) {
  const sky = new Sky();
  sky.scale.setScalar(450000);
  sky.name = "pbrSky";
  sky.renderOrder = -1000;
  scene.add(sky);
  const u = sky.material.uniforms;
  u.turbidity.value = 2.6;
  u.rayleigh.value = 1.7;
  u.mieCoefficient.value = 0.004;
  u.mieDirectionalG.value = 0.9;
  return sky;
}

export function configureSunLight(sun) {
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.00012;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 2.5;
  const d = 68;
  sun.shadow.camera.left = -d;
  sun.shadow.camera.right = d;
  sun.shadow.camera.top = d;
  sun.shadow.camera.bottom = -d;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 200;
  sun.shadow.camera.updateProjectionMatrix();
}

/**
 * Bake sky-only environment map for PBR reflections on materials.
 */
export function bakeSkyEnvironment(renderer, sky, scene, cache) {
  if (!cache.pmrem) {
    cache.pmrem = new THREE.PMREMGenerator(renderer);
    cache.pmrem.compileEquirectangularShader();
  }
  const tmp = new THREE.Scene();
  const parent = sky.parent;
  if (parent) parent.remove(sky);
  tmp.add(sky);

  if (cache.envRT) {
    cache.envRT.dispose();
    cache.envRT = null;
  }
  try {
    cache.envRT = cache.pmrem.fromScene(tmp);
    scene.environment = cache.envRT.texture;
    if ("environmentIntensity" in scene) scene.environmentIntensity = 0.95;
  } catch {
    /* weak GPU */
  }

  tmp.remove(sky);
  if (parent) parent.add(sky);
  else scene.add(sky);
}

export function setSunFromAngles(sky, sunLight, elevation, azimuth) {
  const phi = Math.PI / 2 - elevation;
  const dir = new THREE.Vector3().setFromSphericalCoords(1, phi, azimuth);
  sky.material.uniforms.sunPosition.value.copy(dir);
  if (sunLight) {
    sunLight.position.copy(dir).multiplyScalar(80);
    sunLight.target.position.set(0, 0, 0);
  }
  return dir;
}
