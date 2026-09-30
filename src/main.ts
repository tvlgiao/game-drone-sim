/**
 * App bootstrap and frame orchestration: input → fixed-step simulation (FC + physics + race)
 * → interpolated render, HUD and audio. The only module that knows about every layer.
 */
import { Vector3 } from 'three';
import { GameAudio } from './audio/audio';
import { FixedLoop, FpsMeter } from './core/loop';
import { detectDevice, exitFullscreen, needsRotate, requestFullscreen, toggleFullscreen } from './core/device';
import { DynamicResolution, pickTier, probeGpu, targetFps } from './core/quality';
import { loadSettings, saveSettings, type Settings } from './core/settings';
import { hoverThrottle } from './physics/drone-params';
import { LOFT_LEVEL } from './game/level-data';
import { RaceController } from './game/race';
import { InputManager } from './input/input-manager';
import { Simulation } from './physics/simulation';
import { GameView } from './render/game-view';
import { stickRadius } from './input/touch';
import { Hud, type UiAction } from './ui/hud';
import { throttleDownHint } from './ui/mode-labels';
import { throttleSlot } from './input/stick';
import { MobileShell, hardenGestures } from './ui/mobile-shell';
import { isQuestBrowser, requestVrSession, vrSupported } from './core/xr';
import { xrHudContent } from './ui/xr-hud';
import { TouchControls } from './ui/touch-controls';
import type { ButtonEvents, CameraMode, ControlInput, DroneState, GameEvent, InputFrame, QualityTier } from './types';

const PHYSICS_DT = 1 / 1000;
const CAMERA_CYCLE: CameraMode[] = ['los', 'fpv', 'chase'];
const BUTTON_KEYS: readonly (keyof ButtonEvents)[] = ['arm', 'toggleMode', 'cycleCamera', 'reset', 'pause', 'confirm'];
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

  const device = detectDevice(window);
  const params = new URLSearchParams(location.search);
  const selftest = params.get('selftest') === '1';
  const hud = new Hud(uiRoot, (a) => onAction(a));
  const gpu = probeGpu();
  const resolveTier = (s: Settings): QualityTier => (s.quality === 'auto' ? pickTier(gpu, device.form) : s.quality);
  let tier = resolveTier(settings);

  let view: GameView;
  try {
    const xrCapable = 'xr' in navigator;
    view = new GameView(canvas, LOFT_LEVEL, tier, device.form, { xr: xrCapable, antialias: isQuestBrowser(navigator.userAgent) });
  } catch (err) {
    hud.setError(`WebGL2 is not available on this device/browser (${(err as Error).message}). Enable hardware acceleration or try a recent Chrome, Edge, Firefox or Safari.`);
    return;
  }

  const sim = new Simulation(LOFT_LEVEL);
  const race = new RaceController(LOFT_LEVEL, storage);
  const input = new InputManager(window, settings, device.touch);
  const audio = new GameAudio();
  const loop = new FixedLoop(PHYSICS_DT, 250);
  const fpsMeter = new FpsMeter();
  const dynRes = new DynamicResolution(targetFps(device.form));

  let xrSession: XRSession | null = null;
  let xrToast = '';
  let xrToastUntil = 0;
  /** Toast on the DOM HUD and, while in a headset, on the XR card. */
  function toast(msg: string): void {
    hud.toast(msg);
    xrToast = msg;
    xrToastUntil = performance.now() + 2200;
  }
  void vrSupported(navigator).then((ok) => {
    if (ok) hud.enableVr();
  });

  let touchUi: TouchControls | null = null;
  let shell: MobileShell | null = null;
  if (device.touch) {
    hardenGestures(document);
    hud.enableTouch(device.fullscreen && !device.standalone);
    touchUi = new TouchControls(uiRoot, input.touch, stickRadius(device.form === 'phone'));
    shell = new MobileShell(uiRoot, {
      storage,
      standalone: device.standalone,
      onGateTap: () => {
        // Runs inside the tap: the gesture both unlocks WebAudio and allows the fullscreen request.
        void audio.resume();
        if (device.standalone) return;
        if (!device.fullscreen) {
          if (device.ios) shell?.offerHomeScreen();
          return;
        }
        void requestFullscreen(document).then((ok) => {
          if (!ok && device.ios) shell?.offerHomeScreen();
        });
      },
    });
    if (!selftest) shell.showGate();
  }

  const spawnPos = new Vector3(...LOFT_LEVEL.spawn.position);
  const prevPos = new Vector3();
  const renderState = cloneState(sim.world.state);
  const zeroThrottle: ControlInput = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
  let cameraMode: CameraMode = 'los';
  let respawnPending = false;
  let override: ControlInput | null = null;
  const injected: Partial<ButtonEvents> = {};
  let hasInjected = false;
  let motorsMuted = false;

  function applySettings(s: Settings): void {
    settings = s;
    sim.fc.mode = s.flightMode;
    const r = s.rates;
    sim.fc.rates = { roll: { ...r.roll }, pitch: { ...r.pitch }, yaw: { ...r.yaw } };
    sim.fc.angleMaxTiltDeg = s.angleMaxTiltDeg;
    sim.fc.throttleExpo = s.throttleExpo;
    sim.fc.throttleLimit = s.throttleLimit;
    sim.fc.throttleMid = s.throttleMid ?? hoverThrottle(sim.world.params);
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
  input.onConnection = (c) => toast(c.connected ? `Controller connected: ${c.name}` : `Controller disconnected: ${c.name}`);

  function placeDrone(position: Vector3, yaw: number): void {
    sim.world.reset(position, yaw);
    sim.fc.reset();
    sim.setArmed(false, zeroThrottle);
    loop.reset();
    input.latchTakeoff();
  }

  function newSession(kind: 'race' | 'freefly'): void {
    placeDrone(spawnPos, LOFT_LEVEL.spawn.yaw);
    // A fresh flight starts with the touch throttle at the bottom (or centre when it auto-centres).
    input.touch.sticks.releaseAll();
    input.touch.sticks.setThrottle(settings.touchThrottleCentre ? 0.5 : 0);
    input.latchTakeoff();
    if (kind === 'race') race.startRace();
    else race.startFreeFly();
    hud.showScreen('none');
    canvas.focus();
  }

  function onAction(a: UiAction): void {
    if (a.type !== 'exit') void audio.resume();
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
      case 'request-quit':
        if (FLYING.has(race.snapshot().status)) race.pause();
        hud.showScreen('confirm-quit');
        break;
      case 'exit':
        exitGame();
        break;
      case 'menu':
        exited = false;
        race.toMenu();
        placeDrone(spawnPos, LOFT_LEVEL.spawn.yaw);
        hud.showScreen('main');
        break;
      case 'settings':
        applySettings(a.settings);
        saveSettings(a.settings, storage);
        break;
      case 'enter-vr':
        void enterVr();
        break;
      case 'fullscreen':
        void toggleFullscreen(document).then((on) => hud.toast(on ? 'Full screen on' : 'Full screen off'));
        break;
    }
  }

  /** Start an immersive-vr session (runs inside the menu click, which WebXR requires). */
  async function enterVr(): Promise<void> {
    if (xrSession) return;
    try {
      const session = await requestVrSession(navigator);
      xrSession = session;
      session.addEventListener('end', onVrEnd);
      input.xr.setSources(() => session.inputSources);
      input.latchTakeoff();
      await view.startXr(session);
      loop.reset();
    } catch (err) {
      if (xrSession) xrSession.removeEventListener('end', onVrEnd);
      xrSession = null;
      input.xr.setSources(null);
      view.endXr();
      toast(`VR unavailable: ${(err as Error).message}`);
    }
  }

  function onVrEnd(): void {
    xrSession = null;
    input.xr.setSources(null);
    view.endXr();
    const status = race.snapshot().status;
    if (FLYING.has(status) && status !== 'crashed') {
      race.pause();
      hud.showScreen('pause');
    }
    loop.reset();
  }

  /** VR menu screens on the XR card: A = primary, X = secondary, B = leave VR. */
  function handleXrMenu(status: string, b: NonNullable<InputFrame['xr']>): void {
    if (b.b) {
      void xrSession?.end();
      return;
    }
    if (status === 'menu') {
      if (b.a) onAction({ type: 'race' });
      else if (b.x) onAction({ type: 'freefly' });
    } else if (status === 'paused') {
      if (b.a || b.y) onAction({ type: 'resume' });
      else if (b.x) onAction({ type: 'menu' });
    } else if (status === 'finished') {
      if (b.a) onAction({ type: 'retry' });
      else if (b.x) onAction({ type: 'menu' });
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
        if (device.vibrate && input.activeSource === 'touch') navigator.vibrate?.(120);
        sim.setArmed(false, zeroThrottle);
        break;
      case 'respawn':
        respawnPending = true;
        break;
      case 'race-finish':
        sim.setArmed(false, zeroThrottle);
        hud.showScreen('finish', { time: e.time, best: race.snapshot().bestTime, newBest: e.best });
        break;
      default:
        break;
    }
  }

  function throttleZeroHint(): string {
    const src = input.activeSource;
    if (src === 'touch') return `drag the ${throttleSlot(settings.stickMode) === 'ly' ? 'left' : 'right'} stick fully down`;
    if (src === 'xr') return `release the ${throttleSlot(settings.stickMode) === 'ly' ? 'left' : 'right'} thumbstick`;
    return throttleDownHint(settings, src === 'keyboard').toLowerCase();
  }

  function handleFlightButtons(b: ButtonEvents, control: ControlInput): void {
    if (b.arm) {
      const want = !sim.fc.armed;
      const ok = sim.setArmed(want, control);
      if (want && !ok) toast(control.throttle >= 0.05 ? `Arming blocked: ${throttleZeroHint()}` : 'Arming blocked: level the drone');
      if (!sim.fc.armed) input.latchTakeoff();
      else if (input.takeoffLatched) toast('Armed — push the throttle stick up to take off');
      dispatch({ type: 'armed', armed: sim.fc.armed });
    }
    if (b.toggleMode) {
      settings = { ...settings, flightMode: sim.fc.mode === 'acro' ? 'angle' : 'acro' };
      sim.fc.mode = settings.flightMode;
      saveSettings(settings, storage);
      hud.setSettings(settings);
      toast(`${settings.flightMode.toUpperCase()} mode`);
    }
    if (b.cycleCamera) cameraMode = CAMERA_CYCLE[(CAMERA_CYCLE.indexOf(cameraMode) + 1) % CAMERA_CYCLE.length];
    if (b.reset) race.requestReset();
    if (b.pause) {
      race.pause();
      hud.showScreen('pause');
    }
  }

  // Autoplay policy: audio starts on the first real user gesture.
  const unlock = (): void => {
    if (!exited) void audio.resume();
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
  // iOS only treats touchend / pointerup (not touchstart) as an audio-unlocking gesture.
  window.addEventListener('touchend', unlock, { once: true });
  window.addEventListener('pointerup', unlock, { once: true });

  let exited = false;

  /** Leave the game: stop all sound, drop fullscreen, close the tab when the browser allows it. */
  function exitGame(): void {
    exited = true;
    race.toMenu();
    placeDrone(spawnPos, LOFT_LEVEL.spawn.yaw);
    void audio.suspend();
    void exitFullscreen(document);
    window.close(); // only works for script-opened windows; otherwise the "closed" screen stays
    hud.showScreen('bye');
  }

  // Sound must stop whenever the window is hidden, minimised or closed.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      void audio.suspend();
      if (FLYING.has(race.snapshot().status) && race.snapshot().status !== 'crashed') {
        race.pause();
        hud.showScreen('pause');
      }
    } else if (!exited) {
      void audio.resume();
    }
  });
  window.addEventListener('pagehide', () => audio.dispose());

  const resize = (): void => view.resize(canvas.clientWidth, canvas.clientHeight);
  new ResizeObserver(resize).observe(canvas);
  resize();

  // Phones fly in landscape only: portrait shows the rotate overlay (the frame loop pauses the flight).
  // `?rotate=0` disables the overlay (automation on simulators that cannot be rotated).
  const allowPortrait = params.get('rotate') === '0';
  const checkOrientation = (): void => shell?.setRotate(!allowPortrait && needsRotate(device.form, window.innerWidth, window.innerHeight));
  window.addEventListener('resize', checkOrientation);
  window.addEventListener('orientationchange', checkOrientation);
  checkOrientation();

  hud.showScreen('main');
  placeDrone(spawnPos, LOFT_LEVEL.spawn.yaw);

  let last = performance.now();
  let time = 0;
  let lastInput: InputFrame | null = null;

  function frame(now: number): void {
    // XR frame times share the performance.now() timebase, but never trust a backwards step.
    const frameSec = Math.min(Math.max((now - last) / 1000, 0), 0.1);
    last = now;
    time += frameSec;
    fpsMeter.sample(frameSec);

    const inp = input.poll(frameSec);
    lastInput = inp;
    if (override) Object.assign(inp.control, override);
    if (hasInjected) {
      for (const k of BUTTON_KEYS) {
        if (injected[k]) inp.buttons[k] = true;
        injected[k] = false;
      }
      hasInjected = false;
    }
    if (!exited && (inp.buttons.confirm || inp.buttons.arm)) void audio.resume();

    const status = race.snapshot().status;
    const flying = FLYING.has(status);

    if (flying && shell?.rotateOpen && status !== 'crashed') {
      race.pause();
      hud.showScreen('pause');
    }

    const inVr = view.presenting;
    if (inVr && inp.xr?.lStick) view.recenterXr();
    if (inVr && inp.xr?.lTrigger) {
      settings = { ...settings, headingArrow: !settings.headingArrow };
      saveSettings(settings, storage);
      hud.setSettings(settings);
      toast(`Heading arrow ${settings.headingArrow ? 'on' : 'off'}`);
    }
    if (!flying) {
      if (inVr && inp.xr) {
        handleXrMenu(status, inp.xr);
      } else {
        hud.navigate(inp.nav, inp.buttons.confirm);
        if (status === 'paused' && inp.buttons.pause) onAction({ type: 'resume' });
      }
    }

    let alpha = 1;
    if (flying) {
      // Touch auto-centre sticks fly DJI-style: centre holds altitude (barometer hold), like 'A/Atti' mode.
      // Quest thumbsticks always spring back to centre, so VR flies with altitude hold too.
      sim.fc.altitudeHold = (inp.source === 'touch' && settings.touchThrottleCentre) || inp.source === 'xr';
      // …and the right thumbstick flies speed, braking to a stop when released (Angle mode).
      sim.fc.positionHold = inp.source === 'xr';
      const control = status === 'countdown' ? { ...inp.control, throttle: 0 } : inp.control;
      alpha = loop.advance(frameSec, (dt) => {
        prevPos.copy(sim.world.state.position);
        const contacts = sim.step(dt, control);
        const events = race.step(dt, prevPos, sim.world.state, contacts);
        for (let i = 0; i < events.length; i++) dispatch(events[i]);
      });
      // Teleport outside advance(): placeDrone resets the loop accumulator.
      if (respawnPending) {
        respawnPending = false;
        const p = race.respawnPoint();
        placeDrone(p.position, p.yaw);
        alpha = 1;
      }
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
      cameraMode: flying ? cameraMode : 'los',
      cameraTiltDeg: settings.cameraTiltDeg,
      fovDeg: settings.fovDeg,
      speed,
      headingArrow: settings.headingArrow,
    });

    if (settings.quality === 'auto' && !inVr) view.setRenderScale(dynRes.update(fpsMeter.frameMs));
    if (inVr) {
      // the take-off prompt is stale as soon as the throttle leaves the latch
      if (xrToast && (performance.now() > xrToastUntil || (xrToast.startsWith('Armed') && !input.takeoffLatched))) xrToast = '';
      view.xrPanel.set(
        xrHudContent({ race: snap, armed: sim.fc.armed, latched: input.takeoffLatched, mode: sim.fc.mode, camera: cameraMode, altitude: drone.position.y, speed, toast: xrToast }),
      );
    }

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
    if (touchUi) {
      touchUi.setVisible(inp.source === 'touch' && FLYING.has(snap.status) && hud.screen === 'none' && !shell?.rotateOpen);
      touchUi.update(settings, sim.fc.armed, sim.fc.mode, cameraMode);
    }
    const mute = snap.status === 'paused';
    if (mute !== motorsMuted) {
      motorsMuted = mute;
      audio.setMotorsMuted(mute);
    }
    audio.update(drone.motors, drone.armed, speed);
  }
  // setAnimationLoop = requestAnimationFrame on a flat screen, the XR session's frame loop in a headset.
  view.renderer.setAnimationLoop(frame);

  // Debug / e2e / selftest hook.
  const hook = {
    get state() {
      return sim.world.state;
    },
    get race() {
      return race.snapshot();
    },
    get fps() {
      return fpsMeter.fps;
    },
    /** tier actually rendering (the XR session overrides the chosen one) */
    get tier() {
      return view.tier;
    },
    get armed() {
      return sim.fc.armed;
    },
    get camera() {
      return cameraMode;
    },
    get xr() {
      return { presenting: view.presenting, source: input.activeSource, latched: input.takeoffLatched };
    },
    stats: () => view.stats(),
    get audio() {
      return audio.state;
    },
    get screen() {
      return hud.screen;
    },
    setControl(c: ControlInput | null) {
      override = c;
    },
    press(name: keyof ButtonEvents) {
      injected[name] = true;
      hasInjected = true;
    },
    action: onAction,
    teleport(x: number, y: number, z: number, yaw = 0) {
      placeDrone(new Vector3(x, y, z), yaw);
    },
    /** active input source ('touch' | 'gamepad' | 'keyboard' | 'none') */
    get source() {
      return input.activeSource;
    },
    /** last polled pilot command (after mode mapping / deadzone) */
    get control() {
      return lastInput?.control ?? null;
    },
    get mode() {
      return sim.fc.mode;
    },
    get touchVisible() {
      return touchUi?.isVisible ?? false;
    },
    device,
    get pixelRatio() {
      return view.pixelRatio;
    },
    get renderScale() {
      return view.scale;
    },
    get rotateOverlay() {
      return shell?.rotateOpen ?? false;
    },
    get gateOpen() {
      return shell?.gateOpen ?? false;
    },
    touch: { layer: touchUi?.layer ?? null, sticks: input.touch.sticks },
  };
  (window as unknown as { __drone: unknown }).__drone = hook;

  if (selftest) void import('./ui/selftest').then((m) => m.runSelfTest(hook, settings.stickMode));
}

// `?xremu=1` emulates a Quest 2 (IWER) before boot so navigator.xr is the emulated runtime.
if (new URLSearchParams(location.search).get('xremu') === '1') {
  void import('./core/xr-emulator').then((m) => {
    m.installXrEmulator();
    boot();
  });
} else {
  boot();
}
