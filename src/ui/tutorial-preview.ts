/**
 * Dev-only tutorial harness (tutorial-preview.html, not part of any build input): mounts the Hud, the touch
 * controls and TutorialUi over a fake Training Field and puts a TutorialMachine in a chosen state.
 * Query: ?step=1..12 &source=keyboard|gamepad|touch|xr &mode=1..4 &trigger=1 &hint=1 &armed=0 &prompt=1
 * (`xr` also draws the in-headset card next to the DOM card, laid out like XrPanel).
 */
import { Quaternion, Vector3 } from 'three';
import { DEFAULT_SETTINGS, cloneSettings, type Settings } from '../core/settings';
import { TutorialMachine, type TutorialCtx } from '../game/tutorial';
import { InputManager } from '../input/input-manager';
import { stickRadius } from '../input/touch';
import { XR_CARD_H, XR_CARD_W, layoutCard, xrCardFont } from '../render/xr-panel';
import type { CameraMode, DroneState, FlightMode, InputFrame, InputSource, RaceSnapshot } from '../types';
import { Hud } from './hud';
import { TouchControls } from './touch-controls';
import { TutorialUi } from './tutorial-ui';
import { tutorialView } from './tutorial-prompts';
import { xrTutorialCard } from './xr-hud';

const params = new URLSearchParams(location.search);
const SOURCES: readonly InputSource[] = ['keyboard', 'gamepad', 'touch', 'xr'];
const source = (SOURCES.find((s) => s === params.get('source')) ?? 'keyboard') as InputSource;
const settings: Settings = cloneSettings(DEFAULT_SETTINGS);
const mode = Number(params.get('mode'));
if (mode === 1 || mode === 2 || mode === 3 || mode === 4) settings.stickMode = mode;
if (params.get('trigger') === '1') settings.throttleSource = 'trigger';
const step = Math.max(1, Math.min(12, Number(params.get('step') ?? '1') || 1));
const armed = params.get('armed') !== '0' && step >= 3 && step <= 7;
const log: string[] = [];
const root = document.getElementById('ui')!;

const hud = new Hud(root, () => undefined);
let touchUi: TouchControls | null = null;
if (source === 'touch') {
  const input = new InputManager(window, settings, true);
  touchUi = new TouchControls(root, input.touch, stickRadius(window.innerWidth < 1000));
}

const machine = new TutorialMachine({ storage: null });
const ui = new TutorialUi(root, {
  onStart: () => log.push('start'),
  onSkip: () => log.push('skip'),
  onConfirm: () => log.push('confirm'),
  onFinish: (a) => log.push(`finish:${a}`),
});

const q = new Quaternion();
const ctx = (p: Partial<TutorialCtx> & { heading?: number; vel?: [number, number, number] } = {}): TutorialCtx => {
  q.setFromAxisAngle(new Vector3(0, 1, 0), -((p.heading ?? 0) * Math.PI) / 180);
  const [x, y, z] = p.vel ?? [0, 0, 0];
  return {
    dt: 1 / 60,
    drone: { velocity: { x, y, z }, orientation: { x: q.x, y: q.y, z: q.z, w: q.w } },
    agl: p.agl ?? (armed ? 2 : 0.05),
    armed: p.armed ?? armed,
    flightMode: p.flightMode ?? 'angle',
    cameraMode: p.cameraMode ?? 'los',
    source,
    ringsPassed: p.ringsPassed ?? 0,
    confirm: false,
  };
};
const frames = (n: number, c: (i: number) => TutorialCtx): void => {
  for (let i = 0; i < n; i++) machine.update(c(i));
};

if (params.get('prompt') === '1') {
  ui.showPrompt();
} else if (step === 12) {
  machine.start('angle', 11);
  machine.update(ctx({ ringsPassed: 0 }));
  machine.update(ctx({ ringsPassed: 1 }));
} else {
  machine.start('angle', step);
  // part-way through the step, so bars and sub-goal chips show
  const id = machine.step.id;
  if (id === 'throttle') machine.update(ctx({ agl: 0.8 }));
  if (id === 'hover') frames(90, () => ctx({ agl: 2 }));
  if (id === 'yaw') frames(60, (i) => ctx({ heading: i * 3 }));
  if (id === 'pitch-roll') {
    frames(130, () => ctx({ vel: [0, 0, -2] }));
    frames(60, () => ctx({ vel: [2, 0, 0] }));
  }
  if (id === 'land') frames(10, (i) => ctx({ agl: 2 - i * 0.1 }));
  if (id === 'modes') machine.update(ctx({ flightMode: 'acro' }));
  if (id === 'cameras') ['los', 'fpv'].forEach((c) => machine.update(ctx({ cameraMode: c as CameraMode })));
  if (params.get('hint') === '1') frames(60 * 21, () => ctx({ agl: id === 'hover' ? 4 : id === 'land' ? 1 : armed ? 2 : 0.05, heading: 180, flightMode: id === 'modes' ? 'acro' : 'angle', cameraMode: 'fpv' }));
}

const drone: DroneState = {
  position: new Vector3(0, armed ? 2 : 0.05, 33),
  velocity: new Vector3(),
  orientation: new Quaternion(),
  angularVelocity: new Vector3(),
  motors: [0, 0, 0, 0],
  armed,
  batteryVoltage: 16.4,
};
const race: RaceSnapshot = { status: 'freefly', time: 0, countdown: 0, nextRing: 0, totalRings: 3, bestTime: null, lastSplit: null };
const input: InputFrame = {
  control: { throttle: armed ? 0.5 : 0, yaw: 0, pitch: 0, roll: 0 },
  buttons: { arm: false, toggleMode: false, cycleCamera: false, reset: false, pause: false, confirm: false },
  nav: { up: false, down: false, left: false, right: false, back: false },
  source,
  gamepadId: source === 'gamepad' ? 'Xbox Wireless Controller (STANDARD GAMEPAD)' : null,
  sticks: { lx: 0, ly: armed ? 0 : -1, rx: 0, ry: 0 },
  pad: null,
  xr: null,
};
const flightMode: FlightMode = 'angle';

let xrCanvas: HTMLCanvasElement | null = null;
if (source === 'xr') {
  xrCanvas = document.createElement('canvas');
  xrCanvas.width = XR_CARD_W;
  xrCanvas.height = XR_CARD_H;
  xrCanvas.setAttribute('aria-label', 'In-headset tutorial card');
  Object.assign(xrCanvas.style, { position: 'absolute', right: '16px', bottom: '16px', width: 'min(46vw, 512px)', borderRadius: '12px' });
  document.getElementById('app')!.append(xrCanvas);
}

function drawXr(): void {
  const g = xrCanvas?.getContext('2d');
  if (!g) return;
  const c = xrTutorialCard(tutorialView(machine, 'xr', settings, armed));
  g.clearRect(0, 0, XR_CARD_W, XR_CARD_H);
  g.fillStyle = 'rgba(6, 10, 20, 0.94)';
  g.strokeStyle = 'rgba(120, 220, 255, 0.55)';
  g.lineWidth = 4;
  g.beginPath();
  g.roundRect(4, 4, XR_CARD_W - 8, XR_CARD_H - 8, 36);
  g.fill();
  g.stroke();
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const l of layoutCard(c, (t, w, px) => ((g.font = xrCardFont(w, px)), g.measureText(t).width))) {
    g.fillStyle = l.colour;
    g.font = xrCardFont(l.weight, l.px);
    g.fillText(l.text, XR_CARD_W / 2, l.y);
  }
}

function frame(): void {
  hud.update({ race, drone, input, fps: 60, mode: flightMode, camera: 'los', altitude: drone.position.y, speed: 0, tier: 'high', settings });
  if (touchUi) {
    touchUi.setVisible(true);
    touchUi.update(settings, armed, flightMode, 'los');
  }
  ui.render(machine.phase === 'idle' ? null : tutorialView(machine, source, settings, armed));
  requestAnimationFrame(frame);
}
frame();
drawXr();

declare global {
  interface Window {
    /** Playwright handle (dev harness only) */
    __tutorialPreview?: { log: string[]; machine: TutorialMachine; ui: TutorialUi };
  }
}
window.__tutorialPreview = { log, machine, ui };
