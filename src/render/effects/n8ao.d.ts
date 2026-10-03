/** Minimal typings for n8ao (the package ships none); only the post-processing pass is used. */
declare module 'n8ao' {
  import type { Camera, Scene } from 'three';
  import type { Pass } from 'postprocessing';

  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
  }
}
