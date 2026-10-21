// 버블파이터 렌더 보정. 공통 모델 보기(viewer/model.js)가 view 의 front(−Z 정면) · bounds · hide(하늘) ·
// clipAutoplay(stand$) · clipLabelTrim 을 처리하고, 이 플러그인은 장면에 넣은 뒤 세 가지를 더한다.
// 1) 무기 · NPC 마커: 항목 markers{뼈 이름: [x, y, z]}. glTF 바인드 포즈 월드 좌표라 배율 1, 반전 없음.
// 2) 맵 게임 마커: 항목 mapMarkers.file 의 helpers[]. 원본 좌표 × scale, flipZ 면 Z 를 뒤집는다.
// 3) 표정: 항목 detail 의 face.timelines[클립] = [[초, 표정 이름]], face.frames[표정 이름] = PNG.
//    Face 메시는 userData.name 으로 찾는다(로더가 겹치는 이름에 _N 을 붙인다). PNG 는 sRGB · flipY=false 로 읽는다.
// 점 크기는 월드 단위 대신 화면 픽셀로 고정했다(무기 3 단위부터 NPC 230 단위까지 같은 크기로 보이게).
const PROP_MARKERS = [
  { label: '발사 지점', test: /FirePoint/i, color: 0xff453a, px: 11 },
  { label: '쥐는 위치', test: /^Bip01_R_Hand_/i, color: 0x64d2ff, px: 9 },
  { label: '효과', test: /EffectPoint|Effect/i, color: 0xffd60a, px: 8 },
  { label: '총구', test: /muzzle|Nozzle/i, color: 0xff9f0a, px: 9 },
];
const PROP_OTHER = { label: '기타', color: 0xc7ccd4, px: 7 };
const MAP_GROUPS = {
  spawn: { color: 0x39d353, px: 10 },
  soundpoint: { color: 0x5aa9ff, px: 6 },
  eff: { color: 0xffb454, px: 6 },
  zombie: { color: 0xff5a5a, px: 6 },
  ic: { color: 0xc678dd, px: 6 },
  ib: { color: 0xc678dd, px: 6 },
  sp: { color: 0x56d4dd, px: 6 },
  lp: { color: 0x56d4dd, px: 6 },
};
const MAP_OTHER = { color: 0x9aa4b2, px: 6 };
const FACE = /^face$/i;

const nodeName = (o) => o?.userData?.name || o?.name || '';

function points(THREE, positions, style) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({ color: style.color, size: style.px, sizeAttenuation: false, depthTest: false, transparent: true });
  const cloud = new THREE.Points(geometry, material);
  cloud.renderOrder = 999;
  cloud.frustumCulled = false;
  return cloud;
}

function attach(THREE, stage, groups, label, title) {
  const group = new THREE.Group();
  group.name = 'bf-markers';
  for (const { style, positions } of groups) group.add(points(THREE, positions, style));
  stage.root.add(group);
  const button = stage.addToggle(label, true, (v) => { group.visible = v; });
  button.title = title;
  return () => {
    group.removeFromParent();
    group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    button.remove();
  };
}

function propMarkers(THREE, markers, stage) {
  const byKind = new Map();
  for (const [name, p] of Object.entries(markers)) {
    if (!Array.isArray(p) || p.length < 3) continue;
    const kind = PROP_MARKERS.find((k) => k.test.test(name)) || PROP_OTHER;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(p[0], p[1], p[2]);
  }
  if (!byKind.size) return null;
  const groups = [...byKind].map(([style, positions]) => ({ style, positions }));
  const summary = [...byKind].map(([kind, pos]) => `${kind.label} ${pos.length / 3}`).join(' · ');
  return attach(THREE, stage, groups, `마커 ${Object.keys(markers).length}`, `${summary}\n${Object.keys(markers).join('\n')}`);
}

function mapMarkers(THREE, data, spec, stage) {
  const scale = Number(spec.scale) || 0.01;
  const flip = spec.flipZ ? -1 : 1;
  const byGroup = new Map();
  for (const helper of data.helpers || []) {
    const p = helper.pos;
    if (!Array.isArray(p) || p.length < 3) continue;
    const key = String(helper.group || '?');
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(p[0] * scale, p[1] * scale, p[2] * scale * flip);
  }
  if (!byGroup.size) return null;
  const groups = [...byGroup].map(([key, positions]) => ({ style: MAP_GROUPS[key.toLowerCase()] || MAP_OTHER, positions }));
  const total = [...byGroup.values()].reduce((n, pos) => n + pos.length / 3, 0);
  const lines = [...byGroup].map(([key, pos]) => `${key} ${pos.length / 3}`);
  lines.push(`출발 지점 ${data.spawn_count ?? '-'} · 길찾기 메시 정점 ${data.navi?.vertex_count ?? '-'} · 삼각형 ${data.navi?.triangle_count ?? '-'}`);
  return attach(THREE, stage, groups, `게임 마커 ${total}`, lines.join('\n'));
}

function faceTimeline(THREE, gltf, face, ctx, stage) {
  const frames = face.frames || {};
  const timelines = face.timelines || {};
  const materials = new Set();
  gltf.scene.traverse((o) => {
    if (o.isMesh && (FACE.test(nodeName(o)) || FACE.test(nodeName(o.parent)))) {
      for (const m of [].concat(o.material || [])) materials.add(m);
    }
  });
  if (!materials.size || !Object.keys(frames).length) return null;
  const originals = new Map([...materials].map((m) => [m, m.map]));
  const loader = new THREE.TextureLoader();
  const textures = new Map();
  for (const [frame, path] of Object.entries(frames)) {
    const tex = loader.load(ctx.url(path));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    textures.set(frame, tex);
  }
  let enabled = true;
  let shown = null;
  const show = (tex) => {
    for (const m of materials) {
      m.map = tex ?? originals.get(m);
      m.needsUpdate = true;
    }
  };
  const button = stage.addToggle(`표정 ${textures.size}`, true, (v) => {
    enabled = v;
    shown = null;
    delete button.dataset.shown;
    if (!v) show(null);
  });
  stage.onFrame(() => {
    const state = stage.clip();
    if (!enabled || !state) return;
    const line = timelines[state.clip.name];
    if (!line?.length) return;
    const t = state.clip.duration ? state.action.time % state.clip.duration : 0;
    let frame = line[0][1];
    let best = -Infinity;
    for (const [sec, name] of line) {
      if (sec <= t + 1e-4 && sec >= best) { best = sec; frame = name; }
    }
    if (frame === shown || !textures.has(frame)) return;
    shown = frame;
    button.dataset.shown = frame;
    show(textures.get(frame));
  });
  return () => {
    show(null);
    for (const tex of textures.values()) tex.dispose();
    button.remove();
  };
}

export async function mountModel({ THREE, gltf, item, ctx, stage, isCurrent }) {
  const cleanups = [];
  const cleanup = () => { for (const fn of cleanups.splice(0)) fn?.(); };
  if (item.markers) cleanups.push(propMarkers(THREE, item.markers, stage));
  if (item.detail) {
    const detail = await ctx.json(item.detail).catch((e) => { console.warn('표정 정보를 읽지 못했습니다', e); return null; });
    if (!isCurrent()) return cleanup;
    if (detail?.face) cleanups.push(faceTimeline(THREE, gltf, detail.face, ctx, stage));
  }
  if (item.mapMarkers?.file) {
    const data = await ctx.json(item.mapMarkers.file).catch((e) => { console.warn('맵 마커를 읽지 못했습니다', e); return null; });
    if (data && isCurrent()) cleanups.push(mapMarkers(THREE, data, item.mapMarkers, stage));
  }
  return cleanup;
}

export default { mountModel };
