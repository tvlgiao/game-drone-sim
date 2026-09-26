/**
 * `?selftest=1`: scripted on-device flight through the real touch code path. Synthetic touch
 * PointerEvents drive the virtual sticks and the ARM button (arm → climb to ~1.5 m → fly forward →
 * land → disarm), then an on-screen PASS/FAIL panel reports fps, tier, DPR, render scale, touch UI
 * and fullscreen capability. Results are also exposed as `window.__selftest` for automation.
 */
import type { DeviceInfo } from '../core/device';
import { slotOf, throttleSlot, type StickModeNum } from '../input/stick';
import type { StickTrack, TouchSticks } from '../input/touch';

export interface SelfTestHook {
  action: (a: { type: 'freefly' | 'menu' }) => void;
  readonly state: { position: { x: number; y: number; z: number }; velocity: { y: number } };
  readonly armed: boolean;
  readonly fps: number;
  readonly tier: string;
  readonly pixelRatio: number;
  readonly renderScale: number;
  readonly touchVisible: boolean;
  readonly rotateOverlay: boolean;
  readonly source: string;
  readonly device: DeviceInfo;
  touch: { layer: HTMLElement | null; sticks: TouchSticks };
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** informational: does not fail the run */
  soft?: boolean;
}

export interface SelfTestResult {
  done: boolean;
  pass: boolean;
  fps: number;
  checks: Check[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export async function runSelfTest(h: SelfTestHook, stickMode: StickModeNum = 2): Promise<SelfTestResult> {
  const result: SelfTestResult = { done: false, pass: false, fps: 0, checks: [] };
  (window as unknown as { __selftest: SelfTestResult }).__selftest = result;
  const errors: string[] = [];
  window.addEventListener('error', (e) => errors.push(e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  const panel = makePanel();
  const status = (msg: string): void => {
    panel.status.textContent = msg;
  };

  const layer = h.touch.layer;
  const sticks = h.touch.sticks;
  const fpsSamples: number[] = [];
  let maxAlt = 0;
  let touchSeen = false;
  let sourceSeen = '';
  const sampler = window.setInterval(() => {
    fpsSamples.push(h.fps);
    maxAlt = Math.max(maxAlt, h.state.position.y);
    touchSeen ||= h.touchVisible;
    if (!sourceSeen && h.touchVisible) sourceSeen = h.source;
  }, 250);

  let armedOk = false;
  let disarmedOk = false;
  let moved = 0;
  let landedY = NaN;
  try {
    // Phones in portrait show the rotate overlay (and pause): wait for landscape first.
    if (h.rotateOverlay) status('Rotate to landscape to start…');
    while (h.rotateOverlay) await sleep(200);
    await sleep(500);
    status('Starting free fly…');
    h.action({ type: 'freefly' });
    if (!layer) throw new Error('no touch layer (not a touch device)');
    const t0 = performance.now();
    while (!h.touchVisible && performance.now() - t0 < 3000) await sleep(50);

    const rect = layer.getBoundingClientRect();
    const R = sticks.opts.radius;
    const thrSide = throttleSlot(stickMode) === 'ly' ? 'l' : 'r';
    const pitchSide = slotOf(stickMode, 'pitch')[0] as 'l' | 'r';
    const thr = sticks.track(thrSide);
    const pit = sticks.track(pitchSide);
    const knob = (t: StickTrack): [number, number] => [rect.left + t.cx + t.x * R, rect.top + t.cy - t.y * R];
    const send = (type: string, target: Element, id: number, x: number, y: number): void => {
      target.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 11, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    };
    const tap = async (name: string): Promise<void> => {
      const btn = layer.querySelector<HTMLElement>(`[data-tbtn="${name}"]`)!;
      const b = btn.getBoundingClientRect();
      send('pointerdown', btn, 31, b.left + b.width / 2, b.top + b.height / 2);
      await sleep(60);
      send('pointerup', btn, 31, b.left + b.width / 2, b.top + b.height / 2);
      await sleep(120);
    };

    // Throttle thumb down on its knob (no jump), pulled fully down.
    status('Throttle down, arming…');
    let [tx, ty] = knob(thr);
    send('pointerdown', layer, 11, tx, ty);
    const setThrottle = (v01: number): void => {
      const v = clamp(v01, 0, 1) * 2 - 1;
      send('pointermove', layer, 11, rect.left + thr.cx, rect.top + thr.cy - v * R);
    };
    setThrottle(0);
    await sleep(150);
    await tap('arm');
    armedOk = h.armed;
    if (!armedOk) throw new Error('arming refused');

    // Closed-loop altitude hold through the stick (stick centre ≈ hover in Angle mode).
    let target = 1.5;
    const pilot = window.setInterval(() => {
      const y = h.state.position.y;
      const vy = h.state.velocity.y;
      setThrottle(target < 0 ? 0 : 0.5 + 0.35 * (target - y) - 0.2 * vy);
    }, 16);
    status('Climbing to 1.5 m…');
    await sleep(3000);

    status('Forward…');
    const p0 = { x: h.state.position.x, z: h.state.position.z };
    [tx, ty] = knob(pit);
    send('pointerdown', layer, 12, tx, ty);
    for (let i = 1; i <= 10; i++) {
      send('pointermove', layer, 12, tx, ty - 0.035 * R * i);
      await sleep(30);
    }
    await sleep(1700);
    send('pointerup', layer, 12, tx, ty - 0.35 * R);
    await sleep(1200);
    moved = Math.hypot(h.state.position.x - p0.x, h.state.position.z - p0.z);

    status('Landing…');
    for (let i = 0; i < 30 && h.state.position.y > 0.2; i++) {
      target = Math.max(0.05, target - 0.1);
      await sleep(100);
    }
    target = -1;
    await sleep(900);
    window.clearInterval(pilot);
    setThrottle(0);
    await sleep(200);
    landedY = h.state.position.y;
    await tap('arm');
    disarmedOk = !h.armed;
    send('pointerup', layer, 11, rect.left + thr.cx, rect.top + thr.cy + R);
  } catch (err) {
    errors.push((err as Error).message);
  } finally {
    window.clearInterval(sampler);
  }

  const fps = fpsSamples.length ? fpsSamples.slice(Math.floor(fpsSamples.length / 4)).reduce((a, b) => a + b, 0) / Math.max(1, fpsSamples.length - Math.floor(fpsSamples.length / 4)) : 0;
  const d = h.device;
  const c: Check[] = [
    { name: 'Touch UI visible', ok: touchSeen, detail: touchSeen ? 'yes' : 'no' },
    { name: 'Input source', ok: sourceSeen === 'touch', detail: sourceSeen || '—' },
    { name: 'Armed via ARM tap', ok: armedOk, detail: armedOk ? 'yes' : 'no' },
    { name: 'Climb ≈ 1.5 m', ok: maxAlt > 1.0 && maxAlt < 2.6, detail: `${maxAlt.toFixed(2)} m max` },
    { name: 'Forward flight', ok: moved > 0.5, detail: `${moved.toFixed(2)} m` },
    { name: 'Landed', ok: landedY < 0.3, detail: Number.isFinite(landedY) ? `${landedY.toFixed(2)} m` : '—' },
    { name: 'Disarmed via ARM tap', ok: disarmedOk, detail: disarmedOk ? 'yes' : 'no' },
    { name: 'No errors', ok: errors.length === 0, detail: errors.length ? errors.slice(0, 2).join(' | ') : 'none' },
    { name: 'FPS', ok: fps >= 50, detail: `${fps.toFixed(1)} (target 60)`, soft: true },
    { name: 'Tier / DPR / scale', ok: true, detail: `${h.tier} · ${h.pixelRatio.toFixed(2)} · ${h.renderScale.toFixed(2)}`, soft: true },
    { name: 'Device', ok: true, detail: `${d.form}${d.ios ? ' · iOS' : ''}${d.standalone ? ' · home-screen app' : ''}`, soft: true },
    { name: 'Viewport', ok: true, detail: `${window.innerWidth}×${window.innerHeight} · zoom ${(window.visualViewport?.scale ?? 1).toFixed(2)} · dpr ${window.devicePixelRatio}`, soft: true },
    { name: 'Fullscreen API', ok: true, detail: d.standalone ? 'n/a (standalone)' : d.fullscreen ? 'supported' : 'unsupported → Add to Home Screen', soft: true },
  ];
  result.checks = c;
  result.fps = fps;
  result.pass = c.every((x) => x.ok || x.soft);
  result.done = true;
  renderPanel(panel, result);
  h.action({ type: 'menu' });
  console.info(`[selftest] ${result.pass ? 'PASS' : 'FAIL'} fps=${fps.toFixed(1)} ${c.map((x) => `${x.name}=${x.detail}`).join('; ')}`);
  return result;
}

interface Panel {
  root: HTMLElement;
  status: HTMLElement;
  body: HTMLElement;
}

function makePanel(): Panel {
  const root = document.createElement('div');
  root.className = 'ds-selftest';
  root.style.cssText =
    'position:fixed;z-index:100;top:max(8px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);width:min(460px,calc(100% - 24px));max-height:calc(100% - 16px);overflow:auto;' +
    'box-sizing:border-box;padding:10px 14px;border-radius:12px;background:rgba(4,8,16,.86);border:1px solid rgba(40,231,255,.45);color:#eaf6ff;font:12px/1.4 ui-monospace,Menlo,monospace;pointer-events:auto;';
  const title = document.createElement('div');
  title.style.cssText = 'font-weight:800;letter-spacing:.14em;margin-bottom:4px';
  title.textContent = 'SELFTEST · touch flight';
  const status = document.createElement('div');
  status.style.color = '#28e7ff';
  const body = document.createElement('div');
  root.append(title, status, body);
  document.body.appendChild(root);
  return { root, status, body };
}

function renderPanel(p: Panel, r: SelfTestResult): void {
  p.status.textContent = r.pass ? 'PASS' : 'FAIL';
  p.status.style.cssText = `font-size:20px;font-weight:900;letter-spacing:.2em;color:${r.pass ? '#3dffa0' : '#ff4661'}`;
  p.root.style.borderColor = r.pass ? 'rgba(61,255,160,.7)' : 'rgba(255,70,97,.8)';
  p.body.textContent = '';
  for (const c of r.checks) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;gap:12px';
    const a = document.createElement('span');
    a.textContent = `${c.soft ? '·' : c.ok ? '✓' : '✗'} ${c.name}`;
    a.style.color = c.soft ? '#9fb3c8' : c.ok ? '#3dffa0' : '#ff4661';
    const b = document.createElement('span');
    b.textContent = c.detail;
    b.style.textAlign = 'right';
    row.append(a, b);
    p.body.appendChild(row);
  }
}
