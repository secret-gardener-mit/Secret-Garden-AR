import * as THREE from "three";

// Secret Garden XR v0.1a2-1
// 調整參數集中在這裡，後續可以直接修改數量、高度、半徑與動畫時間。
const FLOWER_COUNT = 5;
const PETAL_COUNT = 100;
const FLOWER_RADIUS = 1.5;
const PETAL_HEIGHT = 2.5;
const FLOWER_GROW_DURATION = 1000;
const FALLBACK_GARDEN_Y = -0.85;
const FALLBACK_LOOK_AT_Z = -2.1;

const FLOWER_COLORS = ["#f8bfd4", "#ffd7a8", "#fff1a8", "#bde5bd", "#c9d7ff", "#d7c2ff"];
const PETAL_COLORS = ["#ffd7e6", "#fff1c7", "#f7bfd4", "#dceecb", "#f5efe8"];

const stage = document.querySelector("#xr-stage");
const cameraFeed = document.querySelector("#camera-feed");
const startButton = document.querySelector("#start-ar");
const statusText = document.querySelector("#status");
const hintText = document.querySelector("#hint");
const debugPlane = document.querySelector("#debug-plane");
const debugFlowers = document.querySelector("#debug-flowers");
const debugPetals = document.querySelector("#debug-petals");

let renderer;
let scene;
let camera;
let xrSession = null;
let xrRefSpace = null;
let xrViewerSpace = null;
let hitTestSource = null;
let reticle;
let gardenRoot;
let planeFound = false;
let fallbackMode = false;
let fallbackStream = null;
let fallbackGardenPlaced = false;
let flowers = [];
let petals = [];
const tapPosition = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
const fallbackGroundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -FALLBACK_GARDEN_Y);
const fallbackHitPoint = new THREE.Vector3();
const xrHitMatrix = new THREE.Matrix4();
const xrHitWorldPosition = new THREE.Vector3();

init();

function init() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 40);

  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x53624d, 1.8));
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  reticle = createReticle();
  scene.add(reticle);

  startButton.addEventListener("click", startExperience);
  window.addEventListener("resize", resize);
  stage.addEventListener("pointerdown", handleTap);

  updateDebug();
  setHint("Start AR");
}

async function startExperience() {
  startButton.disabled = true;
  document.body.classList.add("is-running");

  const supported = await supportsWebXRAR();
  if (supported) {
    await startWebXR();
  } else {
    await startIPhoneFallback();
  }
}

async function supportsWebXRAR() {
  if (!navigator.xr?.isSessionSupported) return false;
  try {
    return await navigator.xr.isSessionSupported("immersive-ar");
  } catch (error) {
    console.warn("WebXR support check failed", error);
    return false;
  }
}

async function startWebXR() {
  setStatus("正在啟動 WebXR AR...");
  try {
    xrSession = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["dom-overlay", "local-floor"],
      domOverlay: { root: document.body },
    });

    renderer.xr.setReferenceSpaceType("local");
    await renderer.xr.setSession(xrSession);
    xrRefSpace = await xrSession.requestReferenceSpace("local");
    xrViewerSpace = await xrSession.requestReferenceSpace("viewer");
    hitTestSource = await xrSession.requestHitTestSource({ space: xrViewerSpace });

    xrSession.addEventListener("end", resetExperience);
    xrSession.addEventListener("select", placeFromXRSelect);
    renderer.setAnimationLoop(renderWebXR);
    setStatus("WebXR 已啟動。請掃描地板。");
    setHint("Move phone to scan floor");
  } catch (error) {
    console.warn("WebXR start failed, falling back to camera mode", error);
    await startIPhoneFallback();
  }
}

async function startIPhoneFallback() {
  fallbackMode = true;
  setStatus("此瀏覽器不支援 WebXR AR，已改用 iPhone 相機 fallback。");
  setHint("Tap to place garden");
  planeFound = true;
  updateDebug();

  try {
    fallbackStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    cameraFeed.srcObject = fallbackStream;
    cameraFeed.style.display = "block";
  } catch (error) {
    setStatus("無法開啟相機；仍可在預覽畫面測試花園互動。");
    document.body.style.background = "radial-gradient(circle at 50% 20%, #213322, #07100a)";
  }

  camera.position.set(0, 1.25, 3);
  camera.lookAt(0, FALLBACK_GARDEN_Y, FALLBACK_LOOK_AT_Z);
  camera.updateMatrixWorld(true);
  renderer.setAnimationLoop(renderFallback);
}

function renderWebXR(timestamp, frame) {
  if (frame && hitTestSource) {
    const hitTestResults = frame.getHitTestResults(hitTestSource);
    if (hitTestResults.length > 0) {
      const hit = hitTestResults[0];
      const pose = hit.getPose(xrRefSpace);
      if (pose) {
        planeFound = true;
        reticle.visible = true;
        reticle.matrix.fromArray(pose.transform.matrix);
        setHint(gardenRoot ? "Tap floor to plant flower" : "Tap to place garden");
      }
    } else {
      reticle.visible = false;
      planeFound = false;
    }
    updateDebug();
  }

  updateScene(timestamp || performance.now());
  renderer.render(scene, camera);
}

function renderFallback(timestamp) {
  updateScene(timestamp || performance.now());
  renderer.render(scene, camera);
}

function placeFromXRSelect() {
  if (!planeFound || !reticle.visible) return;

  if (!gardenRoot) {
    placeGarden(reticle.matrix);
    return;
  }

  xrHitMatrix.copy(reticle.matrix);
  xrHitWorldPosition.setFromMatrixPosition(xrHitMatrix);
  addFlowerAtWorldPosition(xrHitWorldPosition);
}

function handleTap(event) {
  if (!fallbackMode) return;

  const worldPosition = getFallbackGroundHit(event.clientX, event.clientY);
  if (!worldPosition) {
    setStatus("沒有打到預設地板平面，請稍微往下點擊畫面。");
    return;
  }

  if (!fallbackGardenPlaced) {
    const matrix = new THREE.Matrix4().makeTranslation(worldPosition.x, FALLBACK_GARDEN_Y, worldPosition.z);
    placeGarden(matrix);
    fallbackGardenPlaced = true;
    setStatus("花園已固定在同一個世界座標平面。");
    return;
  }

  addFlowerAtWorldPosition(worldPosition);
}

function placeGarden(matrix) {
  if (!gardenRoot) {
    gardenRoot = new THREE.Group();
    gardenRoot.matrixAutoUpdate = true;
    scene.add(gardenRoot);
  }

  gardenRoot.matrix.copy(matrix);
  gardenRoot.matrix.decompose(gardenRoot.position, gardenRoot.quaternion, gardenRoot.scale);
  reticle.visible = false;
  createInitialGarden();
  setHint("Tap floor to plant flower");
  updateDebug();
}

function createInitialGarden() {
  if (!gardenRoot || flowers.length > 0) return;

  for (let i = 0; i < FLOWER_COUNT; i += 1) {
    const angle = (i / FLOWER_COUNT) * Math.PI * 2 + Math.random() * 0.35;
    const radius = FLOWER_RADIUS * (0.28 + Math.random() * 0.58);
    addFlower(new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius));
  }

  createPetalRain();
}

function addFlower(position) {
  if (!gardenRoot) return;

  const flower = createFlower(randomItem(FLOWER_COLORS));
  flower.position.copy(position);
  flower.scale.setScalar(0.001);
  flower.userData.createdAt = performance.now();
  gardenRoot.add(flower);
  flowers.push(flower);
  updateDebug();
}

function addFlowerAtWorldPosition(worldPosition) {
  if (!gardenRoot) return;

  const localPosition = gardenRoot.worldToLocal(worldPosition.clone());
  localPosition.y = 0;
  addFlower(localPosition);
}

function createFlower(color) {
  const flower = new THREE.Group();
  const stemHeight = 0.28 + Math.random() * 0.18;
  const headY = stemHeight;
  const petalCount = 7;

  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.01, 0.018, stemHeight, 8),
    new THREE.MeshBasicMaterial({ color: "#76a66e" })
  );
  stem.position.y = stemHeight / 2;
  flower.add(stem);

  const head = new THREE.Group();
  head.position.y = headY;
  head.rotation.x = -0.25;
  flower.add(head);

  for (let i = 0; i < petalCount; i += 1) {
    const angle = (i / petalCount) * Math.PI * 2;
    const petal = new THREE.Mesh(
      new THREE.CircleGeometry(0.065, 18),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
      })
    );
    petal.scale.set(0.6, 1, 1);
    petal.position.set(Math.cos(angle) * 0.055, Math.sin(angle) * 0.055, 0);
    petal.rotation.z = angle;
    head.add(petal);
  }

  const center = new THREE.Mesh(
    new THREE.SphereGeometry(0.035, 12, 8),
    new THREE.MeshBasicMaterial({ color: "#ffe7a6" })
  );
  center.position.z = 0.02;
  head.add(center);

  return flower;
}

function createPetalRain() {
  if (!gardenRoot || petals.length > 0) return;

  for (let i = 0; i < PETAL_COUNT; i += 1) {
    const petal = createPetal();
    resetPetal(petal, true);
    gardenRoot.add(petal.mesh);
    petals.push(petal);
  }
  updateDebug();
}

function createPetal() {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.035 + Math.random() * 0.025, 0.07 + Math.random() * 0.05),
    new THREE.MeshBasicMaterial({
      color: randomItem(PETAL_COLORS),
      transparent: true,
      opacity: 0.86,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );

  return {
    mesh,
    fallSpeed: 0.004 + Math.random() * 0.006,
    drift: 0.006 + Math.random() * 0.012,
    spinSpeed: 0.012 + Math.random() * 0.026,
    phase: Math.random() * Math.PI * 2,
  };
}

function resetPetal(petal, randomY = false) {
  petal.mesh.position.set(
    -FLOWER_RADIUS + Math.random() * FLOWER_RADIUS * 2,
    randomY ? Math.random() * PETAL_HEIGHT : PETAL_HEIGHT,
    -FLOWER_RADIUS + Math.random() * FLOWER_RADIUS * 2
  );
  petal.mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
}

function updateScene(time) {
  updateFlowerGrowth(time);
  updatePetals(time);
}

function updateFlowerGrowth(time) {
  for (const flower of flowers) {
    const elapsed = time - flower.userData.createdAt;
    const progress = Math.min(1, elapsed / FLOWER_GROW_DURATION);
    const eased = 1 - Math.pow(1 - progress, 3);
    flower.scale.setScalar(Math.max(0.001, eased));
  }
}

function updatePetals(time) {
  for (const petal of petals) {
    petal.mesh.position.y -= petal.fallSpeed;
    petal.mesh.position.x += Math.sin(time * 0.0015 + petal.phase) * petal.drift;
    petal.mesh.rotation.x += petal.spinSpeed * 0.45;
    petal.mesh.rotation.y += petal.spinSpeed;
    petal.mesh.rotation.z += petal.spinSpeed * 0.3;

    if (petal.mesh.position.y < 0) {
      resetPetal(petal);
    }
  }
}

function getFallbackGroundHit(clientX, clientY) {
  tapPosition.x = (clientX / window.innerWidth) * 2 - 1;
  tapPosition.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(tapPosition, camera);

  const didHit = raycaster.ray.intersectPlane(fallbackGroundPlane, fallbackHitPoint);
  return didHit ? fallbackHitPoint.clone() : null;
}

function createReticle() {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.09, 0.12, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: "#fff8ed",
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
    })
  );
  ring.matrixAutoUpdate = false;
  ring.visible = false;
  return ring;
}

// 未來會在這裡載入 flower.glb，取代目前的幾何花朵。
async function loadGLB() {
  return null;
}

function updateDebug() {
  debugPlane.textContent = planeFound ? "Yes" : "No";
  debugFlowers.textContent = String(flowers.length);
  debugPetals.textContent = String(petals.length);
}

function setStatus(message) {
  statusText.textContent = message;
}

function setHint(message) {
  hintText.textContent = message;
}

function resetExperience() {
  xrSession = null;
  hitTestSource = null;
  planeFound = false;
  setHint("Start AR");
  document.body.classList.remove("is-running");
  startButton.disabled = false;
  updateDebug();
}

function resize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)];
}
