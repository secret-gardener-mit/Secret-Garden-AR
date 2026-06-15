import * as THREE from "three";
import { MindARThree } from "mindar-image-three";

// 可調參數：第一版以手機穩定為主，若現場手機效能足夠，可逐步增加數量。
const PETAL_COUNT = 80;
const FLOWER_COUNT = 24;
const PETAL_FALL_SPEED = 0.01;
const FLOWER_GROW_SPEED = 0.012;

// 場景範圍與顏色也集中在這裡，之後調整現場位置會比較快。
const TARGET_SRC = "./ar/targets.mind";
const PETAL_COLORS = ["#ffd7e6", "#fff1c7", "#f7bfd4", "#dceecb", "#f5efe8"];
const FLOWER_COLORS = ["#f8bfd4", "#ffd7a8", "#fff1a8", "#bde5bd", "#c9d7ff", "#d7c2ff"];
const LEAF_COLOR = "#8fbf89";
const FLOWER_AREA = {
  xMin: -0.48,
  xMax: 0.48,
  zMin: 0.06,
  zMax: 0.16,
  y: -0.36,
};
const PETAL_AREA = {
  xMin: -0.54,
  xMax: 0.54,
  yMin: 0.24,
  yMax: 1.06,
  zMin: 0.1,
  zMax: 0.24,
};
const CONTENT_Z_OFFSET = 0.08;
const TARGET_FOUND_MESSAGE = "已辨識圖卡。花瓣正在落下，花朵正在長出。";

const container = document.querySelector("#ar-container");
const startButton = document.querySelector("#start-ar");
const stopButton = document.querySelector("#stop-ar");
const statusText = document.querySelector("#ar-status");
const scanHint = document.querySelector("#scan-hint");

let mindarThree = null;
let anchor = null;
let petals = [];
let flowers = [];
let animationId = null;
let scanReminderTimer = null;
let running = false;
let tracking = false;

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function setStatus(message) {
  statusText.textContent = message;
}

function setRunningState(nextRunning) {
  running = nextRunning;
  document.body.classList.toggle("is-running", nextRunning);
}

function setTrackingState(nextTracking) {
  tracking = nextTracking;
  document.body.classList.toggle("is-tracking", nextTracking);
  if (nextTracking) {
    clearScanReminder();
    setStatus(TARGET_FOUND_MESSAGE);
  }
  scanHint.textContent = nextTracking
    ? "已辨識圖卡。花瓣會在圖卡上方落下，花朵會從周圍慢慢長出。"
    : "請對準秘密花園圖卡。辨識成功後，花瓣會在鋼琴上方落下，花朵會從周圍慢慢長出。";
}

function clearScanReminder() {
  if (!scanReminderTimer) return;
  window.clearTimeout(scanReminderTimer);
  scanReminderTimer = null;
}

function scheduleScanReminder() {
  clearScanReminder();
  scanReminderTimer = window.setTimeout(() => {
    if (tracking || !running) return;
    setStatus("尚未辨識到圖卡。請讓圖卡填滿白色框線，避免反光、模糊或過斜；若是用螢幕顯示圖卡，建議改成列印紙本測試。");
  }, 6500);
}

function isLocalhost() {
  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

function getErrorMessage(error) {
  const name = error?.name || "";
  const message = error?.message || String(error || "");

  if (!name && !message) {
    return "相機沒有成功啟動。請確認已允許相機權限，並改用 Safari 或 Chrome 開啟，不要使用 LINE、Instagram 等 App 內建瀏覽器。";
  }

  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "相機權限被拒絕。請在瀏覽器網址列或網站設定中允許相機後，重新整理再試一次。";
  }

  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "找不到可用相機。請改用有相機的手機，或確認沒有其他 App 正在佔用相機。";
  }

  if (name === "NotReadableError" || name === "TrackStartError") {
    return "相機目前無法讀取。請關閉其他使用相機的 App，重新整理頁面後再試一次。";
  }

  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return "瀏覽器無法使用指定的相機設定。請改用 Safari 或 Chrome，並確認可使用後鏡頭。";
  }

  if (message.includes("Failed to fetch") || message.includes("NetworkError")) {
    return "讀取 AR 檔案失敗。請確認 ar/targets.mind 已上傳，且網頁不是用 file:// 開啟。";
  }

  if (message.toLowerCase().includes("target") || message.toLowerCase().includes("mind")) {
    return `targets.mind 可能不是有效的 MindAR image target。原始錯誤：${message}`;
  }

  return `AR 啟動失敗。原始錯誤：${message}`;
}

function ensureCameraSupport() {
  if (!window.isSecureContext && !isLocalhost()) {
    throw new Error("相機需要 HTTPS。請使用 https://secret-garden.art/ar.html 開啟。");
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("此瀏覽器不支援 WebAR 需要的相機 API。請改用 Safari 或 Chrome 開啟，不要使用 LINE、Instagram 等 App 內建瀏覽器。");
  }
}

async function requestCameraAccess() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  });

  for (const track of stream.getTracks()) {
    track.stop();
  }
}

async function checkTargetFile() {
  try {
    const response = await fetch(TARGET_SRC, { cache: "no-store" });
    if (!response.ok) {
      return {
        ok: false,
        message: `找不到 ar/targets.mind，伺服器回應 ${response.status}。請先用秘密花園 AR 定位圖卡編譯 MindAR target，再放到 ar 資料夾。`,
      };
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength < 1024) {
      return {
        ok: false,
        message: "ar/targets.mind 檔案太小，可能不是有效的 MindAR target。請重新編譯定位圖卡後上傳。",
      };
    }

    const bytes = new Uint8Array(buffer.slice(0, 4));
    const looksLikeMindTarget = bytes[0] === 0x82 || bytes[0] === 0x83 || bytes[0] === 0xde;
    if (!looksLikeMindTarget) {
      return {
        ok: false,
        message: "ar/targets.mind 已讀取，但檔案開頭不像 MindAR target。請確認不是圖片、壓縮檔或 HTML 錯誤頁。",
      };
    }

    return { ok: true, size: buffer.byteLength };
  } catch (error) {
    return { ok: false, message: getErrorMessage(error) };
  }
}

function createPetalMaterial(color) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.86,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

function createPetal(index) {
  const geometry = new THREE.PlaneGeometry(randomBetween(0.055, 0.09), randomBetween(0.09, 0.16));
  const material = createPetalMaterial(pick(PETAL_COLORS));
  const mesh = new THREE.Mesh(geometry, material);

  const petal = {
    mesh,
    drift: randomBetween(0.004, 0.014),
    fallSpeed: PETAL_FALL_SPEED * randomBetween(0.72, 1.35),
    spinSpeed: randomBetween(0.006, 0.022),
    phase: randomBetween(0, Math.PI * 2),
    index,
  };

  resetPetal(petal, true);
  return petal;
}

function resetPetal(petal, firstDrop = false) {
  petal.mesh.position.set(
    randomBetween(PETAL_AREA.xMin, PETAL_AREA.xMax),
    firstDrop ? randomBetween(PETAL_AREA.yMin, PETAL_AREA.yMax) : PETAL_AREA.yMax + randomBetween(0, 0.28),
    randomBetween(PETAL_AREA.zMin, PETAL_AREA.zMax)
  );
  petal.mesh.rotation.set(randomBetween(-0.4, 0.4), randomBetween(0, Math.PI), randomBetween(0, Math.PI));
}

function createFlowerPetal(color, angle, size) {
  const geometry = new THREE.CircleGeometry(size, 18);
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.94,
    side: THREE.DoubleSide,
  });
  const petal = new THREE.Mesh(geometry, material);
  petal.scale.set(0.58, 1, 1);
  petal.position.set(Math.cos(angle) * size * 0.72, Math.sin(angle) * size * 0.72, 0);
  petal.rotation.z = angle;
  return petal;
}

function createFlower(index) {
  const group = new THREE.Group();
  const color = pick(FLOWER_COLORS);
  const size = randomBetween(0.075, 0.13);
  const stemHeight = randomBetween(0.14, 0.26);
  const petalsInFlower = 6 + Math.floor(Math.random() * 3);

  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.008, 0.014, stemHeight, 8),
    new THREE.MeshBasicMaterial({ color: LEAF_COLOR })
  );
  stem.position.y = stemHeight / 2;
  group.add(stem);

  const head = new THREE.Group();
  head.position.y = stemHeight;
  for (let i = 0; i < petalsInFlower; i += 1) {
    head.add(createFlowerPetal(color, (i / petalsInFlower) * Math.PI * 2, size));
  }
  const center = new THREE.Mesh(
    new THREE.SphereGeometry(size * 0.34, 12, 8),
    new THREE.MeshBasicMaterial({ color: "#ffe7a6" })
  );
  center.position.z = 0.018;
  head.add(center);
  group.add(head);

  group.position.set(
    randomBetween(FLOWER_AREA.xMin, FLOWER_AREA.xMax),
    FLOWER_AREA.y,
    randomBetween(FLOWER_AREA.zMin, FLOWER_AREA.zMax)
  );
  group.rotation.y = randomBetween(-0.5, 0.5);

  const finalScale = randomBetween(0.72, 1.2);
  group.scale.setScalar(0.001);

  return {
    group,
    finalScale,
    growth: 0,
    delay: index * 0.035 + randomBetween(0, 0.5),
    sway: randomBetween(0.4, 1.2),
    phase: randomBetween(0, Math.PI * 2),
  };
}

function createSoftGround() {
  const group = new THREE.Group();
  const colors = ["#dceecb", "#f8bfd4", "#fff1a8"];

  for (let i = 0; i < 10; i += 1) {
    const ring = new THREE.Mesh(
      new THREE.CircleGeometry(randomBetween(0.1, 0.24), 28),
      new THREE.MeshBasicMaterial({
        color: pick(colors),
        transparent: true,
        opacity: randomBetween(0.12, 0.24),
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    ring.position.set(randomBetween(-0.5, 0.5), FLOWER_AREA.y - 0.012, randomBetween(0.05, 0.18));
    group.add(ring);
  }

  return group;
}

function createTargetBloomGuide() {
  const group = new THREE.Group();
  const guideMaterial = new THREE.MeshBasicMaterial({
    color: "#fff1c7",
    transparent: true,
    opacity: 0.34,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const halo = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.28, 48), guideMaterial);
  halo.position.set(0, -0.02, CONTENT_Z_OFFSET + 0.01);
  group.add(halo);

  const center = new THREE.Mesh(
    new THREE.CircleGeometry(0.035, 24),
    new THREE.MeshBasicMaterial({
      color: "#f8bfd4",
      transparent: true,
      opacity: 0.65,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  center.position.set(0, -0.02, CONTENT_Z_OFFSET + 0.012);
  group.add(center);

  return group;
}

function buildScene() {
  anchor.group.clear();
  petals = [];
  flowers = [];

  const content = new THREE.Group();
  content.position.z = CONTENT_Z_OFFSET;
  content.add(createTargetBloomGuide());
  content.add(createSoftGround());

  for (let i = 0; i < FLOWER_COUNT; i += 1) {
    const flower = createFlower(i);
    flowers.push(flower);
    content.add(flower.group);
  }

  for (let i = 0; i < PETAL_COUNT; i += 1) {
    const petal = createPetal(i);
    petals.push(petal);
    content.add(petal.mesh);
  }

  const ambientLight = new THREE.AmbientLight(0xffffff, 1.35);
  content.add(ambientLight);

  anchor.group.add(content);
}

function updatePetals(time) {
  for (const petal of petals) {
    petal.mesh.position.y -= petal.fallSpeed;
    petal.mesh.position.x += Math.sin(time * 0.0014 + petal.phase) * petal.drift;
    petal.mesh.rotation.x += petal.spinSpeed * 0.55;
    petal.mesh.rotation.y += petal.spinSpeed;
    petal.mesh.rotation.z += petal.spinSpeed * 0.35;

    if (petal.mesh.position.y < -0.5) {
      resetPetal(petal);
    }
  }
}

function updateFlowers(time) {
  for (const flower of flowers) {
    if (flower.delay > 0) {
      flower.delay -= FLOWER_GROW_SPEED;
      continue;
    }

    flower.growth = Math.min(1, flower.growth + FLOWER_GROW_SPEED);
    const easedGrowth = 1 - Math.pow(1 - flower.growth, 3);
    const pulse = 1 + Math.sin(time * 0.0012 + flower.phase) * 0.025 * flower.sway;
    flower.group.scale.setScalar(Math.max(0.001, easedGrowth * flower.finalScale * pulse));
  }
}

function renderLoop(time) {
  if (!mindarThree || !running) return;

  if (tracking) {
    updatePetals(time);
    updateFlowers(time);
  }

  const { renderer, scene, camera } = mindarThree;
  renderer.render(scene, camera);
  animationId = requestAnimationFrame(renderLoop);
}

async function startAR() {
  if (running) return;

  startButton.disabled = true;
  setStatus("正在檢查定位圖卡檔案...");

  try {
    ensureCameraSupport();
  } catch (error) {
    startButton.disabled = false;
    setStatus(getErrorMessage(error));
    return;
  }

  const targetFile = await checkTargetFile();
  if (!targetFile.ok) {
    startButton.disabled = false;
    setStatus(targetFile.message);
    return;
  }

  try {
    setStatus(`定位圖卡已讀取（${Math.round(targetFile.size / 1024)} KB），正在請求相機權限...`);
    await requestCameraAccess();

    setStatus("相機權限已取得，正在啟動 AR...");
    mindarThree = new MindARThree({
      container,
      imageTargetSrc: TARGET_SRC,
      maxTrack: 1,
      filterMinCF: 0.0001,
      filterBeta: 0.001,
      uiLoading: "no",
      uiScanning: "no",
      uiError: "no",
    });

    const { renderer } = mindarThree;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    anchor = mindarThree.addAnchor(0);
    anchor.onTargetFound = () => setTrackingState(true);
    anchor.onTargetLost = () => setTrackingState(false);

    buildScene();
    await mindarThree.start();

    setRunningState(true);
    setTrackingState(false);
    setStatus("AR 已啟動。請對準秘密花園圖卡。");
    scheduleScanReminder();
    animationId = requestAnimationFrame(renderLoop);
  } catch (error) {
    console.error(error);
    if (mindarThree) {
      try {
        await mindarThree.stop();
      } catch (stopError) {
        console.warn(stopError);
      }
    }
    container.replaceChildren();
    mindarThree = null;
    anchor = null;
    setRunningState(false);
    setTrackingState(false);
    setStatus(getErrorMessage(error));
  } finally {
    startButton.disabled = false;
  }
}

async function stopAR() {
  if (!mindarThree) {
    setRunningState(false);
    return;
  }

  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
  clearScanReminder();

  await mindarThree.stop();
  mindarThree.renderer.setAnimationLoop(null);
  container.replaceChildren();
  mindarThree = null;
  anchor = null;
  setRunningState(false);
  setTrackingState(false);
  setStatus("AR 已停止。可再次點擊開始。");
}

function warnIfInsecure() {
  if (window.isSecureContext || isLocalhost()) return;
  setStatus("相機需要 HTTPS。請用 GitHub Pages 或 Live Server 的安全網址開啟。");
}

startButton.addEventListener("click", startAR);
stopButton.addEventListener("click", stopAR);
window.addEventListener("pagehide", stopAR);
warnIfInsecure();
