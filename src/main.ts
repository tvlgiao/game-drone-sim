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
import { RaceController, migrateBestTimes, readBestTime } from './game/race';
import { LEVELS, buildLevel, levelEntry, loadLastLevel, nextLevel, saveLastLevel, type LevelRuntime } from './levels/registry';
import { InputManager, KEY_STICKS } from './input/input-manager';
import { TutorialMachine, loadTutorialRecord, shouldOfferTutorial, type TutorialCtx, type TutorialEvent } from './game/tutorial';
import { TutorialUi, type TutorialFinishAction } from './ui/tutorial-ui';
import { tutorialView } from './ui/tutorial-prompts';
import { keyGlyph } from './ui/input-glyphs';
import { Simulation } from './physics/simulation';
import { GameView } from './render/game-view';
import { stickRadius } from './input/touch';
import { Hud, type UiAction } from './ui/hud';
import { throttleDownHint } from './ui/mode-labels';
import { throttleSlot } from './input/stick';
import { MobileShell, hardenGestures } from './ui/mobile-shell';
import { isQuestBrowser, onSessionGranted, requestVrSession, tuneXrSession, vrSupported, xrSessionObscured } from './core/xr';
import { Capacitor } from '@capacitor/core';
import { detectEdition, editionCaps, type EditionCaps } from './core/edition';
import { checkThisDevice, type OwnershipResult } from './core/ownership';
import { XR_APP_EXIT_HINT, XR_EXIT_HINT, xrHudContent, xrTutorialCard, xrTutorialPrompt } from './ui/xr-hud';
import { TouchControls } from './ui/touch-controls';
import type { ButtonEvents, CameraMode, ControlInput, DroneState, GameEvent, InputFrame, LevelId, QualityTier } from './types';

const PHYSICS_DT = 1 / 1000;
const CAMERA_CYCLE: CameraMode[] = ['los', 'fpv', 'chase'];
const BUTTON_KEYS: readonly (keyof ButtonEvents)[] = ['arm', 'toggleMode', 'cycleCamera', 'reset', 'pause', 'confirm', 'headingArrow', 'recenter'];
const XR_PANEL_PERIOD = 0.1;
/**
 * Frames rendered after a DOM menu (main / pause / settings / tap gate / rotate) opens before the 3D view
 * behind it freezes: the menus blur the canvas with backdrop-filter, which mobile GPUs (iPhone, Quest
 * Browser) would otherwise recompute for a full-screen moving scene every frame.
 */
const MENU_SETTLE_FRAMES = 2;
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

function boot(caps: EditionCaps): void {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui') as HTMLElement;
  const storage = safeStorage();
  let settings: Settings = loadSettings(storage);

  const device = detectDevice(window);
  document.body.classList.toggle('is-quest', isQuestBrowser(navigator.userAgent));
  const params = new URLSearchParams(location.search);
  const selftest = params.get('selftest') === '1';
  const hud = new Hud(uiRoot, (a) => onAction(a));
  bootHud = hud;
  const gpu = probeGpu();
  const resolveTier = (s: Settings): QualityTier => (s.quality === 'auto' ? pickTier(gpu, device.form) : s.quality);
  let tier = resolveTier(settings);
  migrateBestTimes(storage);
  let level: LevelRuntime = buildLevel(loadLastLevel(storage));

  let view: GameView;
  try {
    const xrCapable = caps.vr && 'xr' in navigator;
    view = new GameView(canvas, level, tier, device.form, { xr: xrCapable, antialias: isQuestBrowser(navigator.userAgent) });
  } catch (err) {
    hud.setError(`WebGL2 is not available on this device/browser (${(err as Error).message}). Enable hardware acceleration or try a recent Chrome, Edge, Firefox or Safari.`);
    return;
  }

  const sim = new Simulation(level);
  const race = new RaceController(level, storage);
  const input = new InputManager(window, settings, device.touch);
  const audio = new GameAudio();
  const loop = new FixedLoop(PHYSICS_DT, 250);
  const fpsMeter = new FpsMeter();
  const dynRes = new DynamicResolution(targetFps(device.form));

  let xrSession: XRSession | null = null;
  let xrStarting = false;
  /** the VR card redraws a canvas texture: refresh its numbers at most every XR_PANEL_PERIOD */
  let xrPanelAt = -Infinity;
  let xrPanelStatus = '';
  let menuRenders = 0;
  let wasOverlay = false;
  /** scene time frozen while a DOM menu covers the view */
  let overlayTime = 0;
  let xrToast = '';
  let xrToastUntil = 0;
  /** Toast on the DOM HUD and, while in a headset, on the XR card. */
  function toast(msg: string): void {
    hud.toast(msg);
    xrToast = msg;
    xrToastUntil = performance.now() + 2200;
  }
  if (device.native === 'ios') hud.hideExit();
  // Offline play for the web build, the home-screen PWA and the Quest app (a TWA on this origin): the
  // worker precaches every built file on first visit. The iOS/Android shells already bundle the files.
  // The worker sits at the site root (pages live in /play/ and /app/) so its scope covers both.
  if (import.meta.env.PROD && !device.native && window.isSecureContext && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('../sw.js').catch((err: unknown) => console.warn('Service worker registration failed (no offline play):', err));
  }
  // The installed Quest app (immersive Horizon OS app, display-mode standalone) goes straight into VR:
  // its launch carries user activation, so requestSession needs no click. A plain browser tab does not.
  const questApp = caps.vr && isQuestBrowser(navigator.userAgent) && device.standalone;
  if (caps.vr) {
    void vrSupported(navigator).then((ok) => {
      if (!ok) return;
      hud.enableVr();
      if (questApp && !selftest) void enterVr();
    });
    // The Quest app launches in immersive mode: go straight into VR when the browser grants a session.
    onSessionGranted(navigator, () => void enterVr());
  }

  let touchUi: TouchControls | null = null;
  let shell: MobileShell | null = null;
  if (device.touch) {
    hardenGestures(document);
    hud.enableTouch(device.fullscreen && !device.standalone);
    touchUi = new TouchControls(uiRoot, input.touch, stickRadius(device.form === 'phone'));
    shell = new MobileShell(uiRoot, {
      storage,
      standalone: device.standalone,
      form: device.form,
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

  const prevPos = new Vector3();
  const renderState = cloneState(sim.world.state);
  const zeroThrottle: ControlInput = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
  let cameraMode: CameraMode = 'los';
  let respawnPending = false;
  let override: ControlInput | null = null;
  const injected: Partial<ButtonEvents> = {};
  let hasInjected = false;
  let motorsMuted = false;
  /** the flying pad was unplugged during a crash: pause as soon as the respawn ends */
  let pauseAfterRespawn = false;

  function applySettings(s: Settings): void {
    settings = s;
    menuRenders = 0; // quality / FOV changes must show behind the settings screen
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
  publishLevels();

  const tutorial = new TutorialMachine({ storage });
  /** the tutorial owns the card / overlay: from Start until skip, quit or the completion card is answered */
  let tutOn = false;
  /** the welcome card's Continue button (pointer / touch), consumed by the next frame */
  let tutConfirm = false;
  /** ring-passed events since the tutorial started */
  let tutRings = 0;
  /** a crash or reset: the current step starts over when the drone is back on the pad */
  let tutRepeat = false;
  const tutUi = new TutorialUi(uiRoot, {
    onStart: () => startTutorial(),
    onSkip: () => skipTutorial(),
    onConfirm: () => {
      tutConfirm = true;
    },
    onFinish: (action) => finishTutorial(action),
  });

  input.onConnection = (c) => {
    toast(c.connected ? `Controller connected: ${c.name}` : `Controller disconnected: ${c.name}`);
    // the pilot just lost their sticks mid-flight; during a crash, pause once the respawn is done
    if (c.connected) pauseAfterRespawn = false;
    else if (c.wasActive) {
      if (race.snapshot().status === 'crashed') pauseAfterRespawn = true;
      else pauseFlight();
    }
  };

  /** Pauses a flight in progress (not a crash, which respawns on its own) behind the pause menu. */
  function pauseFlight(): void {
    const status = race.snapshot().status;
    if (!FLYING.has(status) || status === 'crashed') return;
    race.pause();
    hud.showScreen('pause');
  }

  function placeDrone(position: Vector3, yaw: number): void {
    sim.world.reset(position, yaw);
    sim.fc.reset();
    sim.setArmed(false, zeroThrottle);
    loop.reset();
    input.latchTakeoff();
  }

  function toSpawn(): void {
    const s = level.def.spawn;
    placeDrone(new Vector3(s.position[0], s.position[1], s.position[2]), s.yaw);
  }

  /** Level cards for the picker: name, blurb and the stored best lap of each playable level. */
  function publishLevels(): void {
    hud.setLevels(
      LEVELS.map((l) => ({ id: l.id, name: l.name, blurb: l.blurb, best: readBestTime(storage, l.id) })),
      level.def.id,
    );
  }

  /** bumps on every switch request: a slower build that resolves after a newer request is dropped */
  let levelSeq = 0;

  /**
   * Swap the level in view, physics, race and camera rig (the old level's GPU resources are freed),
   * remember it, and park the drone on its spawn. Resolves false when superseded by a newer request.
   */
  async function startLevel(id: LevelId): Promise<boolean> {
    const seq = ++levelSeq;
    if (id === level.def.id) return true;
    if (!levelEntry(id)) return false;
    const next = buildLevel(id);
    await next.ready;
    if (seq !== levelSeq) return false;
    level = next;
    view.loadLevel(next);
    sim.world.setLevel(next);
    race.setLevel(next);
    saveLastLevel(storage, id);
    toSpawn();
    publishLevels();
    menuRenders = 0; // the new scenery must show behind the menu
    return true;
  }

  /**
   * Tutorial on the Training field: free flight (no timer, every ring passable, crashes and resets respawn on the
   * pad), LOS camera, angle forced on the early steps.
   */
  function startTutorial(): void {
    void startLevel('training').then((ok) => {
      if (!ok) return;
      newSession('freefly');
      cameraMode = 'los';
      tutRings = 0;
      tutConfirm = false;
      tutRepeat = false;
      tutorial.start(settings.flightMode);
      setTutorialOn(true);
    });
  }

  function setTutorialOn(on: boolean): void {
    tutOn = on;
    hud.setTutorial(on && tutorial.active);
  }

  /** After skip / done / quit: the pilot's own flight mode comes back (the tutorial only forced it on the FC). */
  function endTutorial(): void {
    const mode = tutorial.playerFlightMode;
    if (mode && settings.flightMode !== mode) {
      settings = { ...settings, flightMode: mode };
      saveSettings(settings, storage);
      hud.setSettings(settings);
    }
    sim.fc.mode = settings.flightMode;
    setTutorialOn(false);
    tutUi.hide();
  }

  /** Card Skip, Esc, pause menu "Skip tutorial", or the first-run prompt's Skip: never offered again. */
  function skipTutorial(): void {
    const running = tutorial.active;
    tutorial.skip();
    if (!running) return;
    endTutorial();
    onAction({ type: 'menu' });
  }

  function finishTutorial(action: TutorialFinishAction): void {
    endTutorial();
    if (action === 'training') onAction({ type: 'level', id: 'training', mode: 'race' });
    else onAction({ type: 'menu' });
  }

  /** Tutorial complete: the flight freezes (no menu screen) under the completion card until it is answered. */
  function handleTutorialEvents(events: readonly TutorialEvent[]): void {
    if (!events.some((e) => e.type === 'done')) return;
    hud.setTutorial(false);
    race.pause();
  }

  /** Height above the walkable surface under the drone (meadow, prop tops). */
  function aglOf(p: Vector3): number {
    return p.y - level.surfaces.topBelow(p.x, p.y, p.z);
  }

  /** Keyboard throttle-up key for the stick mode, e.g. "W" (mode 2) or "↑" (mode 1). */
  function throttleUpKey(): string {
    return keyGlyph(KEY_STICKS[throttleSlot(settings.stickMode)][1]).label;
  }

  function newSession(kind: 'race' | 'freefly'): void {
    // a flight started another way (VR card, automation) answers the first-run offer for this launch
    if (tutUi.dialogOpen === 'prompt') tutUi.hide();
    toSpawn();
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
    // leaving the tutorial's flight any other way than Resume is a plain quit: the record keeps the step reached
    if (tutOn && a.type !== 'resume' && a.type !== 'settings' && a.type !== 'fullscreen' && a.type !== 'enter-vr' && a.type !== 'request-quit' && a.type !== 'skip-tutorial') endTutorial();
    switch (a.type) {
      case 'tutorial':
        startTutorial();
        break;
      case 'skip-tutorial':
        skipTutorial();
        break;
      case 'race':
      case 'retry':
        newSession('race');
        break;
      case 'freefly':
        newSession('freefly');
        break;
      case 'level': {
        const mode = a.mode;
        void startLevel(a.id).then((ok) => {
          if (ok) newSession(mode);
        });
        break;
      }
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
        toSpawn();
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
    // a second click while the first request is pending must not start (or tear down) anything
    if (!caps.vr || xrSession || xrStarting) return;
    xrStarting = true;
    let session: XRSession | null = null;
    try {
      session = await requestVrSession(navigator);
      xrSession = session;
      const granted = session;
      input.xr.setSources(() => granted.inputSources);
      input.latchTakeoff();
      session.addEventListener('visibilitychange', onXrVisibility);
      await view.startXr(session);
      void tuneXrSession(session, view.renderer.xr);
      loop.reset();
    } catch (err) {
      xrSession = null;
      input.xr.setSources(null);
      view.endXr();
      // a granted session that failed to start must not leave the headset stuck in immersive mode
      if (session) void session.end().catch(() => undefined);
      toast(`VR unavailable: ${(err as Error).message}`);
    } finally {
      xrStarting = false;
    }
  }

  /**
   * three's 'sessionend' fires after it has restored the flat-screen pixel ratio and size and
   * cleared isPresenting; the session's own 'end' event runs before that, too early to resize.
   */
  view.renderer.xr.addEventListener('sessionend', onVrEnd);
  function onVrEnd(): void {
    if (!xrSession) return;
    xrSession.removeEventListener('visibilitychange', onXrVisibility);
    xrSession = null;
    input.xr.setSources(null);
    view.endXr();
    if (questApp) {
      // The installed app only flies in VR: back on its 2D panel, offer the way straight back in.
      exited = false;
      race.toMenu();
      toSpawn();
      hud.showScreen('main');
      uiRoot.querySelector<HTMLElement>('[data-act="enter-vr"]')?.focus({ preventScroll: true });
      toast('Press Enter VR to fly');
    } else {
      pauseFlight();
    }
    loop.reset();
  }

  /**
   * Quest system menu / Guardian ('visible-blurred') or headset taken off ('hidden'): the pilot can no
   * longer see or steer, so the flight pauses and the sound stops until the session is visible again.
   */
  function onXrVisibility(): void {
    if (!xrSession) return;
    if (xrSessionObscured(xrSession.visibilityState)) {
      void audio.suspend();
      pauseFlight();
    } else if (xrSession.visibilityState === 'visible' && !exited && !document.hidden) {
      void audio.resume();
    }
  }

  /** VR menu screens on the XR card: A = primary, X = secondary, B = leave VR; Y on the main card = next level. */
  function handleXrMenu(status: string, b: NonNullable<InputFrame['xr']>): void {
    if (b.b) {
      // a second B before 'sessionend' finds the session already ending: InvalidStateError
      void xrSession?.end().catch(() => undefined);
      return;
    }
    if (status === 'menu') {
      if (b.a) onAction({ type: 'race' });
      else if (b.x) onAction({ type: 'freefly' });
      else if (b.y) void startLevel(nextLevel(level.def.id));
    } else if (status === 'paused') {
      if (b.a || b.y) onAction({ type: 'resume' });
      else if (b.x) onAction({ type: tutOn && tutorial.active ? 'skip-tutorial' : 'menu' });
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
        tutRings++;
        break;
      case 'collision':
        input.rumble(0.35, 0.25, 70);
        break;
      case 'crash':
        input.rumble(1, 1, 380);
        if (device.vibrate && input.activeSource === 'touch') navigator.vibrate?.(120);
        sim.setArmed(false, zeroThrottle);
        // the same step again once the drone is back on the pad (free flight respawns on the level spawn)
        if (tutorial.active) tutRepeat = true;
        break;
      case 'respawn':
        respawnPending = true;
        break;
      case 'race-finish':
        sim.setArmed(false, zeroThrottle);
        hud.showScreen('finish', { time: e.time, best: race.snapshot().bestTime, newBest: e.best });
        if (e.best) publishLevels();
        break;
      // the DOM HUD shows its own centre warning; the VR card has no centre title, so it gets the toast line
      case 'out-of-bounds':
        xrToast = `Out of bounds · respawn in ${e.seconds} s`;
        xrToastUntil = performance.now() + 1200;
        break;
      case 'in-bounds':
        xrToast = '';
        break;
      default:
        break;
    }
  }

  function throttleZeroHint(): string {
    const src = input.activeSource;
    if (src === 'touch') return `drag the ${throttleSlot(settings.stickMode) === 'ly' ? 'left' : 'right'} stick fully down`;
    if (src === 'xr') return `release the ${throttleSlot(settings.stickMode) === 'ly' ? 'left' : 'right'} thumbstick`;
    // the arm key zeroes the spring-back keyboard throttle itself: only a held throttle-up key blocks it
    if (src === 'keyboard') return `release ${throttleUpKey()}`;
    return throttleDownHint(settings, false).toLowerCase();
  }

  function handleFlightButtons(b: ButtonEvents, control: ControlInput): void {
    if (b.arm) {
      const want = !sim.fc.armed;
      const ok = sim.setArmed(want, control);
      if (want && !ok) toast(control.throttle >= 0.05 ? `Arming blocked: ${throttleZeroHint()}` : 'Arming blocked: level the drone');
      if (!sim.fc.armed) input.latchTakeoff();
      else if (input.takeoffLatched) toast(input.activeSource === 'keyboard' ? `Armed — hold ${throttleUpKey()} to take off` : 'Armed — push the throttle stick up to take off');
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
    toSpawn();
    void audio.suspend();
    if (device.native === 'android') {
      // if the shell cannot close, fall back to the "closed" screen like the web build
      void import('@capacitor/app')
        .then(({ App }) => App.exitApp())
        .catch(() => hud.showScreen('bye'));
      return;
    }
    void exitFullscreen(document);
    window.close(); // only works for script-opened windows; otherwise the "closed" screen stays
    hud.showScreen('bye');
  }

  // Sound must stop whenever the window is hidden, minimised or closed.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      void audio.suspend();
      pauseFlight();
    } else if (!exited && !(xrSession && xrSessionObscured(xrSession.visibilityState))) {
      void audio.resume();
    }
  });
  window.addEventListener('pagehide', () => audio.dispose());

  const resize = (): void => {
    view.resize(canvas.clientWidth, canvas.clientHeight);
    menuRenders = 0;
  };
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
  toSpawn();
  if (!selftest && shouldOfferTutorial(loadTutorialRecord(storage))) tutUi.showPrompt();

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

    if (flying && shell?.rotateOpen) pauseFlight();

    const inVr = view.presenting;
    // keyboard Z also centres the mouse stick (input manager); the view only recentres in a headset
    if (inVr && inp.buttons.recenter) view.recenterXr();
    if (inp.buttons.headingArrow) {
      settings = { ...settings, headingArrow: !settings.headingArrow };
      saveSettings(settings, storage);
      hud.setSettings(settings);
      toast(`Heading arrow ${settings.headingArrow ? 'on' : 'off'}`);
    }
    // first-run prompt / completion card: menu input goes to the dialog, also over a flying status (done card)
    let dialogInput = false;
    if (tutUi.dialogOpen) {
      if (inVr && inp.xr) {
        const x = inp.xr;
        if (tutUi.dialogOpen === 'prompt') {
          if (x.a) {
            tutUi.hide();
            startTutorial();
          } else if (x.x) {
            tutUi.hide();
            skipTutorial();
          }
        } else if (x.a) finishTutorial('training');
        else if (x.x) finishTutorial('menu');
      } else {
        tutUi.navigate(inp.nav, inp.buttons.confirm);
      }
      dialogInput = true;
    }
    if (!flying && !dialogInput) {
      if (inVr && inp.xr) {
        handleXrMenu(status, inp.xr);
      } else {
        hud.navigate(inp.nav, inp.buttons.confirm);
        if (status === 'paused' && inp.buttons.pause) onAction({ type: 'resume' });
      }
    }

    let alpha = 1;
    const tutRunning = tutOn && tutorial.active;
    if (flying) {
      if (tutRunning) {
        // angle forced on steps 2–8 (the FC only: settings keep the pilot's mode); arm locked on the welcome card
        sim.fc.mode = tutorial.requiredFlightMode() ?? settings.flightMode;
        for (const b of tutorial.lockedButtons()) inp.buttons[b] = false;
        // keyboard skips with Esc (no pause menu in the tutorial); pad / Quest skip from their pause menu
        if (inp.source === 'keyboard' && inp.buttons.pause) {
          inp.buttons.pause = false;
          skipTutorial();
        }
        // reset (R / pad B / Quest X) repeats the step from the pad: free flight resets to the spawn
        if (inp.buttons.reset) tutRepeat = true;
      }
      // Sources whose throttle springs back to centre fly with altitude hold, centre = hover (DJI 'A/Atti' style):
      // keyboard keys, Quest thumbsticks and touch auto-centre sticks (input-manager holdsAltitude).
      sim.fc.altitudeHold = input.altitudeHold(tutRunning ? { ...settings, flightMode: sim.fc.mode } : settings);
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
        if (tutRepeat) {
          tutRepeat = false;
          tutorial.crash();
        }
      }
      // between a crash / reset and the respawn on the pad the step neither progresses nor completes
      if (tutOn && tutorial.active && !tutRepeat) {
        const st = sim.world.state;
        const ctx: TutorialCtx = {
          dt: frameSec,
          drone: st,
          agl: aglOf(st.position),
          armed: sim.fc.armed,
          flightMode: sim.fc.mode,
          cameraMode,
          source: inp.source,
          ringsPassed: tutRings,
          confirm: inp.buttons.confirm || tutConfirm,
        };
        tutConfirm = false;
        handleTutorialEvents(tutorial.update(ctx));
      }
      // After stepping: a race-start 'respawn' emitted this frame must not undo the pilot's arm press.
      if (!dialogInput) handleFlightButtons(inp.buttons, inp.control);
    }

    const drone = sim.world.interpolate(alpha, renderState);
    const speed = drone.velocity.length();
    const snap = race.snapshot();

    // In a headset the view must follow the head every frame; on a flat screen a DOM menu freezes it.
    const overlay = !inVr && (hud.screen !== 'none' || (shell?.gateOpen ?? false) || (shell?.rotateOpen ?? false));
    // Re-render only when a menu first covers the view (not on menu-to-menu navigation), on resize and
    // on settings changes; those frames are still (dt = 0, frozen time) so the backdrop never shifts.
    if (overlay && !wasOverlay) {
      menuRenders = 0;
      overlayTime = time;
    }
    wasOverlay = overlay;
    // A frozen view's frame time says nothing about the GPU, so dynamic resolution only adapts while rendering.
    // Resize before drawing: resizing the canvas clears it, and after the draw the cleared buffer would be shown.
    if (settings.quality === 'auto' && !inVr && !overlay) view.setRenderScale(dynRes.update(fpsMeter.frameMs));
    const renderNow = !overlay || menuRenders < MENU_SETTLE_FRAMES;
    if (renderNow) {
      if (overlay) menuRenders++;
      view.frame({
        dt: overlay ? 0 : frameSec,
        time: overlay ? overlayTime : time,
        still: overlay,
        drone,
        fanAngle: sim.world.fanAngle,
        nextRing: snap.status === 'freefly' ? -1 : snap.nextRing,
        // pause keeps the flight camera (no swing to LOS behind the menu, no VR teleport to the platform)
        cameraMode: flying || snap.status === 'paused' ? cameraMode : 'los',
        cameraTiltDeg: settings.cameraTiltDeg,
        fovDeg: settings.fovDeg,
        speed,
        headingArrow: settings.headingArrow,
      });
      // first drawn frame: fade the boot splash (index.html)
      if (view.frames === 1) document.body.classList.add('is-ready');
    }

    if (inVr) {
      // the take-off prompt is stale as soon as the throttle leaves the latch
      if (xrToast && (performance.now() > xrToastUntil || (xrToast.startsWith('Armed') && !input.takeoffLatched))) xrToast = '';
      const tutCard = tutUi.dialogOpen === 'prompt' ? 'prompt' : tutOn && (tutorial.phase === 'done' || snap.status !== 'paused') ? 'card' : '';
      const panelKey = `${snap.status}|${tutCard}`;
      if (time - xrPanelAt >= XR_PANEL_PERIOD || panelKey !== xrPanelStatus) {
        xrPanelAt = time;
        xrPanelStatus = panelKey;
        view.xrPanel.set(
          tutCard === 'prompt'
            ? xrTutorialPrompt()
            : tutCard === 'card'
              ? xrTutorialCard(tutorialView(tutorial, 'xr', settings, sim.fc.armed))
              : xrHudContent({
            race: snap,
            armed: sim.fc.armed,
            latched: input.takeoffLatched,
            mode: sim.fc.mode,
            camera: cameraMode,
            altitude: drone.position.y,
            speed,
            toast: xrToast,
            exitHint: questApp ? XR_APP_EXIT_HINT : XR_EXIT_HINT,
            level: levelEntry(level.def.id)?.name,
            tutorial: tutOn && tutorial.active,
          }),
        );
      }
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
    // the card hides behind menus (pause) and in a headset (the XR card shows it there)
    tutUi.render(tutOn && !inVr && hud.screen === 'none' ? tutorialView(tutorial, inp.source, settings, sim.fc.armed, inp.gamepadId) : null);
    if (pauseAfterRespawn && snap.status !== 'crashed') {
      pauseAfterRespawn = false;
      pauseFlight();
    }
    if (touchUi) {
      touchUi.setVisible(
        inp.source === 'touch' && FLYING.has(snap.status) && hud.screen === 'none' && !shell?.rotateOpen,
        snap.status === 'paused' || snap.status === 'finished',
      );
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
      return {
        presenting: view.presenting,
        source: input.activeSource,
        latched: input.takeoffLatched,
        panelDraws: view.xrPanel.draws,
        frameRate: xrSession?.frameRate ?? null,
        foveation: view.renderer.xr.getFoveation() ?? null,
        /** motor sound muted (paused flight) */
        motorsMuted,
        /** the VR card's current text (title / sub / hint) */
        panel: view.xrPanel.content,
      };
    },
    stats: () => view.stats(),
    /** loaded level id */
    get level() {
      return level.def.id;
    },
    /** switch level without starting a run (resolves false when superseded) */
    startLevel: (id: LevelId) => startLevel(id),
    /** tutorial state: phase, current step, open dialog, whether the card is up */
    get tutorial() {
      return { on: tutOn, phase: tutorial.phase, step: tutorial.step.id, index: tutorial.index, progress: tutorial.progress, dialog: tutUi.dialogOpen };
    },
    startTutorial: () => startTutorial(),
    /** drone position projected by the rendered camera (NDC: −1..1 inside the frame; z > 1 = behind) */
    get droneNdc() {
      const p = sim.world.state.position.clone().project(view.camera);
      return { x: p.x, y: p.y, z: p.z };
    },
    /** camera the view is rendering (menus show LOS; pause keeps the flight camera) */
    get renderedCamera() {
      return view.renderedCamera;
    },
    /** rendered camera position + orientation (4 dp), to check the backdrop stays put behind menus */
    get cameraPose() {
      const c = view.camera;
      return [...c.position.toArray(), ...c.quaternion.toArray()].map((v) => v.toFixed(4)).join(',');
    },
    /** 3D frames drawn so far (the view freezes behind DOM menus) */
    get renders() {
      return view.frames;
    },
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
    /** UI audit / e2e: open any menu screen directly (finish needs its time data) */
    showScreen: (name: Parameters<Hud['showScreen']>[0], data?: Parameters<Hud['showScreen']>[1]) => hud.showScreen(name, data),
    /** UI audit: render the fatal-error screen */
    showError: (msg: string) => hud.setError(msg),
    toast: (msg: string) => toast(msg),
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

/** the boot's HUD, once created: a later fatal error reuses it instead of stacking a second UI */
let bootHud: Hud | null = null;

/** A start-up failure (lazy import offline, ownership check, boot) ends on the error screen, never a blank page. */
function showStartupError(err: unknown): void {
  document.body.classList.add('is-ready');
  const ui = document.getElementById('ui');
  if (!ui) return;
  const detail = err instanceof Error ? err.message : String(err);
  (bootHud ?? new Hud(ui, () => undefined)).setError(`Drone Sim could not start (${detail}). Check your connection and reload.`);
}

/** A boot that throws must not leave the splash covering the page. */
function safeBoot(caps: EditionCaps): void {
  try {
    boot(caps);
  } catch (err) {
    document.body.classList.add('is-ready');
    throw err;
  }
}

/** /app/ boots only for a Meta Horizon Store owner; `?owned=1` skips the check in `npm run dev`. */
async function ownership(params: URLSearchParams): Promise<OwnershipResult> {
  if (import.meta.env.DEV && params.get('owned') === '1') return { owned: true, via: 'store' };
  return checkThisDevice(safeStorage());
}

async function start(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const caps = editionCaps(detectEdition(location.pathname, Capacitor.isNativePlatform(), import.meta.env.DEV));
  // `?xremu=1` emulates a Quest 2 (IWER) before boot so navigator.xr is the emulated runtime.
  if (params.get('xremu') === '1') (await import('./core/xr-emulator')).installXrEmulator();
  const check = caps.ownershipCheck ? await ownership(params) : null;
  if (check && !check.owned) {
    (await import('./ui/store-gate')).showStoreGate(document, check.via === 'error' ? 'unverified' : 'not-owned');
    document.body.classList.add('is-ready');
    return;
  }
  safeBoot(caps);
}

// a failed lazy import (offline, no cache), ownership check or boot shows the error screen
void start().catch((err: unknown) => {
  console.error(err);
  showStartupError(err);
});
