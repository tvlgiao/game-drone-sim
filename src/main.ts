/**
 * App bootstrap and frame orchestration: input → fixed-step simulation (FC + physics + race)
 * → interpolated render, HUD and audio. The only module that knows about every layer.
 */
import { Vector3 } from 'three';
import { GameAudio } from './audio/audio';
import { FixedLoop, FpsMeter } from './core/loop';
import { DynamicResolution, pickTier, probeGpu } from './core/quality';
import { loadSettings, saveSettings, type Settings } from './core/settings';
import { RATE_PRESETS } from './control/rates';
import { LOFT_LEVEL } from './game/level-data';
import { RaceController } from './game/race';
import { InputManager } from './input/input-manager';
import { Simulation } from './physics/simulation';
import { GameView } from './render/game-view';
import { Hud, type UiAction } from './ui/hud';
import type { ButtonEvents, CameraMode, ControlInput, DroneState, GameEvent, QualityTier } from './types';

const PHYSICS_DT = 1 / 1000;
const CAMERA_CYCLE: CameraMode[] = ['fpv', 'chase', 'los'];
const FLYING = new Set(['countdown', 'racing', 'crashed', 'freefly']);

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function cloneState(s: DroneState): DroneState {
  return {
    position: s.position.clone(),
    velocity: s.velocity.clone(),
    orientation: s.orientation.clone(),
    angularVelocity: s.angularVelocity.clone(),
    motors: [...s.motors],
    armed: s.armed,
    batteryVoltage: s.batteryVoltage,
  };
}

function boot(): void {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui') as HTMLElement;
  const storage = safeStorage();
  let settings: Settings = loadSettings(storage);

  const hud = new Hud(uiRoot, (a) => onAction(a));
  const gpu = probeGpu();
  const resolveTier = (s: Settings): QualityTier => (s.quality === 'auto' ? pickTier(gpu) : s.quality);
  let tier = resolveTier(settings);

  let view: GameView;
  try {
    view = new GameView(canvas, LOFT_LEVEL, tier);
  } catch (err) {
    hud.setError(`WebGL2 is not available on this device/browser (${(err as Error).message}). Enable hardware acceleration or try a recent Chrome, Edge, Firefox or Safari.`);
    return;
  }

  const sim = new Simulation(LOFT_LEVEL);
  const race = new RaceController(LOFT_LEVEL, storage);
  const input = new InputManager(window, settings);
  const audio = new GameAudio();
  const loop = new FixedLoop(PHYSICS_DT, 250);
  const fpsMeter = new FpsMeter();
  const dynRes = new DynamicResolution(120);

  const spawnPos = new Vector3(...LOFT_LEVEL.spawn.position);
  const prevPos = new Vector3();
  const renderState = cloneState(sim.world.state);
  const zeroThrottle: ControlInput = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
  let cameraMode: CameraMode = 'fpv';
  let respawnPending = false;
  let override: ControlInput | null = null;
  const injected: Partial<ButtonEvents> = {};

  function applySettings(s: Settings): void {
    settings = s;
    sim.fc.mode = s.flightMode;
    sim.fc.rates = RATE_PRESETS[s.ratePreset];
    input.updateSettings(s);
    audio.setVolume(s.volume);
    const next = resolveTier(s);
    if (next !== tier) {
      tier = next;
      view.setQuality(tier);
    }
    if (s.quality !== 'auto') view.setRenderScale(1);
  }
  applySettings(settings);
  hud.setSettings(settings);
  input.onConnection = (c) => hud.toast(c.connected ? `Controller connected: ${c.name}` : `Controller disconnected: ${c.name}`);

  function placeDrone(position: Vector3, yaw: number): void {
    sim.world.reset(position, yaw);
    sim.fc.reset();
    sim.fc.setArmed(false, zeroThrottle, sim.world.state);
    loop.reset();
  }

  function newSession(kind: 'race' | 'freefly'): void {
    placeDrone(spawnPos, LOFT_LEVEL.spawn.yaw);
    if (kind === 'race') race.startRace();
    else race.startFreeFly();
    hud.showScreen('none');
    canvas.focus();
  }

  function onAction(a: UiAction): void {
    void audio.resume();
    switch (a.type) {
      case 'race':
      case 'retry':
        newSession('race');
        break;
      case 'freefly':
        newSession('freefly');
        break;
      case 'resume':
        race.resume();
        hud.showScreen('none');
        loop.reset();
        break;
      case 'menu':
        race.toMenu();
        placeDrone(spawnPos, LOFT_LEVEL.spawn.yaw);
        hud.showScreen('main');
        break;
      case 'settings':
        applySettings(a.settings);
        saveSettings(a.settings, storage);
        break;
    }
  }

  function dispatch(e: GameEvent): void {
    view.handleEvent(e);
    audio.handleEvent(e);
    hud.handleEvent(e);
    switch (e.type) {
      case 'ring-passed':
        input.rumble(0.15, 0.5, 110);
        break;
      case 'collision':
        input.rumble(0.35, 0.25, 70);
        break;
      case 'crash':
        input.rumble(1, 1, 380);
        sim.fc.setArmed(false, zeroThrottle, sim.world.state);
        break;
      case 'respawn':
        respawnPending = true;
        break;
      case 'race-finish':
        sim.fc.setArmed(false, zeroThrottle, sim.world.state);
        hud.showScreen('finish', { time: e.time, best: race.snapshot().bestTime, newBest: e.best });
        break;
      default:
        break;
    }
  }

  function handleFlightButtons(b: ButtonEvents, control: ControlInput): void {
    const state = sim.world.state;
    if (b.arm) {
      const want = !sim.fc.armed;
      const ok = sim.fc.setArmed(want, control, state);
      if (want && !ok) hud.toast(control.throttle >= 0.05 ? 'Arming blocked: lower throttle to zero' : 'Arming blocked: level the drone');
      dispatch({ type: 'armed', armed: sim.fc.armed });
    }
    if (b.toggleMode) {
      settings = { ...settings, flightMode: sim.fc.mode === 'acro' ? 'angle' : 'acro' };
      sim.fc.mode = settings.flightMode;
      saveSettings(settings, storage);
      hud.setSettings(settings);
      hud.toast(`${settings.flightMode.toUpperCase()} mode`);
    }
    if (b.cycleCamera) cameraMode = CAMERA_CYCLE[(CAMERA_CYCLE.indexOf(cameraMode) + 1) % CAMERA_CYCLE.length];
    if (b.reset) race.requestReset();
    if (b.pause) {
      race.pause();
      hud.showScreen('pause');
    }
  }

  // Autoplay policy: audio starts on the first real user gesture.
  const unlock = (): void => void audio.resume();
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && FLYING.has(race.snapshot().status) && race.snapshot().status !== 'crashed') {
      race.pause();
      hud.showScreen('pause');
    }
  });

  const resize = (): void => view.resize(canvas.clientWidth, canvas.clientHeight);
  new ResizeObserver(resize).observe(canvas);
  resize();

  hud.showScreen('main');
  placeDrone(spawnPos, LOFT_LEVEL.spawn.yaw);

  let last = performance.now();
  let time = 0;

  function frame(now: number): void {
    const frameSec = Math.min((now - last) / 1000, 0.1);
    last = now;
    time += frameSec;
    fpsMeter.sample(frameSec);

    const inp = input.poll(frameSec);
    if (override) Object.assign(inp.control, override);
    for (const k of Object.keys(injected) as (keyof ButtonEvents)[]) {
      if (injected[k]) inp.buttons[k] = true;
      delete injected[k];
    }
    if (inp.buttons.confirm || inp.buttons.arm) void audio.resume();

    const status = race.snapshot().status;
    const flying = FLYING.has(status);

    if (!flying) {
      hud.navigate(inp.nav, inp.buttons.confirm);
      if (status === 'paused' && inp.buttons.pause) onAction({ type: 'resume' });
    }

    let alpha = 1;
    if (flying) {
      const control = status === 'countdown' ? { ...inp.control, throttle: 0 } : inp.control;
      alpha = loop.advance(frameSec, (dt) => {
        prevPos.copy(sim.world.state.position);
        const contacts = sim.step(dt, control);
        const events = race.step(dt, prevPos, sim.world.state, contacts);
        for (let i = 0; i < events.length; i++) dispatch(events[i]);
        if (respawnPending) {
          respawnPending = false;
          const p = race.respawnPoint();
          placeDrone(p.position, p.yaw);
        }
      });
      // After stepping: a race-start 'respawn' emitted this frame must not undo the pilot's arm press.
      handleFlightButtons(inp.buttons, inp.control);
    }

    const drone = sim.world.interpolate(alpha, renderState);
    const speed = drone.velocity.length();
    const snap = race.snapshot();

    view.frame({
      dt: frameSec,
      time,
      drone,
      fanAngle: sim.world.fanAngle,
      nextRing: snap.status === 'freefly' ? -1 : snap.nextRing,
      cameraMode: flying ? cameraMode : 'chase',
      cameraTiltDeg: settings.cameraTiltDeg,
      fovDeg: settings.fovDeg,
      speed,
    });

    if (settings.quality === 'auto') view.setRenderScale(dynRes.update(fpsMeter.frameMs));

    hud.update({
      race: snap,
      drone,
      input: inp,
      fps: fpsMeter.fps,
      mode: sim.fc.mode,
      camera: cameraMode,
      altitude: drone.position.y,
      speed,
      tier,
      settings,
    });
    audio.update(drone.motors, drone.armed, speed);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Debug / e2e hook.
  (window as unknown as { __drone: unknown }).__drone = {
    get state() {
      return sim.world.state;
    },
    get race() {
      return race.snapshot();
    },
    get fps() {
      return fpsMeter.fps;
    },
    get tier() {
      return tier;
    },
    get armed() {
      return sim.fc.armed;
    },
    get camera() {
      return cameraMode;
    },
    stats: () => view.stats(),
    setControl(c: ControlInput | null) {
      override = c;
    },
    press(name: keyof ButtonEvents) {
      injected[name] = true;
    },
    action: onAction,
    teleport(x: number, y: number, z: number, yaw = 0) {
      placeDrone(new Vector3(x, y, z), yaw);
    },
  };
}

boot();
