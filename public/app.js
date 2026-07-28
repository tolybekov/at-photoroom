import * as THREE from "./vendor/three.module.js";

const canvas = document.querySelector("#room-canvas");
const ownerButton = document.querySelector("#owner-button");
const ownerPanel = document.querySelector("#owner-panel");
const loginForm = document.querySelector("#login-form");
const uploadForm = document.querySelector("#upload-form");
const logoutButton = document.querySelector("#logout-button");
const deleteSelectedButton = document.querySelector("#delete-selected");
const ownerSecretInput = document.querySelector("#password");
const focusBar = document.querySelector("#focus-bar");
const focusTitle = document.querySelector("#focus-title");
const focusMeta = document.querySelector("#focus-meta");
const photoCount = document.querySelector("#photo-count");
const themeButton = document.querySelector("#theme-button");
const ownerSecretLabel = document.querySelector("#owner-secret-label");
const ownerModeNote = document.querySelector("#owner-mode-note");
const ownerEnterButton = document.querySelector("#owner-enter-button");
const ownerStatus = document.querySelector("#owner-status");

const GITHUB_REPOSITORY = "tolybekov/at-photoroom";
const GITHUB_BRANCH = "main";
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPOSITORY}`;
const MAX_GITHUB_UPLOAD_BYTES = 18 * 1024 * 1024;
const DISPLAY_IMAGE_SIZE = 1600;
const MOBILE_IMAGE_SIZE = 900;
const FOCUS_Z_LIFT = 0.45;

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: false,
  powerPreference: "high-performance"
});
renderer.setPixelRatio(getRendererPixelRatio());
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(getCssColor("--paper"));

const camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.1, 90);
camera.position.set(0, 0.15, 13);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const stage = new THREE.Group();
scene.add(stage);

const homeCamera = new THREE.Vector3(0, 0.15, 13);
const cameraTarget = new THREE.Vector3(0, 0, 0);
const desiredCamera = homeCamera.clone();
const desiredTarget = cameraTarget.clone();
const clock = new THREE.Clock();
const textureLoader = new THREE.TextureLoader();
const albumItems = [];
const pan = new THREE.Vector3(0, 0, 0);
const desiredPan = new THREE.Vector3(0, 0, 0);

let selectedItem = null;
let photos = [];
let isAuthenticated = false;
let staticMode = false;
let githubToken = "";
let pointerDown = null;
let orbit = { x: 0, y: 0 };
let desiredOrbit = { x: 0, y: 0 };
let hasDragged = false;

init();

async function init() {
  setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  bindEvents();
  await loadSession();
  await loadPhotos();
  animate();
}

async function loadPhotos() {
  try {
    const payload = staticMode
      ? await fetchJson("photos.json").catch(() => fetchJson("api/photos"))
      : await fetchJson("api/photos").catch(() => fetchJson("photos.json"));
    photos = Array.isArray(payload.photos) ? payload.photos : [];
    if (payload.fromApi) {
      staticMode = false;
    }
    if (payload.fromStatic) {
      staticMode = true;
    }
  } catch {
    photos = [];
  }

  syncOwnerForms();
  photoCount.textContent = `${String(photos.length).padStart(2, "0")} PHOTOS`;
  rebuildStage();
}

async function loadSession() {
  if (isGitHubPagesHost()) {
    staticMode = true;
    isAuthenticated = Boolean(githubToken);
    syncOwnerForms();
    return;
  }

  try {
    const payload = await fetchJson("api/session");
    isAuthenticated = Boolean(payload.authenticated);
    staticMode = false;
  } catch {
    isAuthenticated = false;
    staticMode = true;
  }

  syncOwnerForms();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json" }
  });
  const contentType = response.headers.get("content-type") || "";

  if (!response.ok || !contentType.includes("application/json")) {
    throw new Error(`Could not load ${url}`);
  }

  const payload = await response.json();
  if (url.startsWith("api/")) {
    payload.fromApi = true;
  }
  if (url.startsWith("photos.json")) {
    payload.fromStatic = true;
  }
  return payload;
}

function bindEvents() {
  window.addEventListener("resize", onResize);
  window.addEventListener("keydown", onKeyDown);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", resetPointer);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  ownerButton.addEventListener("click", () => {
    syncOwnerForms();
    ownerPanel.showModal();
  });

  themeButton.addEventListener("click", () => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });

  ownerPanel.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () => ownerPanel.close());
  });

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const secret = String(new FormData(loginForm).get("password") || "").trim();

    if (staticMode) {
      await connectGitHubOwner(secret);
      return;
    }

    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: secret })
    });

    if (!response.ok) {
      loginForm.animate(shakeFrames(), { duration: 240 });
      return;
    }

    isAuthenticated = true;
    loginForm.reset();
    syncOwnerForms();
  });

  uploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(uploadForm);

    if (staticMode) {
      await uploadPhotoToGitHub(formData);
      return;
    }

    const response = await fetch("/api/photos", {
      method: "POST",
      body: formData
    });

    if (!response.ok) {
      uploadForm.animate(shakeFrames(), { duration: 240 });
      return;
    }

    uploadForm.reset();
    ownerPanel.close();
    await loadPhotos();
    selectItem(albumItems[0]);
  });

  logoutButton.addEventListener("click", async () => {
    if (staticMode) {
      githubToken = "";
      isAuthenticated = false;
      setOwnerStatus("");
      syncOwnerForms();
      return;
    }

    await fetch("/api/logout", { method: "POST" });
    isAuthenticated = false;
    syncOwnerForms();
  });

  deleteSelectedButton.addEventListener("click", async () => {
    if (!selectedItem || selectedItem.isPlaceholder) return;

    if (staticMode) {
      await deletePhotoFromGitHub(selectedItem.photo);
      return;
    }

    const response = await fetch(`/api/photos/${selectedItem.photo.id}`, { method: "DELETE" });
    if (response.ok) {
      selectedItem = null;
      hideFocusBar();
      await loadPhotos();
    }
  });
}

function rebuildStage() {
  selectedItem = null;
  hideFocusBar();
  syncOwnerForms();
  clampPan();

  while (stage.children.length) {
    const child = stage.children.pop();
    disposeObject(child);
  }

  albumItems.length = 0;
  const sourcePhotos = photos.length ? photos : createPlaceholderPhotos();
  const hasRealPhotos = photos.length > 0;
  const specs = sourcePhotos.map((photo, index) => ({
    baseSize: getBaseSize(photo, index, sourcePhotos.length)
  }));
  const placements = createPhotoPlacements(sourcePhotos, specs, hasRealPhotos);

  sourcePhotos.forEach((photo, index) => {
    const seed = hashToUnit(`${photo.id}-${index}`);
    const group = new THREE.Group();
    let item;
    const imageSource = getTextureSource(photo);
    const material = new THREE.MeshBasicMaterial({
      map: imageSource ? loadTexture(resolveMediaPath(imageSource), () => fitItemToTexture(item)) : makePlaceholderTexture(photo, index),
      side: THREE.DoubleSide,
      transparent: true
    });
    const geometry = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.itemIndex = index;
    group.add(mesh);

    const border = makeBorder();
    border.userData.itemIndex = index;
    group.add(border);

    group.position.copy(screenPointToWorld(placements[index].x, placements[index].y, placements[index].z));
    group.rotation.set(
      lerp(-0.15, 0.15, hashToUnit(`${photo.id}-rx`)),
      lerp(-0.48, 0.48, hashToUnit(`${photo.id}-ry`)),
      lerp(-0.08, 0.08, hashToUnit(`${photo.id}-rz`))
    );

    const baseSize = specs[index].baseSize;
    item = {
      photo,
      group,
      mesh,
      border,
      basePosition: group.position.clone(),
      baseRotation: group.rotation.clone(),
      baseSize,
      aspect: 1,
      phase: seed * Math.PI * 2,
      isPlaceholder: photo.placeholder
    };
    albumItems.push(item);
    stage.add(group);

    if (!photo.src) {
      material.map.colorSpace = THREE.SRGBColorSpace;
      material.map.needsUpdate = true;
      fitItemToTexture(item);
    } else if (material.map.image?.complete) {
      material.map.colorSpace = THREE.SRGBColorSpace;
      material.map.needsUpdate = true;
      fitItemToTexture(item);
    }
  });
}

function createPhotoPlacements(sourcePhotos, specs, hasRealPhotos) {
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  if (!hasRealPhotos) {
    const placements = [];
    sourcePhotos.forEach((photo, index) => {
      const placement =
        index === 0
          ? { x: 0.5, y: window.innerWidth < 760 ? 0.48 : 0.52, z: 1.35, rx: 0.13, ry: 0.13 }
          : pickOpenPlacement(photo, index, specs[index].baseSize, placements);
      placements.push(placement);
    });
    return placements;
  }

  const placements = new Array(sourcePhotos.length);
  const placed = [];
  const layoutOrder = sourcePhotos
    .map((photo, index) => ({ index, weight: specs[index].baseSize + hashToUnit(`${photo.id}-layout-weight`) * 0.7 }))
    .sort((a, b) => b.weight - a.weight);

  layoutOrder.forEach(({ index }) => {
    const placement = pickOpenPlacement(sourcePhotos[index], index, specs[index].baseSize, placed);
    placements[index] = placement;
    placed.push(placement);
  });

  return placements;
}

function pickOpenPlacement(photo, index, baseSize, placed) {
  const mobile = window.innerWidth < 760;
  const marginX = mobile ? 0.12 : 0.055;
  const marginTop = mobile ? 0.2 : 0.08;
  const marginBottom = mobile ? 0.08 : 0.1;
  const attempts = mobile ? 120 : 180;
  let best = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const sample = sampleCandidate(photo, index, attempt, marginX, marginTop, marginBottom, mobile);
    const radius = estimateScreenRadius(baseSize, sample.z);
    const candidate = {
      ...sample,
      rx: radius / Math.max(camera.aspect, 0.75),
      ry: radius
    };
    keepCandidateInFrame(candidate, mobile);
    const score = scorePlacement(candidate, placed, mobile);

    if (!best || score > best.score) {
      best = { ...candidate, score };
    }
  }

  return best;
}

function sampleCandidate(photo, index, attempt, marginX, marginTop, marginBottom, mobile) {
  const seed = Math.floor(hashToUnit(`${photo.id}-${index}-layout`) * 10_000) + 1;
  const width = 1 - marginX * 2;
  const height = 1 - marginTop - marginBottom;
  const xJitter = (hashToUnit(`${photo.id}-${attempt}-jx`) - 0.5) * 0.035;
  const yJitter = (hashToUnit(`${photo.id}-${attempt}-jy`) - 0.5) * 0.035;
  const depthMin = mobile ? -9.2 : -10.2;
  const depthMax = mobile ? 1.25 : 1.85;

  return {
    x: THREE.MathUtils.clamp(marginX + halton(seed + attempt * 31, 2) * width + xJitter, marginX, 1 - marginX),
    y: THREE.MathUtils.clamp(marginTop + halton(seed + attempt * 47, 3) * height + yJitter, marginTop, 1 - marginBottom),
    z: lerp(depthMin, depthMax, halton(seed + attempt * 19, 5))
  };
}

function keepCandidateInFrame(candidate, mobile) {
  const edgePad = mobile ? 0.035 : 0.028;
  const topPad = mobile ? 0.055 : 0.07;
  const bottomPad = mobile ? 0.035 : 0.04;
  const minX = candidate.rx + edgePad;
  const maxX = 1 - candidate.rx - edgePad;
  const minY = candidate.ry + topPad;
  const maxY = 1 - candidate.ry - bottomPad;

  candidate.x = clampBetween(candidate.x, minX, maxX);
  candidate.y = clampBetween(candidate.y, minY, maxY);
}

function scorePlacement(candidate, placed, mobile) {
  const protectedPenalty = getProtectedRects(mobile).reduce(
    (sum, rect) => sum + overlapPenalty(candidate, rect),
    0
  );
  const zonePenalty = placed.filter((other) => getZone(other, mobile) === getZone(candidate, mobile)).length * 38;
  const edgePenalty = edgeCrowding(candidate) * 20;
  const depthPreference = candidate.z > -2.5 && candidate.y < 0.34 ? 30 : 0;
  let spacingScore = 0;

  placed.forEach((other) => {
    const dx = (candidate.x - other.x) * camera.aspect;
    const dy = candidate.y - other.y;
    const distance = Math.hypot(dx, dy);
    const preferredDistance = candidate.ry + other.ry + (mobile ? 0.18 : 0.13);
    const depthSeparation = Math.abs(candidate.z - other.z);

    spacingScore += Math.min(distance, 0.65) * 7;

    if (distance < preferredDistance) {
      spacingScore -= (preferredDistance - distance) * 360;
    }

    if (distance < preferredDistance * 1.4 && depthSeparation < 3.2) {
      spacingScore -= (3.2 - depthSeparation) * 12;
    }
  });

  const lightRandomTieBreak = hashToUnit(`${candidate.x}-${candidate.y}-${candidate.z}`) * 0.08;
  return spacingScore - protectedPenalty - zonePenalty - edgePenalty - depthPreference + lightRandomTieBreak;
}

function getProtectedRects(mobile) {
  if (mobile) {
    return [
      { left: 0, top: 0, right: 0.96, bottom: 0.17, weight: 240 },
      { left: 0.72, top: 0.9, right: 1, bottom: 1, weight: 110 }
    ];
  }

  return [
    { left: 0, top: 0, right: 0.58, bottom: 0.32, weight: 260 },
    { left: 0.82, top: 0.02, right: 1, bottom: 0.16, weight: 135 },
    { left: 0.88, top: 0.9, right: 1, bottom: 1, weight: 100 }
  ];
}

function overlapPenalty(candidate, rect) {
  const candidateRect = {
    left: candidate.x - candidate.rx,
    top: candidate.y - candidate.ry,
    right: candidate.x + candidate.rx,
    bottom: candidate.y + candidate.ry
  };
  const overlapWidth = Math.max(0, Math.min(candidateRect.right, rect.right) - Math.max(candidateRect.left, rect.left));
  const overlapHeight = Math.max(0, Math.min(candidateRect.bottom, rect.bottom) - Math.max(candidateRect.top, rect.top));
  const overlapArea = overlapWidth * overlapHeight;

  if (!overlapArea) return 0;

  const foregroundMultiplier = candidate.z > -4 ? 2.4 : 1;
  return rect.weight * foregroundMultiplier + overlapArea * rect.weight * 900;
}

function edgeCrowding(candidate) {
  const left = Math.max(0, 0.03 - (candidate.x - candidate.rx));
  const right = Math.max(0, candidate.x + candidate.rx - 0.97);
  const top = Math.max(0, 0.04 - (candidate.y - candidate.ry));
  const bottom = Math.max(0, candidate.y + candidate.ry - 0.96);
  return left + right + top + bottom;
}

function getZone(candidate, mobile) {
  const columns = mobile ? 3 : 5;
  const rows = mobile ? 5 : 4;
  const column = THREE.MathUtils.clamp(Math.floor(candidate.x * columns), 0, columns - 1);
  const row = THREE.MathUtils.clamp(Math.floor(candidate.y * rows), 0, rows - 1);
  return `${column}-${row}`;
}

function estimateScreenRadius(baseSize, z) {
  const distance = Math.max(0.1, camera.position.z - z);
  const visibleHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * distance;
  const projectedHeight = (baseSize * 1.24) / visibleHeight;
  return THREE.MathUtils.clamp(projectedHeight * 0.5, 0.035, window.innerWidth < 760 ? 0.22 : 0.18);
}

function screenPointToWorld(screenX, screenY, z) {
  const point = new THREE.Vector3(screenX * 2 - 1, 1 - screenY * 2, 0.5).unproject(camera);
  const direction = point.sub(camera.position).normalize();
  const distance = (z - camera.position.z) / direction.z;
  return camera.position.clone().add(direction.multiplyScalar(distance));
}

function getBaseSize(photo, index, count) {
  const density = THREE.MathUtils.clamp(1 - Math.max(0, count - 10) * 0.018, 0.76, 1);
  const largePhotoBrake = count > 16 ? 0.92 : 1;
  return lerp(0.92, 2.18, hashToUnit(`${photo.id}-${index}-s`)) * density * largePhotoBrake;
}

function loadTexture(src, onLoad) {
  const texture = textureLoader.load(src, () => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    onLoad?.();
  });
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function fitItemToTexture(item) {
  const image = item.mesh.material.map.image;
  const width = image?.naturalWidth || image?.videoWidth || image?.width || 1;
  const height = image?.naturalHeight || image?.videoHeight || image?.height || 1;
  const aspect = width / height;
  item.aspect = aspect;

  const maxWide = item.baseSize;
  const maxTall = item.baseSize * 1.24;
  const planeWidth = aspect >= 1 ? maxWide : maxTall * aspect;
  const planeHeight = aspect >= 1 ? maxWide / aspect : maxTall;
  item.mesh.scale.set(planeWidth, planeHeight, 1);
  item.border.scale.set(planeWidth, planeHeight, 1);

  if (item === selectedItem) {
    focusCameraOnItem(item);
  }
}

function makeBorder() {
  const points = [
    new THREE.Vector3(-0.5, -0.5, 0.003),
    new THREE.Vector3(0.5, -0.5, 0.003),
    new THREE.Vector3(0.5, 0.5, 0.003),
    new THREE.Vector3(-0.5, 0.5, 0.003),
    new THREE.Vector3(-0.5, -0.5, 0.003)
  ];
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({ color: 0x090909, transparent: true, opacity: 0.28 });
  return new THREE.Line(geometry, material);
}

function makePlaceholderTexture(photo, index) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 1280;
  const ctx = canvas.getContext("2d");
  const tones = ["#101010", "#f3f3ef", "#d8362f"];
  const inverted = index % 2 === 0;

  ctx.fillStyle = inverted ? tones[0] : tones[1];
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = inverted ? tones[1] : tones[0];
  ctx.lineWidth = 20;
  ctx.strokeRect(58, 58, canvas.width - 116, canvas.height - 116);

  ctx.fillStyle = tones[2];
  ctx.fillRect(88 + index * 14, 120, 82, 28);
  ctx.fillStyle = inverted ? tones[1] : tones[0];
  ctx.font = "900 96px Helvetica, Arial, sans-serif";
  ctx.fillText("AT", 88, 270);
  ctx.font = "900 54px Helvetica, Arial, sans-serif";
  ctx.fillText(String(index + 1).padStart(2, "0"), 88, 360);
  ctx.font = "900 38px Helvetica, Arial, sans-serif";
  ctx.fillText(photo.title, 88, 1090);
  ctx.fillText("PRIVATE FRAME", 88, 1144);

  for (let i = 0; i < 900; i += 1) {
    const shade = Math.random() > 0.5 ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)";
    ctx.fillStyle = shade;
    ctx.fillRect(Math.random() * canvas.width, Math.random() * canvas.height, 1, 1);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createPlaceholderPhotos() {
  return Array.from({ length: 9 }, (_, index) => ({
    id: `placeholder-${index}`,
    title: `AT FRAME ${String(index + 1).padStart(2, "0")}`,
    place: "PRIVATE ARCHIVE",
    date: "READY",
    note: "EMPTY FRAME",
    placeholder: true
  }));
}

function animate() {
  requestAnimationFrame(animate);
  const elapsed = clock.getElapsedTime();

  orbit.x = lerp(orbit.x, desiredOrbit.x, 0.06);
  orbit.y = lerp(orbit.y, desiredOrbit.y, 0.06);
  pan.lerp(desiredPan, 0.08);
  stage.position.copy(pan);
  stage.rotation.y = orbit.x;
  stage.rotation.x = orbit.y;

  albumItems.forEach((item, index) => {
    const isSelected = item === selectedItem;
    const floatY = Math.sin(elapsed * 0.45 + item.phase) * 0.12;
    const floatX = Math.cos(elapsed * 0.31 + item.phase) * 0.06;
    const targetPosition = isSelected
      ? item.basePosition.clone().add(new THREE.Vector3(0, 0, FOCUS_Z_LIFT))
      : item.basePosition.clone().add(new THREE.Vector3(floatX, floatY, 0));

    item.group.position.lerp(targetPosition, isSelected ? 0.1 : 0.035);
    item.group.rotation.x = lerp(item.group.rotation.x, isSelected ? 0 : item.baseRotation.x, 0.06);
    item.group.rotation.y = lerp(item.group.rotation.y, isSelected ? 0 : item.baseRotation.y, 0.06);
    item.group.rotation.z = lerp(item.group.rotation.z, isSelected ? 0 : item.baseRotation.z, 0.06);
    item.mesh.material.opacity = lerp(item.mesh.material.opacity ?? 1, selectedItem && !isSelected ? 0.34 : 1, 0.08);
    item.border.material.opacity = lerp(item.border.material.opacity, isSelected ? 0.84 : 0.28, 0.08);
    item.group.renderOrder = isSelected ? 10 : index;
  });

  camera.position.lerp(desiredCamera, 0.06);
  cameraTarget.lerp(desiredTarget, 0.08);
  camera.lookAt(cameraTarget);
  renderer.render(scene, camera);
  updateFocusBar();
}

function selectItem(item) {
  if (!item) return;
  selectedItem = item;
  focusCameraOnItem(item);
  desiredOrbit = { x: 0, y: 0 };

  const title = item.photo.title || "UNTITLED";
  const meta = [item.photo.place, item.photo.date, item.photo.note].filter(Boolean).join(" / ") || "AT PHOTOROOM";
  focusTitle.textContent = title;
  focusTitle.title = title;
  focusMeta.textContent = meta;
  focusMeta.title = meta;
  focusBar.classList.add("is-visible");
  syncOwnerForms();
}

function focusCameraOnItem(item) {
  const focusPosition = getFocusedWorldPosition(item);
  const distance = getFocusCameraDistance(item);
  const visibleHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * distance;
  const viewLift = visibleHeight * (isCompactViewport() ? 0.035 : 0.085);

  desiredTarget.set(focusPosition.x, focusPosition.y + viewLift, focusPosition.z);
  desiredCamera.set(focusPosition.x, focusPosition.y + viewLift, focusPosition.z + distance);
}

function getFocusedWorldPosition(item) {
  return item.basePosition
    .clone()
    .add(new THREE.Vector3(0, 0, FOCUS_Z_LIFT))
    .add(desiredPan);
}

function getFocusCameraDistance(item) {
  const coverage = isCompactViewport()
    ? { width: 0.78, height: 0.52, minDistance: 3.15 }
    : { width: 0.42, height: 0.52, minDistance: 3.25 };
  const planeWidth = Math.max(item.mesh.scale.x, 0.2);
  const planeHeight = Math.max(item.mesh.scale.y, 0.2);
  const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const distanceForHeight = planeHeight / (2 * tanHalfFov * coverage.height);
  const distanceForWidth = planeWidth / (2 * tanHalfFov * camera.aspect * coverage.width);

  return THREE.MathUtils.clamp(
    Math.max(distanceForHeight, distanceForWidth, coverage.minDistance),
    coverage.minDistance,
    16
  );
}

function clearFocus() {
  selectedItem = null;
  desiredCamera.copy(homeCamera);
  desiredTarget.set(0, 0, 0);
  hideFocusBar();
  syncOwnerForms();
}

function hideFocusBar() {
  focusBar.classList.remove("is-visible");
}

function updateFocusBar() {
  if (!selectedItem) return;

  const item = selectedItem;
  const corners = [
    new THREE.Vector3(-0.5, -0.5, 0),
    new THREE.Vector3(0.5, -0.5, 0),
    new THREE.Vector3(-0.5, 0.5, 0),
    new THREE.Vector3(0.5, 0.5, 0)
  ].map((corner) => {
    const projected = item.mesh.localToWorld(corner).project(camera);
    return {
      x: (projected.x * 0.5 + 0.5) * window.innerWidth,
      y: (-projected.y * 0.5 + 0.5) * window.innerHeight
    };
  });

  const minX = Math.min(...corners.map((corner) => corner.x));
  const maxX = Math.max(...corners.map((corner) => corner.x));
  const minY = Math.min(...corners.map((corner) => corner.y));
  const maxY = Math.max(...corners.map((corner) => corner.y));
  const photoWidth = maxX - minX;
  const mobile = window.innerWidth < 720;
  const minReadableWidth = mobile ? 220 : 280;
  const width = Math.min(Math.max(photoWidth, minReadableWidth), window.innerWidth - 32);
  const photoCenter = minX + photoWidth / 2;
  const left = Math.min(Math.max(photoCenter - width / 2, 16), window.innerWidth - width - 16);

  focusBar.style.left = `${left}px`;
  focusBar.style.width = `${width}px`;

  const barHeight = focusBar.offsetHeight;
  const belowTop = maxY + 4;
  const aboveTop = minY - barHeight - 4;
  const top = belowTop + barHeight <= window.innerHeight - 18
    ? Math.max(belowTop, 72)
    : Math.max(Math.min(aboveTop, window.innerHeight - barHeight - 18), 72);

  focusBar.style.top = `${top}px`;
}

function onPointerDown(event) {
  pointerDown = {
    x: event.clientX,
    y: event.clientY,
    mode: event.shiftKey || event.altKey ? "orbit" : "pan"
  };
  hasDragged = false;
  canvas.setPointerCapture(event.pointerId);
}

function onPointerMove(event) {
  if (!pointerDown) return;
  const dx = event.clientX - pointerDown.x;
  const dy = event.clientY - pointerDown.y;
  if (Math.abs(dx) + Math.abs(dy) > 6) {
    hasDragged = true;
  }
  if (!selectedItem && pointerDown.mode === "orbit") {
    desiredOrbit.x += dx * 0.0009;
    desiredOrbit.y += dy * 0.0007;
    desiredOrbit.y = THREE.MathUtils.clamp(desiredOrbit.y, -0.24, 0.24);
  } else if (!selectedItem) {
    const sensitivity = getPanSensitivity();
    desiredPan.x += dx * sensitivity;
    desiredPan.y -= dy * sensitivity;
    clampPan();
  }
  pointerDown = { ...pointerDown, x: event.clientX, y: event.clientY };
}

function onPointerUp(event) {
  canvas.releasePointerCapture(event.pointerId);
  if (!hasDragged) {
    pick(event.clientX, event.clientY);
  }
  resetPointer();
}

function resetPointer() {
  pointerDown = null;
  hasDragged = false;
}

function pick(clientX, clientY) {
  pointer.x = (clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const intersects = raycaster.intersectObjects(albumItems.map((item) => item.mesh), false);
  if (!intersects.length) {
    clearFocus();
    return;
  }

  const index = intersects[0].object.userData.itemIndex;
  selectItem(albumItems[index]);
}

function onWheel(event) {
  event.preventDefault();
  if (selectedItem) return;
  homeCamera.z = THREE.MathUtils.clamp(homeCamera.z + event.deltaY * 0.006, 8.5, 17);
  desiredCamera.copy(homeCamera);
  clampPan();
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(getRendererPixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight);
  clampPan();
  rebuildStage();
}

function onKeyDown(event) {
  if (selectedItem || isTypingTarget(event.target) || ownerPanel.open) return;

  const step = getPanSensitivity() * 48;
  const moves = {
    ArrowLeft: [step, 0],
    KeyA: [step, 0],
    ArrowRight: [-step, 0],
    KeyD: [-step, 0],
    ArrowUp: [0, -step],
    KeyW: [0, -step],
    ArrowDown: [0, step],
    KeyS: [0, step]
  };
  const move = moves[event.code];
  if (!move) return;

  event.preventDefault();
  desiredPan.x += move[0];
  desiredPan.y += move[1];
  clampPan();
}

function syncOwnerForms() {
  if (staticMode) {
    ownerSecretLabel.textContent = "GITHUB TOKEN";
    ownerModeNote.textContent = "LIVE OWNER PUBLISH";
    ownerEnterButton.textContent = "CONNECT";
    ownerSecretInput.setAttribute("autocomplete", "off");
    ownerSecretInput.setAttribute("data-raw-input", "");
  } else {
    ownerSecretLabel.textContent = "PASSWORD";
    ownerModeNote.textContent = "LOCAL OWNER PASSWORD";
    ownerEnterButton.textContent = "ENTER";
    ownerSecretInput.setAttribute("autocomplete", "current-password");
    ownerSecretInput.removeAttribute("data-raw-input");
  }

  loginForm.classList.toggle("is-hidden", isAuthenticated);
  uploadForm.classList.toggle("is-hidden", !isAuthenticated);
  deleteSelectedButton.disabled = !selectedItem || selectedItem.isPlaceholder;
  ownerButton.hidden = false;
}

async function connectGitHubOwner(token) {
  if (!token) {
    loginForm.animate(shakeFrames(), { duration: 240 });
    return;
  }

  setOwnerStatus("CHECKING TOKEN");
  ownerEnterButton.disabled = true;

  try {
    await githubRequest(`/contents/public/photos.json?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { token });
    githubToken = token;
    isAuthenticated = true;
    loginForm.reset();
    setOwnerStatus("OWNER READY");
    syncOwnerForms();
  } catch {
    githubToken = "";
    isAuthenticated = false;
    setOwnerStatus("TOKEN FAILED");
    loginForm.animate(shakeFrames(), { duration: 240 });
  } finally {
    ownerEnterButton.disabled = false;
  }
}

async function uploadPhotoToGitHub(formData) {
  const file = formData.get("photo");
  const uploadButton = uploadForm.querySelector("button[type='submit']");

  if (!(file instanceof File) || file.size === 0) {
    setOwnerStatus("CHOOSE AN IMAGE");
    uploadForm.animate(shakeFrames(), { duration: 240 });
    return;
  }

  if (file.size > MAX_GITHUB_UPLOAD_BYTES) {
    setOwnerStatus("IMAGE IS TOO LARGE");
    uploadForm.animate(shakeFrames(), { duration: 240 });
    return;
  }

  const extension = extensionFromFile(file);
  if (!extension) {
    setOwnerStatus("IMAGE TYPE NOT SUPPORTED");
    uploadForm.animate(shakeFrames(), { duration: 240 });
    return;
  }

  uploadButton.disabled = true;
  deleteSelectedButton.disabled = true;
  setOwnerStatus("PREPARING PHOTO");

  try {
    const id = makeId();
    const filename = `${Date.now()}-${id.slice(0, 8)}${extension}`;
    const title = cleanText(formData.get("title")) || nameWithoutExtension(file.name) || "Untitled";
    const photo = {
      id,
      title,
      place: cleanText(formData.get("place")),
      date: cleanText(formData.get("date")),
      note: cleanText(formData.get("note")),
      src: `/photos/${filename}`,
      uploadedAt: new Date().toISOString()
    };
    const currentPhotos = await fetchGitHubPhotos();
    setOwnerStatus("OPTIMIZING");
    const displayImage = await makeDisplayImage(file, DISPLAY_IMAGE_SIZE, 0.78);
    const mobileImage = await makeDisplayImage(file, MOBILE_IMAGE_SIZE, 0.72);
    const displayFilename = `${filename.replace(/\.[^.]+$/, "")}.jpg`;

    photo.displaySrc = `/display/${displayFilename}`;
    photo.mobileSrc = `/mobile/${displayFilename}`;
    const nextPhotos = [photo, ...currentPhotos];
    const publicManifest = makePublicManifest(nextPhotos);

    const imageBase64 = await fileToBase64(file);
    const displayBase64 = await blobToBase64(displayImage);
    const mobileBase64 = await blobToBase64(mobileImage);

    setOwnerStatus("PUBLISHING");
    await commitGitHubChanges(`Add ${title}`, [
      { path: `public/photos/${filename}`, content: imageBase64, encoding: "base64" },
      { path: `public/display/${displayFilename}`, content: displayBase64, encoding: "base64" },
      { path: `public/mobile/${displayFilename}`, content: mobileBase64, encoding: "base64" },
      { path: "data/photos.json", content: `${JSON.stringify(nextPhotos, null, 2)}\n`, encoding: "utf-8" },
      { path: "public/photos.json", content: `${JSON.stringify(publicManifest, null, 2)}\n`, encoding: "utf-8" }
    ]);

    photos = [{ ...photo, previewSrc: URL.createObjectURL(mobileImage) }, ...publicManifest.photos.slice(1)];
    photoCount.textContent = `${String(photos.length).padStart(2, "0")} PHOTOS`;
    uploadForm.reset();
    ownerPanel.close();
    rebuildStage();
    selectItem(albumItems[0]);
    setOwnerStatus("PUBLISHED");
  } catch (error) {
    console.error(error);
    setOwnerStatus(error.message?.includes("409") ? "PULL LATEST AND TRY AGAIN" : "PUBLISH FAILED");
    uploadForm.animate(shakeFrames(), { duration: 240 });
  } finally {
    uploadButton.disabled = false;
    syncOwnerForms();
  }
}

async function deletePhotoFromGitHub(photo) {
  if (!photo?.id) return;

  const sourcePath = photo.repositorySrc || photo.src || "";
  if (!sourcePath || sourcePath.startsWith("blob:")) {
    setOwnerStatus("RELOAD BEFORE DELETE");
    return;
  }

  deleteSelectedButton.disabled = true;
  setOwnerStatus("REMOVING");

  try {
    const currentPhotos = await fetchGitHubPhotos();
    const target = currentPhotos.find((item) => item.id === photo.id);
    const nextPhotos = currentPhotos.filter((item) => item.id !== photo.id);
    const publicManifest = makePublicManifest(nextPhotos);
    const targetPath = target ? `public/${stripLeadingSlash(target.src)}` : `public/${stripLeadingSlash(sourcePath)}`;
    const removals = [{ path: targetPath, remove: true }];

    if (target?.displaySrc) {
      removals.push({ path: `public/${stripLeadingSlash(target.displaySrc)}`, remove: true });
    }

    if (target?.mobileSrc) {
      removals.push({ path: `public/${stripLeadingSlash(target.mobileSrc)}`, remove: true });
    }

    await commitGitHubChanges(`Remove ${photo.title || "photo"}`, [
      ...removals,
      { path: "data/photos.json", content: `${JSON.stringify(nextPhotos, null, 2)}\n`, encoding: "utf-8" },
      { path: "public/photos.json", content: `${JSON.stringify(publicManifest, null, 2)}\n`, encoding: "utf-8" }
    ]);

    selectedItem = null;
    photos = publicManifest.photos;
    photoCount.textContent = `${String(photos.length).padStart(2, "0")} PHOTOS`;
    hideFocusBar();
    rebuildStage();
    setOwnerStatus("REMOVED");
  } catch (error) {
    console.error(error);
    setOwnerStatus("REMOVE FAILED");
    uploadForm.animate(shakeFrames(), { duration: 240 });
  } finally {
    syncOwnerForms();
  }
}

async function fetchGitHubPhotos() {
  const file = await githubRequest(`/contents/data/photos.json?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
  const parsed = JSON.parse(decodeBase64Text(file.content || ""));
  return Array.isArray(parsed) ? parsed : [];
}

async function commitGitHubChanges(message, entries) {
  const ref = await githubRequest(`/git/ref/heads/${encodeURIComponent(GITHUB_BRANCH)}`);
  const parentSha = ref.object.sha;
  const parentCommit = await githubRequest(`/git/commits/${parentSha}`);
  const tree = [];

  for (const entry of entries) {
    if (entry.remove) {
      tree.push({ path: entry.path, mode: "100644", type: "blob", sha: null });
      continue;
    }

    const blob = await githubRequest("/git/blobs", {
      method: "POST",
      body: {
        content: entry.content,
        encoding: entry.encoding || "utf-8"
      }
    });
    tree.push({ path: entry.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const newTree = await githubRequest("/git/trees", {
    method: "POST",
    body: {
      base_tree: parentCommit.tree.sha,
      tree
    }
  });
  const commit = await githubRequest("/git/commits", {
    method: "POST",
    body: {
      message,
      tree: newTree.sha,
      parents: [parentSha]
    }
  });

  await githubRequest(`/git/refs/heads/${encodeURIComponent(GITHUB_BRANCH)}`, {
    method: "PATCH",
    body: {
      sha: commit.sha,
      force: false
    }
  });

  return commit;
}

async function githubRequest(path, { method = "GET", body, token = githubToken } = {}) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(`${response.status} ${detail.message || response.statusText}`);
  }

  return response.status === 204 ? null : response.json();
}

function makePublicManifest(sourcePhotos) {
  return {
    photos: sourcePhotos.map((photo) => ({
      ...photo,
      src: typeof photo.src === "string" ? stripLeadingSlash(photo.src) : photo.src
    })),
    generatedAt: new Date().toISOString()
  };
}

function fileToBase64(file) {
  return blobToBase64(file);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(String(reader.result || "").split(",")[1] || "");
    });
    reader.addEventListener("error", () => reject(reader.error || new Error("Could not read file.")));
    reader.readAsDataURL(blob);
  });
}

async function makeDisplayImage(file, maxSize, quality) {
  const imageUrl = URL.createObjectURL(file);
  try {
    const image = await loadImageElement(imageUrl);
    const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });

    if (!context) {
      throw new Error("Canvas is unavailable.");
    }

    context.fillStyle = "#f4f4f2";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    return await canvasToBlob(canvas, "image/jpeg", quality);
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => reject(new Error("Could not optimize image.")), { once: true });
    image.src = src;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Could not export optimized image."));
      }
    }, type, quality);
  });
}

function decodeBase64Text(content) {
  const binary = atob(content.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function extensionFromFile(file) {
  const typeMap = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif"
  };
  return typeMap[file.type] || extensionFromName(file.name);
}

function extensionFromName(name) {
  const match = String(name || "").toLowerCase().match(/\.(jpe?g|png|webp|gif|avif)$/);
  return match ? `.${match[1].replace("jpeg", "jpg")}` : "";
}

function nameWithoutExtension(name) {
  return String(name || "").replace(/\.[^.]+$/, "");
}

function cleanText(value) {
  return String(value || "").trim().slice(0, 120);
}

function makeId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function setOwnerStatus(message) {
  ownerStatus.textContent = message;
}

function stripLeadingSlash(value) {
  return String(value || "").replace(/^\/+/, "");
}

function shakeFrames() {
  return [
    { transform: "translateX(0)" },
    { transform: "translateX(-8px)" },
    { transform: "translateX(8px)" },
    { transform: "translateX(0)" }
  ];
}

function disposeObject(object) {
  object.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (child.material.map) child.material.map.dispose();
      child.material.dispose();
    }
  });
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function getPanSensitivity() {
  const distance = Math.max(0.1, camera.position.z - cameraTarget.z);
  const visibleHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * distance;
  return visibleHeight / Math.max(window.innerHeight, 1);
}

function clampPan() {
  const mobile = window.innerWidth < 760;
  const zoom = THREE.MathUtils.clamp((homeCamera.z - 8.5) / 8.5, 0, 1);
  const limitX = (mobile ? 0.95 : 1.65) + zoom * (mobile ? 0.45 : 0.8);
  const limitY = (mobile ? 1.45 : 1.05) + zoom * (mobile ? 0.55 : 0.55);

  desiredPan.x = THREE.MathUtils.clamp(desiredPan.x, -limitX, limitX);
  desiredPan.y = THREE.MathUtils.clamp(desiredPan.y, -limitY, limitY);
  pan.x = THREE.MathUtils.clamp(pan.x, -limitX, limitX);
  pan.y = THREE.MathUtils.clamp(pan.y, -limitY, limitY);
}

function clampBetween(value, min, max) {
  if (min > max) {
    return (min + max) / 2;
  }

  return THREE.MathUtils.clamp(value, min, max);
}

function isTypingTarget(target) {
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName);
}

function isGitHubPagesHost() {
  return window.location.hostname.endsWith("github.io");
}

function isCompactViewport() {
  return window.innerWidth < 760 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function getRendererPixelRatio() {
  return isCompactViewport() ? 1 : Math.min(window.devicePixelRatio || 1, 1.5);
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("at-theme", theme);
  themeButton.textContent = theme === "dark" ? "LIGHT" : "DARK";
  themeButton.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
  scene.background.set(getCssColor("--paper"));
}

function getCssColor(variableName) {
  return getComputedStyle(document.documentElement).getPropertyValue(variableName).trim() || "#f4f4f2";
}

function getTextureSource(photo) {
  if (photo.previewSrc) return photo.previewSrc;
  if (isCompactViewport() && photo.mobileSrc) return photo.mobileSrc;
  return photo.displaySrc || photo.mobileSrc || photo.src;
}

function resolveMediaPath(src) {
  if (!src) return "";
  if (/^(https?:)?\/\//.test(src) || src.startsWith("data:") || src.startsWith("blob:")) return src;
  return src.replace(/^\/+/, "");
}

function hashToUnit(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function halton(index, base) {
  let result = 0;
  let fraction = 1 / base;
  let current = index;

  while (current > 0) {
    result += fraction * (current % base);
    current = Math.floor(current / base);
    fraction /= base;
  }

  return result;
}
