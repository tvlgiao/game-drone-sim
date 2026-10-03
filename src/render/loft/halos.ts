/**
 * Camera-facing glow halos around exposed lamps (one instanced draw). They carry the "hot bulb" read on
 * tiers without bloom (Quest, low) and are dimmed under bloom so the two do not stack.
 */
import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
varying float vFade;
void main() {
  vUv = uv;
  vColor = instanceColor;
  vec4 center = modelViewMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
  float size = length( instanceMatrix[ 0 ].xyz );
  // close to the eye the halo would cover the view: fade it out
  float depth = -center.z;
  vFade = smoothstep( 0.25, 1.2, depth );
  center.xy += position.xy * size;
  gl_Position = projectionMatrix * center;
}`;

const FRAG = /* glsl */ `
uniform float uIntensity;
varying vec2 vUv;
varying vec3 vColor;
varying float vFade;
void main() {
  float d = length( vUv - 0.5 ) * 2.0;
  float a = ( exp( -d * d * 6.0 ) * 0.55 + exp( -d * d * 40.0 ) * 0.45 ) * ( 1.0 - smoothstep( 0.85, 1.0, d ) );
  gl_FragColor = vec4( vColor * a * vFade * uIntensity, 1.0 );
  #include <colorspace_fragment>
}`;

export class Halos {
  readonly mesh: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;

  constructor(lamps: readonly { position: THREE.Vector3; size: number; color: THREE.Color }[]) {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uIntensity: { value: 1 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, lamps.length));
    this.mesh.count = lamps.length;
    const m = new THREE.Matrix4();
    lamps.forEach((l, i) => {
      m.makeScale(l.size, l.size, l.size).setPosition(l.position);
      this.mesh.setMatrixAt(i, m);
      this.mesh.setColorAt(i, l.color);
    });
    this.mesh.name = 'lamp-halos';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
  }

  /** bloom already blooms the filaments: keep only a faint halo then */
  setBloom(bloom: boolean): void {
    this.mesh.material.uniforms.uIntensity.value = bloom ? 0.35 : 0.9;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }
}
