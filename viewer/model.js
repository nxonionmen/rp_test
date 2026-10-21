// 3D 모델 보기 — viewer/app.js 가 모델 항목을 고르면 이 모듈을 불러 상세 칸에 그린다.
// GLB(EXT_meshopt_compression · KHR_mesh_quantization · EXT_texture_webp)를 GLTFLoader 로 올리고, 클립이 있으면 재생한다.
// WebGL 컨텍스트는 하나를 계속 쓴다(항목마다 새로 만들면 브라우저의 컨텍스트 한도에 걸린다).
// 항목의 view 힌트: front('-Z' 면 카메라를 −Z 쪽에) · bounds({min,max} 프레이밍 상자) · hide(기본 숨김 노드 정규식) · hideLabel ·
//                  clipAutoplay(처음 재생할 클립 정규식) · clipLabelTrim(클립 목록에서 뗄 머리말)
// 게임 플러그인(viewer/plugins/<plugin>.js) 훅:
//   loadModel({ THREE, loader, item, ctx, onProgress, isCurrent })  파일 하나로 끝나지 않는 조립. { scene, animations } 또는 null(기본 로드)
//   prepareModel({ THREE, gltf, item, ctx })                         장면에 넣기 전
//   mountModel({ THREE, gltf, item, ctx, stage, isCurrent })         장면에 넣은 뒤(마커 · 표정). 정리 함수를 돌려준다
// 플러그인이 붙이는 userData: frameExclude(프레이밍에서 뺀다) · outline(통계에서 뺀다, 외곽선 껍데기)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const PRECISE_VERTS = 1_500_000; // 프레이밍 상자를 정점 단위(스키닝 반영)로 잴 상한. 넘으면 지오메트리 상자를 쓴다
const DEFAULT_ENV = { background: '#0b0e12', hemi: ['#ffffff', '#39404a', 1.8], sun: ['#ffffff', 2.0, [2, 4, 3]] };
const plugins = new Map();
let S = null;

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'selected') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const fmt = (n) => Number(n || 0).toLocaleString('ko-KR');

export function newLoader() {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

export async function loadPlugin(name) {
  if (!name) return null;
  if (!plugins.has(name)) plugins.set(name, import('./plugins/' + name + '.js').then((m) => m.default || m).catch((e) => { console.warn('플러그인을 읽지 못했습니다', name, e); return null; }));
  return plugins.get(name);
}

function shared(host) {
  if (!S) {
    const canvas = document.createElement('canvas');
    canvas.className = 'gl';
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e5);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.autoRotateSpeed = 3;
    const hemi = new THREE.HemisphereLight();
    const sun = new THREE.DirectionalLight();
    scene.add(hemi, sun);
    const grid = new THREE.GridHelper(10, 20, 0x3b4452, 0x232a34);
    const axes = new THREE.AxesHelper(1);
    const root = new THREE.Group();
    scene.add(grid, axes, root);
    S = { canvas, renderer, scene, camera, controls, hemi, sun, grid, axes, root, clock: new THREE.Clock(), mixer: null, speed: 1, onFrame: null, running: false };
  }
  if (S.canvas.parentNode !== host) host.prepend(S.canvas);
  S.canvas.style.display = 'block';
  return S;
}

function applyEnv(s, render) {
  const env = { ...DEFAULT_ENV, ...(render || {}) };
  s.scene.background.set(env.background);
  s.hemi.color.set(env.hemi[0]);
  s.hemi.groundColor.set(env.hemi[1]);
  s.hemi.intensity = env.hemi[2];
  s.sun.color.set(env.sun[0]);
  s.sun.intensity = env.sun[1];
  s.sun.position.fromArray(env.sun[2]);
  return env;
}

// 탭이 숨으면 requestAnimationFrame 이 멈춘다. 그래도 한 장은 그려 두도록 고른 직후에는 바로 한 번 그린다
function frame() {
  const dt = S.clock.getDelta();
  if (S.mixer) S.mixer.update(dt * S.speed);
  S.controls.update(dt);
  S.renderer.render(S.scene, S.camera);
  if (S.onFrame) S.onFrame();
}
function loop() {
  if (!S || !S.running) return;
  requestAnimationFrame(loop);
  frame();
}

function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    for (const m of [].concat(o.material || [])) {
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      if (m.dispose) m.dispose();
    }
  });
}

function clearRoot(s) {
  for (const child of [...s.root.children]) {
    s.root.remove(child);
    disposeObject(child);
  }
}

function sceneStats(root) {
  let meshes = 0; let tris = 0; let bones = 0; let verts = 0;
  const materials = new Set();
  const textures = new Set();
  root.traverse((o) => { if (o.isBone) bones += 1; });
  root.traverseVisible((o) => { // 숨긴 하늘 · 충돌은 세지 않는다
    if (!o.isMesh || o.userData.outline) return;
    meshes += 1;
    const pos = o.geometry?.attributes?.position;
    if (pos) {
      verts += pos.count;
      tris += (o.geometry.index ? o.geometry.index.count : pos.count) / 3;
    }
    for (const m of [].concat(o.material || [])) {
      materials.add(m);
      for (const v of Object.values(m)) if (v && v.isTexture) textures.add(v);
    }
  });
  return { meshes, tris: Math.round(tris), verts, bones, materials: materials.size, textures: textures.size };
}

// GLTFLoader 는 겹치는 노드 이름에 _N 을 붙이고 원래 이름을 userData.name 에 남긴다
export const nodeName = (o) => o?.userData?.name || o?.name || '';

function safeRegExp(pattern) {
  if (!pattern) return null;
  try { return new RegExp(pattern, 'i'); } catch { return null; }
}

function toggleButton(label, on, apply) {
  const b = h('button', { type: 'button', class: 'tb', 'aria-pressed': String(on) }, label);
  b.addEventListener('click', () => {
    const v = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(v));
    apply(v);
  });
  return b;
}

function spinner(host, text) {
  const box = h('div', { class: 'm3d-loading' }, h('span', { class: 'dot' }), h('span', { class: 'txt', text }));
  host.append(box);
  return { set: (t) => { box.querySelector('.txt').textContent = t; }, remove: () => box.remove() };
}

export default class ModelView {
  // ctx: { url(rel) → 절대 주소, render(배경 · 조명), plugin(플러그인 모듈), items(category) → 목록 }
  constructor({ host, toolbar, timeline, ctx, isCurrent }) {
    Object.assign(this, { host, toolbar, timeline, ctx, isCurrent });
    this.frameHooks = [];
    this.hiddenNodes = [];
    this.clipState = null;
    this.cleanup = null;
    this.unmounted = false;
  }

  async mount(item) {
    if (!item.file && !item.assembly) throw new Error('모델 파일이 없는 항목입니다.');
    const plugin = this.ctx.plugin;
    const s = shared(this.host);
    this.s = s;
    this.item = item;
    clearRoot(s);
    this.env = applyEnv(s, this.ctx.render);
    s.mixer = null;
    s.onFrame = () => { for (const fn of this.frameHooks) fn(); };
    s.speed = 1;
    const spin = spinner(this.host, '모델을 불러오는 중');
    let gltf = null;
    try {
      if (plugin?.loadModel) {
        gltf = await plugin.loadModel({ THREE, loader: newLoader(), item, ctx: this.ctx, onProgress: (text) => spin.set(text), isCurrent: this.isCurrent });
      }
      if (!this.isCurrent()) { if (gltf) disposeObject(gltf.scene); return; }
      if (!gltf) {
        gltf = await newLoader().loadAsync(this.ctx.url(item.file), (ev) => {
          if (ev.total) spin.set(`모델을 불러오는 중 ${Math.round((ev.loaded / ev.total) * 100)}%`);
        });
      }
      if (!this.isCurrent()) { disposeObject(gltf.scene); return; }
      if (plugin?.prepareModel) await plugin.prepareModel({ THREE, gltf, item, ctx: this.ctx });
      if (!this.isCurrent()) { disposeObject(gltf.scene); return; }
    } finally {
      spin.remove();
    }
    gltf.animations ??= [];
    this.gltf = gltf;
    s.root.add(gltf.scene);
    this.hiddenNodes = this.applyHide(gltf.scene, item.view?.hide);
    const stats = sceneStats(gltf.scene);
    this.stats = stats;
    let skeleton = null;
    if (stats.bones) {
      skeleton = new THREE.SkeletonHelper(gltf.scene);
      skeleton.visible = stats.meshes === 0;
      s.root.add(skeleton);
    }
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.resize();
    this.fit();
    this.buildToolbar(stats, skeleton);
    if (gltf.animations.length) this.buildTimeline(gltf, item);
    if (!s.running) {
      s.running = true;
      s.clock.getDelta();
      loop();
    }
    if (plugin?.mountModel) {
      const cleanup = await plugin.mountModel({ THREE, gltf, item, ctx: this.ctx, stage: this.stage(), isCurrent: this.isCurrent });
      if (typeof cleanup === 'function') {
        if (this.isCurrent() && !this.unmounted) this.cleanup = cleanup;
        else cleanup();
      }
    }
    frame();
  }

  // 플러그인에 넘기는 무대. 플러그인이 root 에 넣은 객체는 항목을 바꿀 때 정리 함수와 clearRoot 가 치운다.
  stage() {
    const s = this.s;
    return {
      root: s.root,
      scene: s.scene,
      camera: s.camera,
      addToggle: (label, on, apply) => {
        const b = toggleButton(label, on, apply);
        this.toolbar.insertBefore(b, this.toolbar.querySelector('.tb-note'));
        return b;
      },
      addNote: (text, title) => {
        const note = h('span', { class: 'tb-note', title: title || null }, text);
        this.toolbar.append(note);
        return note;
      },
      onFrame: (fn) => { this.frameHooks.push(fn); },
      clip: () => this.clipState,
      fit: () => this.fit(),
    };
  }

  applyHide(root, pattern) {
    const re = safeRegExp(pattern);
    if (!re) return [];
    const hits = [];
    root.traverse((o) => {
      if (o.isMesh && (re.test(nodeName(o)) || re.test(nodeName(o.parent)))) hits.push(o);
    });
    for (const o of hits) o.visible = false;
    return hits;
  }

  resize() {
    const w = this.host.clientWidth;
    const hgt = this.host.clientHeight;
    if (!w || !hgt || !this.s) return;
    this.s.renderer.setSize(w, hgt, false);
    this.s.camera.aspect = w / hgt;
    this.s.camera.updateProjectionMatrix();
  }

  // 프레이밍 상자: view.bounds 가 있으면 그것(스키닝 모델은 이 값이 정확하다), 없으면 보이는 메시 상자.
  bounds() {
    const b = this.item?.view?.bounds;
    if (Array.isArray(b?.min) && Array.isArray(b?.max)) {
      return new THREE.Box3(new THREE.Vector3().fromArray(b.min), new THREE.Vector3().fromArray(b.max));
    }
    const root = this.gltf ? this.gltf.scene : this.s.root;
    // updateWorldMatrix 는 SkinnedMesh.bindMatrixInverse 를 다시 계산하지 않는다. 첫 렌더 전에 행렬을 모두 갱신한다
    root.updateWorldMatrix(true, false);
    root.updateMatrixWorld(true);
    const precise = (this.stats?.verts ?? 0) <= PRECISE_VERTS;
    const box = new THREE.Box3();
    const part = new THREE.Box3();
    const v = new THREE.Vector3();
    root.traverseVisible((o) => {
      const pos = o.isMesh ? o.geometry?.attributes?.position : null;
      if (!pos || o.userData.frameExclude || o.userData.outline) return;
      if (precise) {
        for (let i = 0; i < pos.count; i += 1) box.expandByPoint(o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld));
      } else {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        box.union(part.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld));
      }
    });
    return box;
  }

  fit() {
    const s = this.s;
    const box = this.bounds();
    if (box.isEmpty()) {
      s.camera.position.set(3, 2, 3);
      s.controls.target.set(0, 0, 0);
      s.controls.update();
      return;
    }
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const halfFov = (s.camera.fov * Math.PI) / 360;
    const limitingFov = Math.atan(Math.tan(halfFov) * Math.min(1, s.camera.aspect));
    const dist = (size.length() / 2 / Math.sin(limitingFov)) * 1.1;
    const side = this.item?.view?.front === '-Z' ? -1 : 1;
    s.camera.near = Math.max(maxDim / 2000, 0.0005);
    s.camera.far = maxDim * 2000;
    s.camera.updateProjectionMatrix();
    s.camera.position.copy(center).add(new THREE.Vector3(0.9 * side, 0.55, side).normalize().multiplyScalar(dist));
    s.controls.target.copy(center);
    s.controls.update();
    const gridSize = 10 ** Math.ceil(Math.log10(maxDim * 1.5));
    s.grid.scale.setScalar(gridSize / 10);
    s.grid.position.set(center.x, box.min.y, center.z);
    s.axes.scale.setScalar(maxDim * 0.6);
    s.axes.position.set(center.x, box.min.y, center.z);
  }

  buildToolbar(stats, skeleton) {
    const s = this.s;
    const backgrounds = [this.env.background, '#3a4350', '#d8dde4'];
    let bg = 0;
    const hidden = this.hiddenNodes;
    this.toolbar.replaceChildren(
      h('button', { type: 'button', class: 'tb', onclick: () => this.fit() }, '맞춤'),
      toggleButton('와이어프레임', false, (v) => this.gltf.scene.traverse((o) => {
        if (o.isMesh && !o.userData.outline) for (const m of [].concat(o.material || [])) m.wireframe = v;
      })),
      toggleButton('자동 회전', s.controls.autoRotate, (v) => { s.controls.autoRotate = v; }),
      toggleButton('그리드', s.grid.visible, (v) => { s.grid.visible = v; }),
      toggleButton('축', s.axes.visible, (v) => { s.axes.visible = v; }),
      h('button', { type: 'button', class: 'tb', onclick: () => { bg = (bg + 1) % backgrounds.length; s.scene.background.set(backgrounds[bg]); } }, '배경'),
      ...(skeleton ? [toggleButton('뼈대', skeleton.visible, (v) => { skeleton.visible = v; })] : []),
      ...(hidden.length ? [toggleButton(`${this.item.view?.hideLabel || '숨긴 노드'} ${hidden.length}`, false, (v) => { for (const o of hidden) o.visible = v; })] : []),
      h('span', { class: 'tb-note' },
        `삼각형 ${fmt(stats.tris)} · 메시 ${stats.meshes} · 재질 ${stats.materials} · 텍스처 ${stats.textures} · 뼈 ${stats.bones}`),
    );
  }

  buildTimeline(gltf, item) {
    const s = this.s;
    const mixer = new THREE.AnimationMixer(gltf.scene);
    s.mixer = mixer;
    let action = null;
    let clip = null;
    const trim = item.view?.clipLabelTrim || '';
    const clipLabel = (c, i) => {
      const name = c.name || `클립 ${i + 1}`;
      return trim && name.startsWith(trim) ? name.slice(trim.length) : name;
    };
    const select = h('select', { 'aria-label': '동작' }, ...gltf.animations.map((c, i) => h('option', { value: String(i) }, `${clipLabel(c, i)} (${c.duration.toFixed(2)}s)`)));
    const play = h('button', { type: 'button', class: 'tb' }, '일시정지');
    const range = h('input', { type: 'range', min: '0', max: '1', step: '0.001', value: '0', 'aria-label': '재생 위치' });
    const time = h('span', { class: 'time' }, '0.00 / 0.00');
    const speed = h('select', { 'aria-label': '재생 속도' }, ...[0.25, 0.5, 1, 2].map((v) => h('option', { value: String(v), selected: v === 1 }, `${v}×`)));
    const use = (i) => {
      if (action) action.stop();
      clip = gltf.animations[i];
      action = mixer.clipAction(clip);
      action.reset().play();
      this.clipState = { clip, action };
      play.textContent = '일시정지';
    };
    select.addEventListener('change', () => use(Number(select.value)));
    play.addEventListener('click', () => {
      if (!action) return;
      action.paused = !action.paused;
      play.textContent = action.paused ? '재생' : '일시정지';
    });
    range.addEventListener('input', () => {
      if (!action || !clip) return;
      action.paused = true;
      play.textContent = '재생';
      action.time = Number(range.value) * clip.duration;
      mixer.update(0);
    });
    speed.addEventListener('change', () => { s.speed = Number(speed.value); });
    this.frameHooks.push(() => {
      if (!action || !clip || !clip.duration) return;
      const t = action.time % clip.duration;
      if (document.activeElement !== range) range.value = String(t / clip.duration);
      time.textContent = `${t.toFixed(2)} / ${clip.duration.toFixed(2)}`;
    });
    this.timeline.replaceChildren(select, play, range, time, speed);
    this.timeline.hidden = false;
    const auto = safeRegExp(item.view?.clipAutoplay);
    const first = auto ? Math.max(0, gltf.animations.findIndex((c) => auto.test(c.name || ''))) : 0;
    select.value = String(first);
    use(first);
  }

  unmount() {
    this.unmounted = true;
    if (this.cleanup) {
      try { this.cleanup(); } catch (e) { console.warn(e); }
      this.cleanup = null;
    }
    const s = this.s;
    if (!s) return;
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (s.mixer) s.mixer.stopAllAction();
    s.mixer = null;
    s.onFrame = null;
    this.frameHooks = [];
    this.clipState = null;
    clearRoot(s);
    s.running = false;
    s.canvas.style.display = 'none';
  }
}
