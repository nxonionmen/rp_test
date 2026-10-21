// 버블파이터 어드벤처(Unity 원본) 조립 · 렌더 보정.
// 파츠 GLB 안 이미지는 1×1 자리표시라 항목의 재질(assembly.materials · 상세 materials)을 GLB 메시 순회 순서대로 입힌다.
// - 툰: toon 이면 MeshToonMaterial + 램프 + ×2 오버브라이트 + 틴트(텍스처 알파가 틴트 마스크) + 외곽선.
// - 그 밖: MeshLambertMaterial(양면, 텍스처 없으면 회색, 알파면 alphaTest 0.4).
// - 조립(loadModel): character(본체 × 프리팹 배율) · weapon · map(파트별 Unity 월드 변환, X 반전) ·
//   scene(맵 + 엄폐 · 리스폰 · 조명 마커 + 캐릭터 크기 대조) · anim(기본 캐릭터 + 클립 GLB 의 animations[0]).
// - 맵 파트에 sub 가 있으면 GLB 에서 그 메시 노드만 떼어 쓴다.
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

const textures = new Map();
const warned = new Set();

const rgb = (THREE, c, fallback) => (Array.isArray(c) ? new THREE.Color(c[0], c[1], c[2]) : new THREE.Color(fallback));

function texture(THREE, ctx, path, ramp = false) {
  if (!path) return null;
  const key = `${ramp ? 'ramp' : 'tex'}|${path}`;
  if (!textures.has(key)) {
    const t = new THREE.TextureLoader().load(ctx.url(path));
    t.colorSpace = THREE.SRGBColorSpace;
    if (ramp) { // 램프는 선형 보간 · 가장자리 고정 · 밉맵 없음
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
    } else {
      t.flipY = false;
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.LinearMipmapLinearFilter;
    }
    textures.set(key, t);
  }
  return textures.get(key);
}

function patch(src, from, to, tag) {
  const out = src.replace(from, to);
  if (out === src && !warned.has(tag)) {
    warned.add(tag);
    console.warn(`[어드벤처 툰] 셰이더 교체 실패: ${tag}`);
  }
  return out;
}

function toonMaterial(THREE, mi, map, ramp) {
  const m = new THREE.MeshToonMaterial({
    map: map || null, gradientMap: ramp, side: THREE.FrontSide,
    color: map ? rgb(THREE, mi.color, 0xffffff) : new THREE.Color(0x9aa4b0),
  });
  const tint = mi.tint || null; // res = c.rgb * (tint * c.a + (1 - c.a)), c.a 는 틴트 마스크
  m.userData.toon = true;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uOver = { value: 2.0 };
    sh.uniforms.uTint = { value: rgb(THREE, tint, 0xffffff) };
    let f = patch(sh.fragmentShader, 'void main() {', 'uniform float uOver;\nuniform vec3 uTint;\nvoid main() {', 'uniforms');
    if (tint) {
      f = patch(f, '#include <color_fragment>',
        '#include <color_fragment>\n#ifdef USE_MAP\n{ float ta = texture2D(map, vMapUv).a; diffuseColor.rgb *= (uTint * ta + (1.0 - ta)); }\n#endif', 'tint');
    }
    sh.fragmentShader = patch(f, /vec3 outgoingLight = ([^;]+);/, 'vec3 outgoingLight = ($1) * uOver;', 'overbright');
  };
  m.customProgramCacheKey = () => `bfa-toon|${tint ? 'tint' : 'plain'}`;
  return m;
}

function outline(THREE, mesh, mi) { // 뒷면 껍데기를 노멀 방향으로 민다
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: true,
    uniforms: { uOutline: { value: mi.outline }, uColor: { value: rgb(THREE, mi.outlineColor, 0x000000) } },
    vertexShader: `
      #include <common>
      #include <skinning_pars_vertex>
      uniform float uOutline;
      void main() {
        #include <beginnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <defaultnormal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        #include <project_vertex>
        vec3 vn = normalize(normalMatrix * objectNormal);
        vec2 offset = (projectionMatrix * vec4(vn, 0.0)).xy;
        gl_Position.xy += offset * gl_Position.w * uOutline;
      }`,
    fragmentShader: 'uniform vec3 uColor;\nvoid main() { gl_FragColor = vec4(uColor, 1.0); }',
  });
  let o;
  if (mesh.isSkinnedMesh) {
    o = new THREE.SkinnedMesh(mesh.geometry, material);
    o.bind(mesh.skeleton, mesh.bindMatrix);
    o.bindMode = mesh.bindMode;
  } else {
    o = new THREE.Mesh(mesh.geometry, material);
  }
  o.name = `${mesh.name}__outline`;
  o.frustumCulled = false;
  o.renderOrder = (mesh.renderOrder || 0) - 1;
  o.userData.outline = true;
  return o;
}

// 메시를 만날 때마다 순번을 올리고 materials[min(i, 길이-1)] 을 입힌다
function applyMaterials(THREE, ctx, root, mats, { wire = false } = {}) {
  let i = 0;
  const outlines = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mi = mats.length ? mats[Math.min(i, mats.length - 1)] : null;
    i += 1;
    const map = texture(THREE, ctx, mi?.tex);
    if (mi?.toon && !wire) {
      o.material = toonMaterial(THREE, mi, map, texture(THREE, ctx, mi.ramp, true));
      if (mi.outline) outlines.push([o, outline(THREE, o, mi)]);
    } else {
      const alpha = Boolean(mi?.alpha) || /Alpha/.test(o.name);
      const m = new THREE.MeshLambertMaterial({ map: map || null, color: map ? 0xffffff : 0x9aa4b0, side: THREE.DoubleSide,
        transparent: alpha, alphaTest: alpha ? 0.4 : 0 });
      if (wire) { m.wireframe = true; m.color.set(0xff5577); m.transparent = true; m.opacity = 0.6; }
      o.material = m;
    }
    o.frustumCulled = false;
  });
  for (const [mesh, ol] of outlines) (mesh.parent || root).add(ol);
  return i;
}

// GLB 에서 서브메시 노드 하나를 떼어 낸다. 자식 노드(다른 파트)는 버리고 자기 primitive 만 남긴다.
function takeSubMesh(scene, sub) {
  let node = null;
  scene.traverse((o) => {
    if (!node && (o.userData?.name === sub || o.name === sub) && (o.isMesh || o.children.some((c) => c.isMesh && c.userData?.name === undefined))) node = o;
  });
  if (!node) return null;
  node.removeFromParent();
  for (const child of [...node.children]) if (node.isMesh || child.userData?.name !== undefined) node.remove(child);
  node.position.set(0, 0, 0);
  node.quaternion.identity();
  node.scale.set(1, 1, 1);
  return node;
}

function placeUnity(obj, part, flip) { // 위치 x 반전, 쿼터니언 (x, −y, −z, w)
  if (part.pos) obj.position.set(flip ? -part.pos[0] : part.pos[0], part.pos[1], part.pos[2]);
  if (part.rot) obj.quaternion.set(part.rot[0], flip ? -part.rot[1] : part.rot[1], flip ? -part.rot[2] : part.rot[2], part.rot[3]);
}

function makeLoader(loader, ctx, onProgress) {
  const cache = new Map();
  let done = 0;
  return (path) => {
    if (!cache.has(path)) {
      cache.set(path, loader.loadAsync(ctx.url(path)).then((g) => {
        done += 1;
        onProgress?.(`파트를 불러오는 중 ${done}/${cache.size}`);
        return g;
      }));
    }
    return cache.get(path);
  };
}

async function assembleBody(THREE, ctx, load, asm, { clone = false } = {}) {
  const group = new THREE.Group();
  for (const part of asm.parts || []) {
    const gltf = await load(part.glb);
    const root = clone ? gltf.scene.clone(true) : gltf.scene;
    applyMaterials(THREE, ctx, root, (part.mats || []).map((i) => asm.materials[i]));
    if (part.scale) root.scale.fromArray(part.scale); // 위치 · 회전은 쓰지 않는다
    group.add(root);
  }
  return group;
}

async function assembleMap(THREE, ctx, load, detail, stats) {
  const group = new THREE.Group();
  for (const part of detail.parts || []) {
    const gltf = await load(part.glb);
    let obj = gltf.scene.clone(true);
    if (part.sub) {
      const node = takeSubMesh(obj, part.sub);
      if (node) { obj = node; stats.sub += 1; } else stats.subMissing += 1;
    }
    applyMaterials(THREE, ctx, obj, (part.mats || []).map((i) => detail.materials[i]), { wire: Boolean(part.collision) });
    placeUnity(obj, part, true);
    if (part.scale) obj.scale.fromArray(part.scale);
    obj.visible = part.collision ? false : part.active !== false;
    if (part.collision) obj.userData.collision = true;
    if (part.sky) {
      obj.traverse((o) => {
        if (!o.isMesh) return;
        o.userData.frameExclude = true;
        o.material.side = THREE.BackSide;
        o.material.depthWrite = false;
      });
    }
    group.add(obj);
  }
  return group;
}

async function sceneMarkers(THREE, ctx, load, item, detail) {
  const group = new THREE.Group();
  group.userData.bfaMarkers = true;
  const at = (p) => new THREE.Vector3(-p[0], p[1], p[2]);
  const quat = (r) => new THREE.Quaternion(r[0], -r[1], -r[2], r[3]);
  const coverGeo = new THREE.BoxGeometry(1, 1, 1);
  const coverMat = new THREE.MeshBasicMaterial({ color: 0xffcc00, transparent: true, opacity: 0.35, depthWrite: false });
  for (const c of detail.covers || []) {
    const m = new THREE.Mesh(coverGeo, coverMat);
    m.position.copy(at(c.pos));
    m.quaternion.copy(quat(c.rot));
    m.scale.fromArray(c.scale);
    group.add(m);
  }
  const sphere = new THREE.SphereGeometry(0.6, 12, 8);
  for (const r of detail.respawns || []) {
    const color = /Red/.test(r.tag) ? 0xff3344 : /Blue/.test(r.tag) ? 0x3388ff : 0x33ff88;
    const m = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({ color }));
    m.position.copy(at(r.pos));
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(r.rot[0], r.rot[1], r.rot[2], r.rot[3])).multiply(new THREE.Vector3(-1, 1, 1));
    group.add(m, new THREE.ArrowHelper(dir, m.position, 2, color));
  }
  for (const l of detail.lights || []) {
    const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.8), new THREE.MeshBasicMaterial({ color: 0xffffaa, wireframe: true }));
    m.position.copy(at(l.pos));
    group.add(m);
  }
  const ref = item.assembly?.sizeRef && (await ctx.items('3d_character')).find((it) => it.id === item.assembly.sizeRef);
  const body = ref?.assembly?.parts?.[0];
  if (body) { // 크기 대조: 리스폰 앞 8곳에 캐릭터 본체(프리팹 배율). 복제한 뒤에 재질을 입힌다
    const gltf = await load(body.glb);
    for (const r of (detail.respawns || []).slice(0, 8)) {
      const fig = cloneSkinned(gltf.scene);
      applyMaterials(THREE, ctx, fig, (body.mats || []).map((i) => ref.assembly.materials[i]));
      if (body.scale) fig.scale.fromArray(body.scale);
      fig.position.copy(at(r.pos));
      group.add(fig);
    }
  }
  return group;
}

export async function loadModel({ THREE, loader, item, ctx, onProgress, isCurrent }) {
  const asm = item.assembly || {};
  if (!asm.type) return null;
  const load = makeLoader(loader, ctx, onProgress);
  const userData = {};
  let scene = null;
  let animations = [];
  if (asm.type === 'character' || asm.type === 'weapon') {
    scene = await assembleBody(THREE, ctx, load, asm, { clone: asm.type === 'weapon' });
  } else if (asm.type === 'map') {
    const stats = { sub: 0, subMissing: 0 };
    scene = await assembleMap(THREE, ctx, load, await ctx.json(item.detail), stats);
    userData.stats = stats;
  } else if (asm.type === 'scene') {
    const stats = { sub: 0, subMissing: 0 };
    scene = new THREE.Group();
    const maps = await ctx.items('3d_map');
    for (const id of asm.maps || []) {
      const mapItem = maps.find((it) => it.id === id);
      if (!mapItem || !isCurrent()) continue;
      scene.add(await assembleMap(THREE, ctx, load, await ctx.json(mapItem.detail), stats));
    }
    scene.add(await sceneMarkers(THREE, ctx, load, item, await ctx.json(item.detail)));
    userData.stats = stats;
  } else if (asm.type === 'anim') {
    const base = asm.base && (await ctx.items('3d_character')).find((it) => it.id === asm.base);
    if (!base) return null;
    scene = await assembleBody(THREE, ctx, load, base.assembly);
    const clip = (await load(item.file)).animations[0];
    if (clip) {
      clip.name = item.name; // 클립 GLB 의 이름은 모두 같은 기본값이라 항목 이름으로 바꾼다
      animations = [clip];
      const names = new Set();
      scene.traverse((o) => names.add(o.name));
      userData.unbound = [...new Set(clip.tracks.map((t) => t.name.split('.')[0]).filter((n) => !names.has(n)))];
      userData.base = base.label || base.name;
    }
  }
  return scene ? { scene, animations, userData } : null;
}

export async function mountModel({ gltf, stage }) {
  const collision = [];
  const markers = [];
  gltf.scene.traverse((o) => {
    if (o.userData.collision) collision.push(o);
    if (o.userData.bfaMarkers) markers.push(o);
  });
  if (collision.length) stage.addToggle(`충돌 ${collision.length}`, false, (v) => { for (const o of collision) o.visible = v; });
  if (markers.length) stage.addToggle('엄폐 · 리스폰', true, (v) => { for (const o of markers) o.visible = v; });
  const info = gltf.userData || {};
  if (info.base) stage.addNote(`기본 모델 ${info.base} · 맞물리지 않은 노드 ${info.unbound?.length ?? 0}`, (info.unbound || []).join('\n'));
  if (info.stats?.sub || info.stats?.subMissing) stage.addNote(`서브메시 선택 ${info.stats.sub}${info.stats.subMissing ? ` · 못 찾음 ${info.stats.subMissing}` : ''}`);
  return null;
}

export default { loadModel, mountModel };
