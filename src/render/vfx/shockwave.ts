/** Pooled expanding shockwave rings (ring pass, crash ground-wave, respawn). */
import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec2 vUv;
varying float vY;
varying float vDepth;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vY = wp.y;
  vec4 vp = viewMatrix * wp;
  vDepth = -vp.z;
  gl_Position = projectionMatrix * vp;
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uFloorFade;
varying vec2 vUv;
varying float vY;
varying float vDepth;
void main() {
  // CircleGeometry uv.y is not radial; derive radial position from uv distance to centre
  float r = length(vUv - 0.5) * 2.0;
  float band = smoothstep(0.8, 0.93, r) * (1.0 - smoothstep(0.95, 1.0, r));
  float inner = smoothstep(0.35, 0.93, r) * 0.1;
  // soften where the wave slices into the floor
  // and where it sweeps past the camera (a full-screen wash otherwise)
  float nearFade = smoothstep(0.3, 1.4, vDepth);
  gl_FragColor = vec4(uColor * 2.5, (band + inner) * uAlpha * nearFade * mix(1.0, smoothstep(0.0, 0.35, vY + 0.02), uFloorFade));
  #include <colorspace_fragment>
}`;

interface Wave {
  mesh: THREE.Mesh<THREE.CircleGeometry, THREE.ShaderMaterial>;
  age: number;
  duration: number;
  from: number;
  to: number;
}

const _z = new THREE.Vector3(0, 0, 1);

export class Shockwaves {
  readonly group = new THREE.Group();
  private readonly waves: Wave[] = [];
  private readonly geometry = new THREE.CircleGeometry(1, 72);
  private next = 0;

  constructor(count = 6) {
    for (let i = 0; i < count; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color() }, uAlpha: { value: 0 }, uFloorFade: { value: 1 } },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this.geometry, mat);
      mesh.visible = false;
      mesh.renderOrder = 4;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.waves.push({ mesh, age: 1, duration: 1, from: 0, to: 1 });
    }
  }

  /** Spawn a wave at `pos` facing `normal`, radius from→to over `duration` seconds. */
  spawn(pos: THREE.Vector3, normal: THREE.Vector3, color: THREE.Color, from: number, to: number, duration: number): void {
    const w = this.waves[this.next];
    this.next = (this.next + 1) % this.waves.length;
    w.mesh.position.copy(pos);
    w.mesh.quaternion.setFromUnitVectors(_z, normal);
    w.mesh.material.uniforms.uColor.value.copy(color);
    w.mesh.material.uniforms.uFloorFade.value = Math.abs(normal.y) > 0.9 ? 0 : 1;
    w.age = 0;
    w.duration = duration;
    w.from = from;
    w.to = to;
    w.mesh.visible = true;
  }

  update(dt: number): void {
    for (const w of this.waves) {
      if (!w.mesh.visible) continue;
      w.age += dt / w.duration;
      if (w.age >= 1) {
        w.mesh.visible = false;
        continue;
      }
      const e = 1 - Math.pow(1 - w.age, 3);
      w.mesh.scale.setScalar(w.from + (w.to - w.from) * e);
      w.mesh.material.uniforms.uAlpha.value = (1 - w.age) * (1 - w.age);
    }
  }

  dispose(): void {
    this.geometry.dispose();
    for (const w of this.waves) w.mesh.material.dispose();
  }
}
