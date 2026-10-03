/**
 * Drone-only PBR materials. Static parts merge into few draw calls: carbon (weave maps) and one
 * vertex-coloured hard-surface material whose atlas swatches give each part its own roughness,
 * metalness and clearcoat. The FPV lens has its own glass; props are a patched instanced material.
 */
import * as THREE from 'three';
import { carbonWeave, hardSurfaceAtlas } from './textures';

const PROP_VERT_PARS = /* glsl */ `
attribute float aMirror;
attribute float aFade;
varying float vMirror;
varying float vFade;
`;

/**
 * Prop material: per-instance mirror (CW props reuse the CCW blade, mirrored across the blade plane
 * in the vertex shader, with the face direction corrected so lighting stays right) and per-instance
 * fade (blades thin out as the blur disc takes over at high rpm). One draw call for all four props.
 */
function propMaterial(lite: boolean): THREE.MeshPhysicalMaterial | THREE.MeshStandardMaterial {
  const params = {
    color: 0xffffff,
    roughness: 0.22,
    metalness: 0,
    transparent: true,
    opacity: 0.92,
    side: THREE.DoubleSide,
    emissive: new THREE.Color(0x0c0c0c),
  };
  const mat = lite ? new THREE.MeshStandardMaterial(params) : new THREE.MeshPhysicalMaterial({ ...params, clearcoat: 1, clearcoatRoughness: 0.08, specularIntensity: 0.8 });
  mat.forceSinglePass = true;
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${PROP_VERT_PARS}`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3( normal ); objectNormal.z *= aMirror;\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3( tangent.xyz );\n#endif')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.z *= aMirror;\nvMirror = aMirror;\nvFade = aFade;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vMirror;\nvarying float vFade;')
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '( gl_FrontFacing ? 1.0 : - 1.0 ) * vMirror'))
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vFade;');
  };
  mat.customProgramCacheKey = () => (lite ? 'drone-prop-lite' : 'drone-prop');
  return mat;
}

export class DroneMaterials {
  readonly carbon: THREE.MeshPhysicalMaterial;
  /** vertex colours × atlas swatches: TPU, plastics, rubber, PCB, anodized metal, steel, copper, glass */
  readonly hard: THREE.MeshPhysicalMaterial;
  /** LOD1 / low tier: the same atlas on a standard material (no clearcoat, no normal maps) */
  readonly lite: THREE.MeshStandardMaterial;
  readonly lens: THREE.MeshPhysicalMaterial;
  readonly prop: THREE.MeshPhysicalMaterial | THREE.MeshStandardMaterial;
  readonly propLite: THREE.MeshPhysicalMaterial | THREE.MeshStandardMaterial;
  private readonly textures: THREE.Texture[] = [];
  private readonly all: THREE.Material[] = [];

  constructor(anisotropy = 4) {
    const cf = carbonWeave();
    const atlas = hardSurfaceAtlas();
    for (const t of [cf.map, cf.normalMap, cf.roughnessMap]) {
      t.anisotropy = Math.min(8, anisotropy);
      this.textures.push(t);
    }
    atlas.map.anisotropy = Math.min(4, anisotropy);
    this.textures.push(atlas.map, atlas.orm);
    this.carbon = new THREE.MeshPhysicalMaterial({
      name: 'drone-carbon',
      map: cf.map,
      normalMap: cf.normalMap,
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughnessMap: cf.roughnessMap,
      roughness: 1,
      metalness: 0.15,
      clearcoat: 1,
      clearcoatRoughness: 0.07,
      specularIntensity: 0.7,
      envMapIntensity: 1.25,
    });
    this.hard = new THREE.MeshPhysicalMaterial({
      name: 'drone-hard',
      vertexColors: true,
      map: atlas.map,
      roughnessMap: atlas.orm,
      metalnessMap: atlas.orm,
      clearcoatMap: atlas.orm,
      roughness: 1,
      metalness: 1,
      clearcoat: 1,
      clearcoatRoughness: 0.12,
      envMapIntensity: 1.2,
    });
    this.lite = new THREE.MeshStandardMaterial({
      name: 'drone-lite',
      vertexColors: true,
      map: atlas.map,
      roughnessMap: atlas.orm,
      metalnessMap: atlas.orm,
      roughness: 1,
      // no env map on the low tier: full metals would read black, so they keep a little diffuse
      metalness: 0.6,
    });
    this.lens = new THREE.MeshPhysicalMaterial({
      name: 'drone-lens',
      color: 0x04060b,
      roughness: 0.015,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0,
      ior: 1.75,
      specularIntensity: 1,
      iridescence: 1,
      iridescenceIOR: 1.9,
      iridescenceThicknessRange: [280, 620],
      envMapIntensity: 2.6,
    });
    this.prop = propMaterial(false);
    this.propLite = propMaterial(true);
    this.all.push(this.carbon, this.hard, this.lite, this.lens, this.prop, this.propLite);
  }

  dispose(): void {
    for (const m of this.all) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}
