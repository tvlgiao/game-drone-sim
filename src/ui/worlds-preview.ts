/**
 * Dev-only harness for the worlds UI (worlds-preview.html, not part of any build input): the Hud with the five
 * level cards, the Worlds screen and the outdoor HUD over a fake scene, with a recording `onAction` in place of
 * main.ts. The minimap samples a real Infinite world. Used by tests/e2e/worlds-ui.spec.ts.
 * Query: ?screen=levels|worlds|main|settings|hud|race|pause &worlds=N (seed N saved worlds) &fresh=1 (empty store)
 *        &touch=1 &units=ft &noshare=1 (no navigator.share) &seed=N (Infinite world for the HUD) &dark=1
 */
import { Quaternion, Vector3 } from 'three';
import { DEFAULT_SETTINGS, cloneSettings, type Settings } from '../core/settings';
import { WORLDS_KEY, emptyWorlds, recordPlayed, saveWorlds } from '../game/worlds';
import { InputManager } from '../input/input-manager';
import { stickRadius } from '../input/touch';
import { TouchControls } from './touch-controls';
import type { DroneState, RaceSnapshot, RaceStatus } from '../types';
import { createWorld, GEN_VERSION } from '../world';
import { Hud, type OutdoorHud, type UiAction } from './hud';
import type { LevelCard } from './level-select';
import { terrainMinimapSampler } from './minimap';
import { xrHudContent } from './xr-hud';

const params = new URLSearchParams(location.search);
const NOW = Date.now();
const actions: UiAction[] = [];
const toasts: string[] = [];

if (params.get('dark') === '1') document.body.classList.add('is-dark');
if (params.get('noshare') === '1') Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });

const NAMES = ['Lakeside run', 'Red roofs', 'Twin rivers', 'Foggy ridge', 'Sunday loop', 'Long valley', 'Bridges', 'Pine hills'];
const nWorlds = params.has('worlds') ? Math.max(0, Math.min(50, Number(params.get('worlds')) || 0)) : -1;
if (params.get('fresh') === '1' || nWorlds >= 0) {
  let store = emptyWorlds();
  for (let i = 0; i < Math.max(0, nWorlds); i++) {
    const seed = (Math.imul(i + 1, 0x9e3779b1) ^ 0x5bd1e995) >>> 0;
    store = recordPlayed(store, seed, GEN_VERSION, NOW - (Math.max(0, nWorlds) - i) * 3_600_000 * (i % 3 === 0 ? 30 : 1)).store;
    const w = store.worlds[0]!;
    if (i < NAMES.length) store = { ...store, worlds: store.worlds.map((x) => (x.id === w.id ? { ...x, name: NAMES[i]! } : x)) };
  }
  if (nWorlds === 0 || params.get('fresh') === '1') localStorage.removeItem(WORLDS_KEY);
  else saveWorlds(localStorage, store);
}

let settings: Settings = cloneSettings(DEFAULT_SETTINGS);
if (params.get('units') === 'ft') settings.units = 'ft';
const root = document.getElementById('ui')!;
const hud = new Hud(root, onAction, localStorage);
const origToast = hud.toast.bind(hud);
hud.toast = (m: string) => {
  toasts.push(m);
  origToast(m);
};
const touch = params.get('touch') === '1';
if (touch) hud.enableTouch(false);
const input = new InputManager(window, settings, touch);
const touchUi = touch ? new TouchControls(root, input.touch, stickRadius(window.innerWidth < 1000)) : null;

const cards: LevelCard[] = [
  { id: 'training', name: 'Training Field', kind: 'authored', blurb: 'Open meadow in daylight. Three big rings, room to learn.', best: 21.48 },
  { id: 'night-loft', name: 'Night Loft', kind: 'authored', blurb: 'Tight indoor course at night: twelve rings, beams and a ceiling fan.', best: 47.38 },
  { id: 'city', name: 'City', kind: 'authored', blurb: 'Downtown canyons at dusk: street slalom, rooftop hops and a dive under the skybridge.', best: null },
  { id: 'alpine', name: 'Alpine Valley', kind: 'authored', blurb: 'Golden hour in the mountains: pine slalom, the lake and a ridge run home.', best: 132.07 },
  { id: 'infinite', name: 'Infinite World', kind: 'seeded', blurb: 'Endless countryside of rivers, roads and villages. Share any world by its code.', best: null },
];
let current: LevelCard['id'] = 'training';
hud.setLevels(cards, current);

let status: RaceStatus = 'menu';
let nextRing = -1;
const world = createWorld({ seed: Number(params.get('seed') ?? 0x1234abcd) >>> 0, preset: 'infinite', genVersion: GEN_VERSION });
const sampler = terrainMinimapSampler(world.field);

function onAction(a: UiAction): void {
  actions.push(a);
  if (a.type === 'level') {
    current = a.id;
    hud.setLevels(cards, current);
    status = a.mode === 'race' ? 'racing' : 'freefly';
    nextRing = a.mode === 'race' ? 2 : -1;
    hud.setMinimapSampler(a.id === 'infinite' || a.id === 'alpine' || a.id === 'city' ? sampler : null);
    hud.showScreen('none');
  } else if (a.type === 'menu') {
    status = 'menu';
    hud.showScreen('main', { best: null });
  } else if (a.type === 'resume') {
    status = status === 'paused' ? 'freefly' : status;
    hud.showScreen('none');
  }
}

const drone: DroneState = {
  position: new Vector3(0, 40, 0),
  velocity: new Vector3(),
  orientation: new Quaternion(),
  angularVelocity: new Vector3(),
  motors: [0.4, 0.4, 0.4, 0.4],
  armed: true,
  batteryVoltage: 15.9,
};
const yAxis = new Vector3(0, 1, 0);
const pilot = { x: -40, z: 120 };
const ring = { x: 180, z: -260 };
let t = 0;
let last = performance.now();
/** fixed heading for screenshots (?heading=deg), else a slow turn */
const fixedHeading = params.has('heading') ? Number(params.get('heading')) : null;

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  t += dt;
  const inp = input.poll(dt);
  if (hud.screen !== 'none') hud.navigate(inp.nav, inp.buttons.confirm);
  else if (inp.buttons.pause && status !== 'menu') {
    status = 'paused';
    hud.showScreen('pause');
  }
  const flying = status === 'freefly' || status === 'racing';
  const heading = fixedHeading ?? 35 + 25 * Math.sin(t * 0.3);
  if (flying && fixedHeading === null) {
    const rad = (heading * Math.PI) / 180;
    drone.position.x += Math.sin(rad) * 22 * dt;
    drone.position.z -= Math.cos(rad) * 22 * dt;
  }
  drone.orientation.setFromAxisAngle(yAxis, (-heading * Math.PI) / 180);
  const ground = world.field.heightAt(drone.position.x, drone.position.z);
  const outdoor: OutdoorHud | null = current === 'infinite' || current === 'alpine' || current === 'city' ? { agl: drone.position.y - ground, pilot, ring: nextRing >= 0 ? ring : null } : null;
  const race: RaceSnapshot = { status, time: t, countdown: 0, nextRing, totalRings: nextRing >= 0 ? 16 : 0, bestTime: null, lastSplit: null };
  hud.update({ race, drone, input: inp, fps: 60, mode: 'angle', camera: 'fpv', altitude: drone.position.y, speed: 22, tier: 'high', settings, outdoor });
  if (touchUi) {
    touchUi.setVisible(flying && hud.screen === 'none');
    touchUi.update(settings, true, 'angle', 'fpv');
  }
  requestAnimationFrame(frame);
}

const screen = params.get('screen') ?? 'levels';
if (screen === 'hud' || screen === 'race' || screen === 'pause') {
  onAction({ type: 'level', id: 'infinite', mode: screen === 'race' ? 'race' : 'freefly', seed: world.field.seed, gen: GEN_VERSION });
  actions.length = 0;
  if (screen === 'pause') {
    status = 'paused';
    hud.showScreen('pause');
  }
} else if (screen === 'main' || screen === 'levels' || screen === 'worlds' || screen === 'settings') {
  hud.showScreen('main', { best: null });
  if (screen !== 'main') hud.showScreen(screen);
}
requestAnimationFrame(frame);

/** e2e / review hooks */
(window as unknown as { __worldsUi: unknown }).__worldsUi = {
  actions,
  toasts,
  get screen() {
    return hud.screen;
  },
  show: (s: Parameters<Hud['showScreen']>[0]) => hud.showScreen(s),
  /** a gamepad B / d-pad press, which never goes through the text field's key handler */
  pad: (k: 'up' | 'down' | 'left' | 'right' | 'back') => hud.navigate({ up: k === 'up', down: k === 'down', left: k === 'left', right: k === 'right', back: k === 'back' }, false),
  setSettings: (patch: Partial<Settings>) => {
    settings = { ...settings, ...patch };
    hud.setSettings(settings);
  },
  /** what the XR pause card would say right now */
  xrPause: () =>
    xrHudContent({
      race: { status: 'paused', time: 0, countdown: 0, nextRing: -1, totalRings: 0, bestTime: null, lastSplit: null },
      armed: true,
      latched: false,
      mode: 'angle',
      camera: 'fpv',
      altitude: drone.position.y,
      speed: 0,
      toast: '',
      level: 'Infinite World',
      world: '',
      outdoor: { agl: drone.position.y - world.field.heightAt(drone.position.x, drone.position.z), pilotDistance: Math.hypot(drone.position.x - pilot.x, drone.position.z - pilot.z) },
      units: settings.units,
    }),
};
