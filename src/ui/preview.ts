/**
 * Standalone UI preview (ui-preview.html): mounts the Hud over a fake scene, drives it with a real
 * RaceController following a scripted path through the loft rings, real InputManager + GameAudio.
 * Query: ?screen=main|settings|controller|rates|controls|pause|finish|hud|freefly|disarmed|error (&nonstd=1: fake non-standard pad)
 */
import { Quaternion, Vector3 } from 'three';
import { loadSettings, saveSettings, type Settings } from '../core/settings';
import { LOFT_LEVEL } from '../game/level-data';
import { RaceController } from '../game/race';
import { InputManager } from '../input/input-manager';
import { mapSticks } from '../input/stick';
import { GameAudio } from '../audio/audio';
import type { CameraMode, DroneState, FlightMode, GameEvent, InputFrame } from '../types';
import { Hud, type UiAction } from './hud';

const level = LOFT_LEVEL;
const root = document.getElementById('ui')!;
let settings: Settings = loadSettings();
const race = new RaceController(level);
const input = new InputManager(window, settings);
const audio = new GameAudio();
audio.setVolume(settings.volume);

let mode: FlightMode = settings.flightMode;
let camera: CameraMode = 'fpv';
const CAMS: CameraMode[] = ['fpv', 'chase', 'los'];

const drone: DroneState = {
  position: new Vector3(...level.spawn.position),
  velocity: new Vector3(),
  orientation: new Quaternion(),
  angularVelocity: new Vector3(),
  motors: [0, 0, 0, 0],
  armed: false,
  batteryVoltage: 16.8,
};

// Scripted path: spawn → (approach, exit) of every ring in order.
const path: Vector3[] = [new Vector3(...level.spawn.position).setY(1.2)];
for (const r of level.rings) {
  const c = new Vector3(...r.position);
  const d = new Vector3(...r.direction);
  path.push(c.clone().addScaledVector(d, -1.4), c.clone().addScaledVector(d, 1.4));
}
let seg = 0;
let segT = 0;
const FLY_SPEED = 7.5;
const prevPos = new Vector3();
const lastPos = new Vector3().copy(drone.position);

const hud = new Hud(root, onAction);
input.onConnection = (e) => hud.toast(e.connected ? `Controller connected: ${e.name}` : `Controller disconnected: ${e.name}`);

function onAction(a: UiAction): void {
  void audio.resume();
  switch (a.type) {
    case 'race':
    case 'retry':
      hud.showScreen('none');
      race.startRace();
      break;
    case 'freefly':
      hud.showScreen('none');
      race.startFreeFly();
      break;
    case 'resume':
      hud.showScreen('none');
      race.resume();
      audio.setMotorsMuted(false);
      break;
    case 'menu':
      race.toMenu();
      hud.showScreen('main', { best: race.snapshot().bestTime });
      break;
    case 'settings':
      settings = a.settings;
      saveSettings(settings);
      input.updateSettings(settings);
      audio.setVolume(settings.volume);
      mode = settings.flightMode;
      break;
  }
}

function resetPath(): void {
  seg = 0;
  segT = 0;
  drone.position.set(...level.spawn.position);
  drone.velocity.set(0, 0, 0);
}

function handle(e: GameEvent): void {
  audio.handleEvent(e);
  hud.handleEvent(e);
  if (e.type === 'respawn') {
    const p = race.respawnPoint();
    if (race.snapshot().nextRing <= 0) resetPath();
    else drone.position.copy(p.position);
  } else if (e.type === 'race-start') {
    drone.armed = true;
  } else if (e.type === 'ring-passed') {
    input.rumble(0.2, 0.5, 90);
  } else if (e.type === 'race-finish') {
    hud.showScreen('finish', { time: e.time, best: race.snapshot().bestTime, newBest: e.best });
  }
}

/** Advances the fake drone along the path; returns true while moving. */
function flyScript(dt: number): void {
  if (seg >= path.length - 1) {
    if (race.snapshot().status === 'freefly') {
      seg = 0;
      segT = 0;
    } else return;
  }
  const a = path[seg]!;
  const b = path[seg + 1]!;
  const len = Math.max(1e-3, a.distanceTo(b));
  segT += (FLY_SPEED * dt) / len;
  if (segT >= 1) {
    segT = 0;
    seg++;
  }
  drone.position.lerpVectors(a, b, Math.min(1, segT));
}

// Fake gamepad when no real input device is in use, so the visualiser / controller setup can be seen.
const params = new URLSearchParams(location.search);
const fakeAxes = [0, 0, 0, 0, -1, -1];
const fakeButtons = new Array<number>(17).fill(0);
const fakeInput: InputFrame = {
  control: { throttle: 0, yaw: 0, pitch: 0, roll: 0 },
  buttons: { arm: false, toggleMode: false, cycleCamera: false, reset: false, pause: false, confirm: false },
  nav: { up: false, down: false, left: false, right: false, back: false },
  source: 'gamepad',
  gamepadId: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
  sticks: { lx: 0, ly: 0, rx: 0, ry: 0 },
  pad: {
    id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
    mapping: params.has('nonstd') ? '' : 'standard',
    axes: fakeAxes,
    buttons: fakeButtons,
  },
  xr: null,
};
const fakeRaw = { lx: 0, ly: 0, rx: 0, ry: 0 };

function fakePad(time: number): void {
  // Circular sweeps that hit the round gate edge, plus a throttle stick sweeping full range.
  const a = time * 1.1;
  fakeAxes[0] = 0.95 * Math.cos(a);
  fakeAxes[1] = 0.95 * Math.sin(a);
  fakeAxes[2] = 0.7071 * Math.sign(Math.sin(time * 0.6)) || 0.7071;
  fakeAxes[3] = -0.7071;
  fakeAxes[4] = -1 + 0.3 * (1 + Math.sin(time * 2));
  fakeButtons[0] = Math.sin(time * 3) > 0.7 ? 1 : 0;
  fakeButtons[7] = 0.5 + 0.5 * Math.sin(time * 0.8);
  const am = settings.axisMap;
  fakeRaw.lx = fakeAxes[am.lx] ?? 0;
  fakeRaw.ly = -(fakeAxes[am.ly] ?? 0);
  fakeRaw.rx = fakeAxes[am.rx] ?? 0;
  fakeRaw.ry = -(fakeAxes[am.ry] ?? 0);
  mapSticks(fakeRaw, fakeButtons[7]!, settings, fakeInput.sticks, fakeInput.control, true);
}

let fps = 120;
let last = performance.now();
let t = 0;

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  t += dt;
  fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;

  const inp = input.poll(dt);
  if (hud.screen !== 'none') {
    hud.navigate(inp.nav, inp.buttons.confirm);
  } else {
    const st = race.snapshot().status;
    if (inp.buttons.pause && st !== 'menu' && st !== 'finished') {
      race.pause();
      audio.setMotorsMuted(true);
      hud.showScreen('pause');
    }
    if (inp.buttons.arm) {
      drone.armed = !drone.armed;
      handle({ type: 'armed', armed: drone.armed });
    }
    if (inp.buttons.toggleMode) {
      mode = mode === 'acro' ? 'angle' : 'acro';
      settings = { ...settings, flightMode: mode };
      hud.setSettings(settings);
    }
    if (inp.buttons.cycleCamera) camera = CAMS[(CAMS.indexOf(camera) + 1) % CAMS.length]!;
    if (inp.buttons.reset) race.requestReset();
  }

  const status = race.snapshot().status;
  prevPos.copy(drone.position);
  if ((status === 'racing' || status === 'freefly') && drone.armed) flyScript(dt);
  for (const e of race.step(dt, prevPos, drone, [])) handle(e);

  const speed = dt > 0 ? drone.position.distanceTo(lastPos) / dt : 0;
  lastPos.copy(drone.position);
  const shown = inp.source === 'none' ? fakeInput : inp;
  if (inp.source === 'none') fakePad(t);
  const thr = drone.armed ? 0.35 + 0.25 * Math.abs(Math.sin(t * 2)) : 0;
  for (let i = 0; i < 4; i++) drone.motors[i] = drone.armed ? thr + 0.04 * Math.sin(t * 7 + i) : Math.max(0, drone.motors[i]! - dt * 2);
  drone.batteryVoltage = Math.max(14, 16.8 - t * 0.01 - thr * 0.4);
  audio.update(drone.motors, drone.armed, speed);

  hud.update({
    race: race.snapshot(),
    drone,
    input: shown,
    fps,
    mode,
    camera,
    altitude: drone.position.y,
    speed,
    tier: 'high',
    settings,
  });
  requestAnimationFrame(frame);
}

const wake = (): void => void audio.resume();
window.addEventListener('pointerdown', wake);
window.addEventListener('keydown', wake);

// Initial screen from the query string (used for screenshots).
const q = new URLSearchParams(location.search).get('screen') ?? 'main';
switch (q) {
  case 'hud':
  case 'disarmed': {
    race.startRace();
    hud.showScreen('none');
    // Fast-forward past the countdown and a few rings so the HUD shows live data.
    const warm = q === 'hud' ? 4.8 : 3.2;
    for (let s = 0; s < warm; s += 1 / 120) {
      prevPos.copy(drone.position);
      if (race.snapshot().status === 'racing' && drone.armed) flyScript(1 / 120);
      for (const e of race.step(1 / 120, prevPos, drone, [])) handle(e);
    }
    lastPos.copy(drone.position);
    if (q === 'disarmed') {
      drone.armed = false;
      resetPath();
    }
    break;
  }
  case 'freefly':
    race.startFreeFly();
    drone.armed = true;
    hud.showScreen('none');
    break;
  case 'settings':
  case 'controls':
    hud.showScreen('main', { best: race.snapshot().bestTime });
    hud.showScreen(q);
    break;
  case 'rates':
    hud.showScreen('main', { best: race.snapshot().bestTime });
    hud.showScreen('settings');
    hud.showScreen('rates');
    break;
  case 'controller':
    hud.showScreen('main', { best: race.snapshot().bestTime });
    hud.showScreen('settings');
    hud.showScreen('controller');
    break;
  case 'pause':
    race.startRace();
    race.pause();
    hud.showScreen('pause');
    break;
  case 'finish':
    hud.showScreen('finish', { time: 47.38, best: 47.38, newBest: true });
    break;
  case 'error':
    hud.setError('WebGL is not available in this browser.\nEnable hardware acceleration or try a recent Chrome, Edge, Firefox or Safari.');
    break;
  default:
    hud.showScreen('main', { best: race.snapshot().bestTime });
}
setTimeout(() => hud.toast('UI preview — fake flight data'), 300);
requestAnimationFrame(frame);
