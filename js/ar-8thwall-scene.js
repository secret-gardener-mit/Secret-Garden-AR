(function () {
  "use strict";

  // Secret Garden 8th Wall v0.1a2-2
  // 調整參數集中在這裡，後續可以直接修改數量、半徑、高度與動畫時間。
  const FLOWER_COUNT = 5;
  const PETAL_COUNT = 100;
  const FLOWER_RADIUS = 1.5;
  const PETAL_HEIGHT = 2.5;
  const FLOWER_GROW_DURATION = 1000;
  const AUTO_PLACE_SCREEN_X = 0.5;
  const AUTO_PLACE_SCREEN_Y = 0.62;

  const FLOWER_COLORS = ["#f8bfd4", "#ffd7a8", "#fff1a8", "#bde5bd", "#c9d7ff", "#d7c2ff"];
  const PETAL_COLORS = ["#ffd7e6", "#fff1c7", "#f7bfd4", "#dceecb", "#f5efe8"];
  const HORIZONTAL_HIT_TYPES = ["estimatedHorizontalPlane", "horizontalPlane"];

  const canvas = document.querySelector("#camerafeed");
  const startButton = document.querySelector("#start-ar");
  const statusText = document.querySelector("#status");
  const hintText = document.querySelector("#hint");
  const debugTracking = document.querySelector("#debug-tracking");
  const debugSurface = document.querySelector("#debug-surface");
  const debugFlowers = document.querySelector("#debug-flowers");
  const debugPetals = document.querySelector("#debug-petals");

  let xrStarted = false;
  let trackingStarted = false;
  let surfaceFound = false;
  let scene;
  let camera;
  let renderer;
  let gardenRoot;
  let reticle;
  let flowers = [];
  let petals = [];

  updateDebug();
  setHint("Start AR");

  startButton.addEventListener("click", startAR);

  function startAR() {
    if (xrStarted) return;
    xrStarted = true;
    startButton.disabled = true;
    document.body.classList.add("is-running");
    setStatus("正在啟動 8th Wall...");
    setHint("Move phone to scan floor");

    const appKey = window.SECRET_GARDEN_8THWALL_APP_KEY || "";
    if (!appKey || appKey === "YOUR_8TH_WALL_APP_KEY") {
      document.body.classList.add("needs-app-key");
      setStatus("尚未填入 8th Wall appKey。填入後才能啟動真實 SLAM。");
      startButton.disabled = false;
      xrStarted = false;
      document.body.classList.remove("is-running");
      setHint("Add 8th Wall appKey");
      return;
    } else {
      document.body.classList.remove("needs-app-key");
    }

    if (window.XR8) {
      onXRLoaded();
    } else {
      window.addEventListener("xrloaded", onXRLoaded, { once: true });
    }
  }

  function onXRLoaded() {
    if (!window.XR8 || !window.XRExtras || !window.THREE) {
      setStatus("8th Wall 或 Three.js 尚未載入完成。");
      startButton.disabled = false;
      return;
    }

    try {
      XR8.addCameraPipelineModules([
        XR8.GlTextureRenderer.pipelineModule(),
        XR8.Threejs.pipelineModule(),
        XR8.XrController.pipelineModule(),
        XRExtras.AlmostThere.pipelineModule(),
        XRExtras.FullWindowCanvas.pipelineModule(),
        XRExtras.Loading.pipelineModule(),
        XRExtras.RuntimeError.pipelineModule(),
        secretGardenPipelineModule(),
      ]);

      XR8.XrController.configure({ disableWorldTracking: false });
      XR8.run({ canvas });
    } catch (error) {
      console.error("8th Wall start failed", error);
      setStatus("8th Wall 啟動失敗，請確認 appKey、授權網域與 HTTPS。");
      startButton.disabled = false;
    }
  }

  function secretGardenPipelineModule() {
    return {
      name: "secret-garden-8thwall",

      onStart: ({ canvas: activeCanvas }) => {
        const xrScene = XR8.Threejs.xrScene();
        scene = xrScene.scene;
        camera = xrScene.camera;
        renderer = xrScene.renderer;

        if ("outputColorSpace" in renderer && THREE.SRGBColorSpace) {
          renderer.outputColorSpace = THREE.SRGBColorSpace;
        } else {
          renderer.outputEncoding = THREE.sRGBEncoding;
        }
        scene.add(new THREE.HemisphereLight(0xffffff, 0x53624d, 1.8));
        scene.add(new THREE.AmbientLight(0xffffff, 0.7));

        reticle = createReticle();
        scene.add(reticle);

        activeCanvas.addEventListener("touchstart", onTouchStart, { passive: false });
        activeCanvas.addEventListener("mousedown", onMouseDown);

        trackingStarted = true;
        updateDebug();
        setStatus("tracking started。請慢慢移動手機掃描地板。");
        setHint("Move phone to scan floor");
      },

      onUpdate: () => {
        if (!gardenRoot) {
          updateReticleFromCenterHit();
        }
        updateScene(performance.now());
      },
    };
  }

  function updateReticleFromCenterHit() {
    const hit = getWorldHit(AUTO_PLACE_SCREEN_X, AUTO_PLACE_SCREEN_Y);
    if (!hit) {
      surfaceFound = false;
      if (reticle) reticle.visible = false;
      updateDebug();
      return;
    }

    surfaceFound = true;
    applyHitToObject(reticle, hit);
    reticle.visible = true;
    updateDebug();
    setHint("Tap to place garden");
    placeGarden(hit);
  }

  function onTouchStart(event) {
    event.preventDefault();
    if (!event.touches || event.touches.length === 0) return;

    const touch = event.touches[0];
    const x = touch.clientX / window.innerWidth;
    const y = touch.clientY / window.innerHeight;
    placeFlowerFromScreenPoint(x, y);
  }

  function onMouseDown(event) {
    const x = event.clientX / window.innerWidth;
    const y = event.clientY / window.innerHeight;
    placeFlowerFromScreenPoint(x, y);
  }

  function placeFlowerFromScreenPoint(x, y) {
    const hit = getWorldHit(x, y);
    if (!hit) {
      setStatus("尚未找到可種花的地板位置，請再掃描地面。");
      return;
    }

    surfaceFound = true;
    updateDebug();

    if (!gardenRoot) {
      placeGarden(hit);
      return;
    }

    const worldPosition = new THREE.Vector3();
    hit.matrix.decompose(worldPosition, new THREE.Quaternion(), new THREE.Vector3());
    const localPosition = gardenRoot.worldToLocal(worldPosition);
    localPosition.y = 0;
    addFlower(localPosition);
    setStatus("已在點擊位置種下一朵花。");
  }

  function getWorldHit(normalizedX, normalizedY) {
    if (!window.XR8?.XrController?.hitTest) return null;

    let hits = [];
    try {
      hits = XR8.XrController.hitTest(normalizedX, normalizedY, HORIZONTAL_HIT_TYPES);
    } catch (error) {
      try {
        hits = XR8.XrController.hitTest(normalizedX, normalizedY);
      } catch (fallbackError) {
        console.warn("8th Wall hitTest failed", fallbackError);
        return null;
      }
    }

    if (!Array.isArray(hits) || hits.length === 0) return null;
    return normalizeHit(hits[0]);
  }

  function normalizeHit(hit) {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);

    if (hit.matrix || hit.transform?.matrix) {
      const sourceMatrix = hit.matrix || hit.transform.matrix;
      if (sourceMatrix.isMatrix4) {
        matrix.copy(sourceMatrix);
      } else if (sourceMatrix.elements) {
        matrix.fromArray(sourceMatrix.elements);
      } else {
        matrix.fromArray(sourceMatrix);
      }
      return { matrix };
    }

    const rawPosition = hit.position || hit.point || hit;
    if (Array.isArray(rawPosition)) {
      position.set(rawPosition[0] || 0, rawPosition[1] || 0, rawPosition[2] || 0);
    } else {
      position.set(rawPosition.x || 0, rawPosition.y || 0, rawPosition.z || 0);
    }

    const rawRotation = hit.rotation || hit.quaternion;
    if (rawRotation) {
      if (Array.isArray(rawRotation)) {
        quaternion.set(rawRotation[0] || 0, rawRotation[1] || 0, rawRotation[2] || 0, rawRotation[3] || 1);
      } else {
        quaternion.set(rawRotation.x || 0, rawRotation.y || 0, rawRotation.z || 0, rawRotation.w || 1);
      }
    }

    matrix.compose(position, quaternion, scale);
    return { matrix };
  }

  function applyHitToObject(object, hit) {
    object.matrix.copy(hit.matrix);
    object.matrix.decompose(object.position, object.quaternion, object.scale);
  }

  function placeGarden(hit) {
    if (!scene || gardenRoot) return;

    gardenRoot = new THREE.Group();
    scene.add(gardenRoot);
    applyHitToObject(gardenRoot, hit);

    createInitialGarden();
    createPetalRain();
    if (reticle) reticle.visible = false;

    surfaceFound = true;
    updateDebug();
    setStatus("surface found。花園已固定在真實空間。");
    setHint("Tap floor to plant flower");
  }

  function createInitialGarden() {
    for (let i = 0; i < FLOWER_COUNT; i += 1) {
      const angle = (i / FLOWER_COUNT) * Math.PI * 2 + Math.random() * 0.35;
      const radius = FLOWER_RADIUS * (0.22 + Math.random() * 0.58);
      addFlower(new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius));
    }
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

  function createFlower(color) {
    const flower = new THREE.Group();
    const stemHeight = 0.28 + Math.random() * 0.18;
    const petalCount = 7;

    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.01, 0.018, stemHeight, 8),
      new THREE.MeshBasicMaterial({ color: "#76a66e" })
    );
    stem.position.y = stemHeight / 2;
    flower.add(stem);

    const head = new THREE.Group();
    head.position.y = stemHeight;
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

  function createReticle() {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.09, 0.12, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: "#fff8ed",
        transparent: true,
        opacity: 0.84,
        side: THREE.DoubleSide,
      })
    );
    ring.visible = false;
    return ring;
  }

  // 未來會在這裡載入 flower.glb / petal.glb，取代目前的幾何花朵與平面花瓣。
  async function loadGLB() {
    return null;
  }

  function updateDebug() {
    debugTracking.textContent = trackingStarted ? "Yes" : "No";
    debugSurface.textContent = surfaceFound ? "Yes" : "No";
    debugFlowers.textContent = String(flowers.length);
    debugPetals.textContent = String(petals.length);
  }

  function setStatus(message) {
    statusText.textContent = message;
  }

  function setHint(message) {
    hintText.textContent = message;
  }

  function randomItem(list) {
    return list[Math.floor(Math.random() * list.length)];
  }
})();
