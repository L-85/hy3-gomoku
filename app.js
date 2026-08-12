// 五子棋 · Hy3 —— 由腾讯混元 Hy3 驱动的水墨网页五子棋（AI 由 Hy3 驱动，无 Key 时回退本地评分引擎）
// 颜色约定：0=空  1=白  2=黑
// 模式：person 双人 / bot 人机（人=黑先手，Hy3=白）/ challenge 残局（人=白先手，Hy3=黑拦截）

(function () {
  "use strict";

  var SIZE = 15;
  var EMPTY = 0, WHITE = 1, BLACK = 2;
  var WIN = 5;

  var PROVIDERS = {
    siliconflow: { base: "https://api.siliconflow.com/v1", model: "tencent/Hy3" },
    novita:      { base: "https://api.novita.ai/openai/v1", model: "tencent/hy3" },
    custom:      { base: "", model: "" },
  };
  var LS_KEY = "gomoku_hy3_settings";
  var LS_RECORDS = "gomoku_hy3_records";

  var $ = function (id) { return document.getElementById(id); };
  function hidden(id) { return $(id).classList.contains("hidden"); }

  // 原版题诗（水墨风点缀）
  var POEMS = [
    "落子无声听风雨", "一局棋罢指犹凉", "闲敲棋子落灯花", "棋逢对手方知味",
    "局到残时见真功", "静观其变待时机", "一着妙手定乾坤", "心有棋盘天地宽",
    "运筹帷幄决胜负", "世事如棋局局新", "观棋不语真君子", "起手无回大丈夫",
    "棋虽小道品自高", "胜负之外有清风", "落灯花处听棋声"
  ];
  function showPoem() {
    var a = POEMS[Math.floor(Math.random() * POEMS.length)];
    var b = POEMS[Math.floor(Math.random() * POEMS.length)];
    while (b === a) b = POEMS[Math.floor(Math.random() * POEMS.length)];
    $("poem").textContent = a + "\n" + b;
  }
  function isEmptyBoard() {
    for (var r = 0; r < SIZE; r++) for (var c = 0; c < SIZE; c++) if (board[r][c] !== EMPTY) return false;
    return true;
  }

  /* ===== 全局状态 ===== */
  var board = [];
  var history = [];          // [{r,c,color}]
  var mode = "bot";          // person | bot | challenge
  var difficulty = "medium"; // easy | medium | hard
  var turn = BLACK;          // 当前该谁落子
  var aiColor = WHITE;       // 本局 AI 执什么色
  var gameOver = false;
  var aiThinking = false;
  var settings = loadSettings();

  var challengeIdx = -1;
  var movesLeft = 0;

  var timerStart = 0, timerInterval = null;
  var thinkTimerStart = 0, thinkTimerInterval = null;
  var audioCtx = null;

  /* ===== 设置 ===== */
  function loadSettings() {
    try { var s = JSON.parse(localStorage.getItem(LS_KEY)); return s && typeof s === "object" ? s : {}; }
    catch (e) { return {}; }
  }
  function saveSettings() { localStorage.setItem(LS_KEY, JSON.stringify(settings)); }
  function applyDefaults() {
    var p = PROVIDERS[settings.provider] || PROVIDERS.custom;
    if (!settings.baseUrl && p.base) settings.baseUrl = p.base;
    if (!settings.model && p.model) settings.model = p.model;
  }
  applyDefaults();

  /* ===== 音效（Web Audio，落子轻响） ===== */
  function playClick() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var o = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      o.type = "triangle";
      o.frequency.setValueAtTime(320, audioCtx.currentTime);
      o.frequency.exponentialRampToValueAtTime(180, audioCtx.currentTime + 0.08);
      g.gain.setValueAtTime(0.18, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.13);
    } catch (e) {}
  }
  function playWin() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      [523, 659, 784, 1047].forEach(function (f, i) {
        var o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = "sine"; o.frequency.value = f;
        var t = audioCtx.currentTime + i * 0.12;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t); o.stop(t + 0.32);
      });
    } catch (e) {}
  }

  /* ===== 棋盘初始化 ===== */
  function initBoard() {
    board = [];
    for (var r = 0; r < SIZE; r++) { board[r] = []; for (var c = 0; c < SIZE; c++) board[r][c] = EMPTY; }
    history = [];
    gameOver = false;
    aiThinking = false;
    winLine = null; hoverRC = null;
    idleThinkPanel();
    $("resultModal").classList.add("hidden");
    startTimer();
  }

  /* ===== 渲染 ===== */
  /* ===== 棋盘渲染（Canvas：网格线/星位/棋子共用 PAD+i*CELL 同一坐标，保证落子精确在交叉点） ===== */
  var CELL = 34, PAD = 26;
  var BOARD_PX = PAD * 2 + CELL * (SIZE - 1);
  var canvas = null, bctx = null, winLine = null, hoverRC = null;

  function setupBoard() {
    canvas = $("board");
    if (!canvas) return;
    bctx = canvas.getContext("2d");
    // 不在此处强制 width:100%（会撑满 flex 容器导致棋盘放巨大）；尺寸交由 styles.css 的
    // .board { width:480px; height:auto } 控制，保持正方形且响应式。
    canvas.addEventListener("click", onBoardClick);
    canvas.addEventListener("mousemove", onBoardHover);
    canvas.addEventListener("mouseleave", function () { hoverRC = null; drawBoard(); });
  }

  function drawBoard() {
    if (!canvas) setupBoard();
    if (!bctx) return;
    var dpr = window.devicePixelRatio || 1;
    var px = Math.round(BOARD_PX * dpr);
    if (canvas.width !== px) { canvas.width = px; canvas.height = px; }
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.clearRect(0, 0, BOARD_PX, BOARD_PX);

    drawWood();

    // 网格线：第 i 条线恰好穿过第 i 个交叉点（线宽 1，居中取整避免发虚）
    bctx.strokeStyle = "rgba(60,40,14,.82)";
    bctx.lineWidth = 1;
    for (var i = 0; i < SIZE; i++) {
      var p = Math.round(PAD + i * CELL) + 0.5;
      bctx.beginPath(); bctx.moveTo(PAD, p); bctx.lineTo(BOARD_PX - PAD, p); bctx.stroke();
      bctx.beginPath(); bctx.moveTo(p, PAD); bctx.lineTo(p, BOARD_PX - PAD); bctx.stroke();
    }
    // 星位：天元 + 四角
    var stars = [[3,3],[3,11],[11,3],[11,11],[7,7]];
    bctx.fillStyle = "rgba(60,40,14,.95)";
    stars.forEach(function (s) {
      bctx.beginPath(); bctx.arc(PAD + s[0]*CELL, PAD + s[1]*CELL, 3.5, 0, Math.PI*2); bctx.fill();
    });
    // 棋子
    var last = history[history.length - 1];
    for (var r = 0; r < SIZE; r++) for (var c = 0; c < SIZE; c++) {
      if (board[r][c] !== EMPTY) drawStone(r, c, board[r][c], last && last.r === r && last.c === c);
    }
    // 悬停预览（仅轮到玩家且为空位）
    if (hoverRC && !gameOver && !aiThinking && !isAITurn() && board[hoverRC.r][hoverRC.c] === EMPTY) {
      drawStone(hoverRC.r, hoverRC.c, turn, false, 0.42);
    }
    // 胜利连线
    if (winLine && winLine.length >= 2) {
      var a = winLine[0], b = winLine[winLine.length - 1];
      bctx.strokeStyle = "rgba(63,107,79,.92)";
      bctx.lineWidth = 4; bctx.lineCap = "round";
      bctx.beginPath();
      bctx.moveTo(PAD + a.c*CELL, PAD + a.r*CELL);
      bctx.lineTo(PAD + b.c*CELL, PAD + b.r*CELL);
      bctx.stroke();
    }
  }

  // 木纹底：暖色基底 + 确定性纹理（同一坐标每次重绘结果一致，不会闪）
  var woodDrawn = false;
  function drawWood() {
    var g = bctx.createLinearGradient(0, 0, BOARD_PX, BOARD_PX);
    g.addColorStop(0, "#e9c98c");
    g.addColorStop(0.5, "#dcb473");
    g.addColorStop(1, "#cfa257");
    bctx.fillStyle = g;
    bctx.fillRect(0, 0, BOARD_PX, BOARD_PX);
    // 木纹：多条纵向正弦暗纹（确定性，按位置算相位）
    bctx.save();
    bctx.globalAlpha = 0.07;
    bctx.strokeStyle = "#6b4a1c";
    bctx.lineWidth = 1.4;
    for (var k = 0; k < 26; k++) {
      var base = (k + 0.5) * (BOARD_PX / 26);
      var amp = 5 + (k % 4) * 2;
      var phase = k * 1.3;
      bctx.beginPath();
      for (var y = 0; y <= BOARD_PX; y += 6) {
        var x = base + Math.sin((y / BOARD_PX) * Math.PI * 2 * 2 + phase) * amp;
        if (y === 0) bctx.moveTo(x, y); else bctx.lineTo(x, y);
      }
      bctx.stroke();
    }
    bctx.restore();
    // 边缘暗角
    var vg = bctx.createRadialGradient(BOARD_PX/2, BOARD_PX/2, BOARD_PX*0.3, BOARD_PX/2, BOARD_PX/2, BOARD_PX*0.72);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(90,60,20,.22)");
    bctx.fillStyle = vg;
    bctx.fillRect(0, 0, BOARD_PX, BOARD_PX);
  }

  function drawStone(r, c, color, isLast, alpha) {
    var x = PAD + c * CELL, y = PAD + r * CELL, rad = CELL * 0.45;
    bctx.save();
    if (alpha != null) bctx.globalAlpha = alpha;
    // 投影
    bctx.beginPath(); bctx.ellipse(x + 1.5, y + 3, rad * 0.98, rad * 0.92, 0, 0, Math.PI * 2);
    bctx.fillStyle = "rgba(0,0,0,.28)"; bctx.fill();
    // 棋子主体（径向渐变模拟球面）
    var g = bctx.createRadialGradient(x - rad * 0.38, y - rad * 0.4, rad * 0.08, x, y, rad);
    if (color === BLACK) { g.addColorStop(0, "#5a5a5a"); g.addColorStop(0.55, "#1c1c1c"); g.addColorStop(1, "#060606"); }
    else { g.addColorStop(0, "#ffffff"); g.addColorStop(0.6, "#f1f1f1"); g.addColorStop(1, "#c4c4c4"); }
    bctx.beginPath(); bctx.arc(x, y, rad, 0, Math.PI * 2); bctx.fillStyle = g; bctx.fill();
    // 高光（小白点，增强立体感）
    bctx.beginPath();
    bctx.arc(x - rad * 0.34, y - rad * 0.38, rad * 0.22, 0, Math.PI * 2);
    bctx.fillStyle = color === BLACK ? "rgba(255,255,255,.28)" : "rgba(255,255,255,.9)";
    bctx.fill();
    bctx.restore();
    if (isLast) {
      bctx.save();
      bctx.strokeStyle = color === BLACK ? "#c8902c" : "#3f6b4f";
      bctx.lineWidth = 2.5;
      bctx.beginPath(); bctx.arc(x, y, rad * 0.46, 0, Math.PI * 2); bctx.stroke();
      bctx.restore();
    }
  }

  function eventToRC(e) {
    var rect = canvas.getBoundingClientRect();
    var sx = BOARD_PX / rect.width, sy = BOARD_PX / rect.height;
    var x = (e.clientX - rect.left) * sx, y = (e.clientY - rect.top) * sy;
    var c = Math.round((x - PAD) / CELL), r = Math.round((y - PAD) / CELL);
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return null;
    if (Math.abs(x - (PAD + c*CELL)) > CELL*0.5 || Math.abs(y - (PAD + r*CELL)) > CELL*0.5) return null;
    return { r: r, c: c };
  }
  function onBoardClick(e) { var rc = eventToRC(e); if (rc) onCellClick(rc.r, rc.c); }
  function onBoardHover(e) {
    var rc = eventToRC(e);
    var changed = (rc && (!hoverRC || hoverRC.r !== rc.r || hoverRC.c !== rc.c)) || (!rc && hoverRC);
    hoverRC = rc;
    if (changed) drawBoard();
  }

  function renderBoard() { hoverRC = null; drawBoard(); }
  function readVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    var n = parseInt(v);
    return isNaN(n) ? fallback : n;
  }
  function isAITurn() {
    return !gameOver && (turn === aiColor) && (mode !== "person");
  }

  /* ===== 点击落子 ===== */
  function onCellClick(r, c) {
    if (gameOver || aiThinking || isAITurn()) return;
    if (board[r][c] !== EMPTY) return;

    placePiece(r, c, turn);

    // 残局：扣除玩家步数
    if (mode === "challenge" && turn === WHITE) {
      movesLeft--;
      updateChallengeInfo();
    }

    if (checkWin(r, c)) { endGame(turn); return; }
    if (isDead()) { endGame(0); return; }
    if (mode === "challenge" && movesLeft <= 0 && !checkWin(r, c)) {
      // 步数耗尽且未胜
      endGame(aiColor, null, true);
      return;
    }

    turn = (turn === BLACK) ? WHITE : BLACK;
    updateUI();

    if (isAITurn()) aiTurn();
  }

  function placePiece(r, c, color) {
    board[r][c] = color;
    history.push({ r: r, c: c, color: color });
    playClick();
    renderBoard();
    updateUI();
  }

  /* ===== 胜负判定（移植自原版 checkWinAt / isWin） ===== */
  function checkWin(r, c) {
    var dirs = [[0,1],[1,0],[1,1],[1,-1]];
    var color = board[r][c];
    for (var d = 0; d < dirs.length; d++) {
      var dr = dirs[d][0], dc = dirs[d][1];
      var count = 1, line = [{ r: r, c: c }];
      for (var i = 1; i < WIN; i++) {
        var nr = r + dr * i, nc = c + dc * i;
        if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE || board[nr][nc] !== color) break;
        count++; line.push({ r: nr, c: nc });
      }
      for (var j = 1; j < WIN; j++) {
        var nr2 = r - dr * j, nc2 = c - dc * j;
        if (nr2 < 0 || nr2 >= SIZE || nc2 < 0 || nc2 >= SIZE || board[nr2][nc2] !== color) break;
        count++; line.unshift({ r: nr2, c: nc2 });
      }
      if (count >= WIN) { winLine = line; return true; }
    }
    return false;
  }
  function isDead() {
    for (var r = 0; r < SIZE; r++) for (var c = 0; c < SIZE; c++) if (board[r][c] === EMPTY) return false;
    return true;
  }

  // 胜利连线改由 canvas 在 drawBoard() 中绘制（见 winLine 变量）

  /* ===== UI 更新 ===== */
  function updateUI() {
    var badge = $("turnBadge");
    if (gameOver) { badge.textContent = "对局结束"; badge.className = "turn-badge over"; }
    else if (isAITurn()) { badge.textContent = "Hy3 思考中（执白）"; badge.className = "turn-badge ai"; }
    else {
      var who = (turn === BLACK) ? "执黑" : "执白";
      var lbl = (mode === "person") ? ("轮到 " + who) : ("轮到你（" + who + "）");
      badge.textContent = lbl; badge.className = "turn-badge your";
    }
    $("moveCount").textContent = history.length;
    $("undoBtn").disabled = history.length === 0 || aiThinking || gameOver;
  }

  /* ===== 计时 ===== */
  function startTimer() {
    timerStart = Date.now();
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(function () {
      var s = Math.floor((Date.now() - timerStart) / 1000);
      var m = String(Math.floor(s / 60)).padStart(2, "0");
      var ss = String(s % 60).padStart(2, "0");
      $("gameTime").textContent = m + ":" + ss;
    }, 1000);
  }

  /* ===== AI 回合 ===== */
  function aiTurn() {
    aiThinking = true;
    updateUI();
    showThinkPanel();
    // AI 执黑先手：首子占天元（对应原版开局逻辑）
    if (isEmptyBoard() && aiColor === BLACK) {
      doAIMove(7, 7, "开局执黑，先占天元（棋盘正中央），抢占全局要点。");
      return;
    }
    if (settings.apiKey) callHy3(aiColor, difficulty);
    else localAIThink(aiColor, difficulty);
  }

  // 思考面板常驻占位：空闲态只显示提示，思考态才填充内容（避免棋盘上下跳动）
  function idleThinkPanel(text) {
    var p = $("thinkPanel");
    p.classList.remove("hidden");
    p.classList.add("idle");
    $("thinkIdleText").textContent = text || "Hy3 待命中 · 落子后此处显示其思考过程";
  }
  function showThinkPanel() {
    if (mode === "challenge") return; // 残局不展示思考面板，保持简洁
    var p = $("thinkPanel");
    p.classList.remove("hidden", "idle");
    $("reasoningText").textContent = "";
    $("reasoningBox").removeAttribute("open");
    thinkTimerStart = Date.now();
    if (thinkTimerInterval) clearInterval(thinkTimerInterval);
    thinkTimerInterval = setInterval(function () {
      if (!aiThinking) { clearInterval(thinkTimerInterval); return; }
      $("thinkTimer").textContent = ((Date.now() - thinkTimerStart) / 1000).toFixed(1) + "s";
    }, 100);
  }

  /* ===== 本地 AI（内置评分引擎，作为无 Key 兜底） ===== */
  function localAIMove(color, diff) {
    var opp = (color === WHITE) ? BLACK : WHITE;
    var defMul = diff === "easy" ? 1.3 : diff === "hard" ? 0.7 : 1.0;
    var atkMul = diff === "easy" ? 0.6 : diff === "hard" ? 1.5 : 1.0;
    var dirs = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];

    var best = [], bestScore = -1;
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        if (board[r][c] !== EMPTY) continue;
        var score = 0;
        var maxOwnRun = 0, ownOpen = false, maxFoeRun = 0, foeOpen = false;
        for (var d = 0; d < dirs.length; d++) {
          var dr = dirs[d][0], dc = dirs[d][1];
          // 己方（进攻）
          var own = runCount(r, c, dr, dc, color);
          if (own.run > maxOwnRun) { maxOwnRun = own.run; ownOpen = own.open; }
          else if (own.run === maxOwnRun) ownOpen = ownOpen || own.open;
          // 对方（防守）
          var foe = runCount(r, c, dr, dc, opp);
          if (foe.run > maxFoeRun) { maxFoeRun = foe.run; foeOpen = foe.open; }
          else if (foe.run === maxFoeRun) foeOpen = foeOpen || foe.open;
        }
        score += offenseScore(maxOwnRun, ownOpen) * atkMul;
        score += defenseScore(maxFoeRun, foeOpen) * defMul;
        if (score > bestScore) { bestScore = score; best = [{ r: r, c: c }]; }
        else if (score === bestScore) best.push({ r: r, c: c });
      }
    }
    var pick = best[Math.floor(Math.random() * best.length)];
    return { move: pick, score: bestScore, maxOwnRun: maxOwnRun, maxFoeRun: maxFoeRun, ownOpen: ownOpen, foeOpen: foeOpen };
  }

  // 统计某空位在某方向上的连子长度 + 末端是否开放
  function runCount(r, c, dr, dc, color) {
    var run = 0, open = false;
    for (var i = 1; i <= 4; i++) {
      var nr = r + dr * i, nc = c + dc * i;
      if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) break;
      if (board[nr][nc] === color) run++;
      else if (board[nr][nc] === EMPTY) { open = true; break; }
      else break;
    }
    for (var j = 1; j <= 4; j++) {
      var nr2 = r - dr * j, nc2 = c - dc * j;
      if (nr2 < 0 || nr2 >= SIZE || nc2 < 0 || nc2 >= SIZE) break;
      if (board[nr2][nc2] === color) run++;
      else if (board[nr2][nc2] === EMPTY) { open = true; break; }
      else break;
    }
    return { run: run, open: open };
  }

  function offenseScore(run, open) {
    if (run <= 0) return 5;
    if (run === 1) return 10;
    if (run === 2) return open ? 25 : 50;
    if (run === 3) return open ? 55 : 100;
    return 10000;
  }
  function defenseScore(run, open) {
    if (run <= 0) return 0;
    if (run === 1) return 10;
    if (run === 2) return open ? 30 : 40;
    if (run === 3) return open ? 60 : 110;
    return 10100;
  }

  // 本地 AI 带"思考"动画 + 合成推理文字
  function localAIThink(color, diff) {
    var res = localAIMove(color, diff);
    // 合成一段推理说明
    var reason = "本地评分引擎扫描全盘空位，在 (" + res.move.r + "," + res.move.c +
      ") 得到最高分 " + res.score + "。";
    if (res.maxFoeRun >= 3) reason += " 检测到对方形成" + (res.foeOpen ? "活三" : "冲四") +
      "威胁，优先封堵。";
    else if (res.maxOwnRun >= 3) reason += " 己方已有三连，此手可延伸为活四。";
    else if (res.maxFoeRun >= 2) reason += " 对方有两子连线，提前压制。";
    else reason += " 当前均势，选择发展潜力最大的点。";

    if (mode === "challenge") {
      // 残局模式不展示面板，直接延迟落子
      setTimeout(function () { doAIMove(res.move.r, res.move.c, null); }, 500);
      return;
    }
    streamText(reason, function () {
      setTimeout(function () { doAIMove(res.move.r, res.move.c, reason); }, 250);
    });
  }

  // 把文字逐字流式显示
  function streamText(text, done) {
    var el = $("reasoningText");
    var i = 0;
    if (!el) { done(); return; }
    $("reasoningBox").setAttribute("open", "");
    var t = setInterval(function () {
      i = Math.min(text.length, i + 3);
      el.textContent = text.slice(0, i);
      el.scrollTop = el.scrollHeight;
      if (i >= text.length) { clearInterval(t); done(); }
    }, 18);
  }

  /* ===== 真实 Hy3 调用 ===== */
  function callHy3(color, diff) {
    var oppName = color === WHITE ? "黑(●)" : "白(○)";
    var myName = color === WHITE ? "白(○)" : "黑(●)";
    var systemPrompt =
      "你是五子棋 AI，执" + myName + "，对手执" + oppName + "。你刚轮到你落子。" +
      "分析棋盘，选择最佳落子。规则：15×15，五子连珠获胜。" +
      "必须输出严格 JSON：{\"row\":0-14,\"col\":0-14,\"reasoning\":\"中文思考过程\"}。" +
      "只输出 JSON，不要其他文字。row/col 必须是空位。" +
      "优先级：封堵对方活四/冲四 > 自己连五 > 做活四 > 做活三 > 封堵对方活三。" +
      "难度提示：" + (diff === "easy" ? "偏保守防守" : diff === "hard" ? "偏积极进攻" : "攻守均衡") + "。";

    var userPrompt =
      "当前棋盘（15×15，0=空 1=白 2=黑）：\n" + boardToStr() +
      "\n\n落子历史（最新在后）：\n" + historyToStr() +
      "\n\n请输出你的落子 JSON。";

    var messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];
    var base = (settings.baseUrl || "").replace(/\/+$/, "");
    var url = base + "/chat/completions";
    var body = { model: settings.model, messages: messages, stream: true, temperature: 0.5, max_tokens: 600 };

    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + settings.apiKey },
      body: JSON.stringify(body),
    })
    .then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error("API " + res.status + ": " + t.slice(0, 160)); });
      return res.body.getReader();
    })
    .then(function (reader) {
      var dec = new TextDecoder(), buf = "", content = "", reasoning = "";
      function step() {
        reader.read().then(function (r) {
          if (r.done) { onHy3Done(content, reasoning); return; }
          buf += dec.decode(r.value, { stream: true });
          var lines = buf.split("\n"); buf = lines.pop();
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line || line.indexOf("data: ") !== 0) continue;
            var data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              var j = JSON.parse(data);
              var d = (j.choices && j.choices[0] && j.choices[0].delta) || {};
              if (d.reasoning_content) {
                reasoning += d.reasoning_content;
                $("reasoningText").textContent = reasoning;
                $("reasoningText").scrollTop = $("reasoningText").scrollHeight;
                $("reasoningBox").setAttribute("open", "");
              }
              if (d.content) content += d.content;
            } catch (e) {}
          }
          step();
        }).catch(function (err) { onHy3Error(err.message); });
      }
      step();
    })
    .catch(function (err) { onHy3Error(err.message); });
  }

  function onHy3Done(content, reasoning) {
    var mv = parseMove(content);
    if (!mv) { onHy3Error("无法解析落子：" + content.slice(0, 80)); return; }
    doAIMove(mv.row, mv.col, reasoning || "");
  }
  function onHy3Error(msg) {
    aiThinking = false;
    idleThinkPanel("Hy3 调用出错 · 已退回本地 AI（设置里可清空 API Key 重试）");
    updateUI();
    alert("Hy3 调用出错：" + msg + "\n（可改用本地 AI：设置里清空 API Key）");
  }

  function parseMove(text) {
    var s = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    try {
      var o = JSON.parse(s);
      if (typeof o.row === "number" && typeof o.col === "number") return { row: o.row, col: o.col };
    } catch (e) {}
    var m = s.match(/row["']?\s*[:=]\s*(\d+)/i), n = s.match(/col["']?\s*[:=]\s*(\d+)/i);
    if (m && n) return { row: +m[1], col: +n[1] };
    return null;
  }

  function boardToStr() {
    var rows = [];
    for (var r = 0; r < SIZE; r++) rows.push(board[r].join(""));
    return rows.join("\n");
  }
  function historyToStr() {
    return history.map(function (m, i) {
      return (i + 1) + ". " + (m.color === BLACK ? "黑" : "白") + "(" + m.r + "," + m.c + ")";
    }).join("\n");
  }

  /* ===== AI 落子后处理 ===== */
  function doAIMove(r, c, reason) {
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE || board[r][c] !== EMPTY) {
      // 落子非法，退回本地 AI 兜底
      var fb = localAIMove(aiColor, difficulty);
      r = fb.move.r; c = fb.move.c;
    }
    placePiece(r, c, aiColor);

    if (checkWin(r, c)) { endGame(aiColor, reason); return; }
    if (isDead()) { endGame(0); return; }

    turn = (turn === BLACK) ? WHITE : BLACK;
    aiThinking = false;
    updateUI();
  }

  /* ===== 结束 ===== */
  function endGame(winner, reason, challengeFail) {
    gameOver = true;
    aiThinking = false;
    if (timerInterval) clearInterval(timerInterval);
    if (thinkTimerInterval) clearInterval(thinkTimerInterval);
    var realWin = (winner === WHITE || winner === BLACK) && !challengeFail;
    if (realWin) playWin();
    updateUI();
    saveRecord(winner, challengeFail);

    var title = $("resultTitle"), desc = $("resultDesc");
    var rb = $("resultReasoning");
    rb.classList.add("hidden");

    if (challengeFail) {
      title.textContent = "❌ 挑战失败";
      desc.textContent = "步数用尽仍未连成五子，再试一次吧。";
    } else if (winner === 0) {
      title.textContent = "🤝 平局";
      desc.textContent = "棋盘已满，势均力敌。";
    } else if (winner === aiColor) {
      title.textContent = "Hy3 获胜";
      desc.textContent = "Hy3 通过推理找到了制胜一手。";
      if (reason) { rb.classList.remove("hidden"); rb.querySelector("pre").textContent = reason; }
    } else {
      var youName = (mode === "person") ? "玩家" + (winner === BLACK ? "一(黑)" : "二(白)") : "你";
      title.textContent = "🎉 " + youName + "获胜！";
      desc.textContent = (mode === "challenge") ? "残局破解成功！" : "恭喜击败 Hy3。";
    }

    setTimeout(function () { $("resultModal").classList.remove("hidden"); }, 500);
  }

  /* ===== 悔棋 ===== */
  function undo() {
    if (history.length === 0 || aiThinking || gameOver) return;
    var steps = (mode === "bot") ? 2 : 1;
    if (history.length < steps) steps = history.length;
    for (var i = 0; i < steps; i++) {
      var m = history.pop();
      board[m.r][m.c] = EMPTY;
      if (mode === "challenge" && m.color === WHITE) movesLeft++;
    }
    turn = (turn === BLACK) ? WHITE : BLACK;
    if (mode === "bot" && history.length > 0 && turn === aiColor) turn = (turn === BLACK) ? WHITE : BLACK;
    renderBoard();
    updateUI();
    updateChallengeInfo();
  }

  /* ===== 残局 ===== */
  function loadChallenge(idx) {
    var ch = window.CHALLENGES[idx];
    challengeIdx = idx;
    initBoard();
    ch.pieces.forEach(function (p) { board[p[0]][p[1]] = p[2]; });
    // 记录初始棋子进 history（不计入玩家步数）
    ch.pieces.forEach(function (p) { history.push({ r: p[0], c: p[1], color: p[2] }); });
    movesLeft = ch.maxMoves;
    aiColor = BLACK;       // AI 执黑拦截
    turn = WHITE;          // 玩家执白先手
    mode = "challenge";
    $("challengeInfo").classList.remove("hidden");
    idleThinkPanel("Hy3 自动拦截中 · 思考过程将显示在此");
    $("chName").textContent = "第 " + (idx + 1) + " 关 · " + ch.name;
    $("chDesc").textContent = ch.description;
    showPoem();
    updateChallengeInfo();
    renderBoard();
    updateUI();
  }
  function updateChallengeInfo() {
    if (mode !== "challenge") return;
    $("chMovesLeft").textContent = movesLeft;
  }

  /* ===== 记录 ===== */
  function loadRecords() {
    try { var a = JSON.parse(localStorage.getItem(LS_RECORDS)); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function saveRecord(winner, fail) {
    var recs = loadRecords();
    var modeName = mode === "person" ? "双人对战" : mode === "bot" ? "人机对战" : "残局挑战";
    var result;
    if (fail) result = "挑战失败";
    else if (winner === 0) result = "平局";
    else if (winner === aiColor) result = "负";
    else result = "胜";
    recs.unshift({
      id: Date.now() + "_" + Math.floor(Math.random() * 1000),
      mode: modeName,
      result: result,
      diff: difficulty,
      moves: history.length,
      time: Math.floor((Date.now() - timerStart) / 1000),
      ch: mode === "challenge" ? (challengeIdx + 1) : null,
      at: new Date().toLocaleString("zh-CN"),
    });
    if (recs.length > 50) recs = recs.slice(0, 50);
    localStorage.setItem(LS_RECORDS, JSON.stringify(recs));
  }
  function showRecords() {
    var list = $("recordsList");
    var recs = loadRecords();
    if (!recs.length) { list.innerHTML = '<p class="hint">还没有对弈记录。</p>'; }
    else {
      list.innerHTML = "";
      recs.forEach(function (r) {
        var div = document.createElement("div");
        div.className = "rec-item";
        var win = r.result === "胜";
        div.innerHTML =
          '<span class="rec-badge ' + (win ? "w" : r.result === "负" ? "l" : "d") + '">' + r.result + '</span>' +
          '<span class="rec-mode">' + r.mode + (r.ch ? " · 第" + r.ch + "关" : "") + '</span>' +
          '<span class="rec-sub">' + (r.diff ? r.diff + " · " : "") + r.moves + '手 · ' + r.time + 's</span>' +
          '<span class="rec-time">' + r.at + '</span>' +
          '<button class="rec-del" data-id="' + r.id + '" title="删除">×</button>';
        list.appendChild(div);
      });
      list.querySelectorAll(".rec-del").forEach(function (btn) {
        btn.addEventListener("click", function () { deleteRecord(btn.dataset.id); });
      });
    }
    $("recordsModal").classList.remove("hidden");
  }
  function deleteRecord(id) {
    var recs = loadRecords().filter(function (r) { return r.id !== id; });
    localStorage.setItem(LS_RECORDS, JSON.stringify(recs));
    showRecords();
  }

  /* ===== 界面切换 ===== */
  function showMenu() {
    $("menu").classList.remove("hidden");
    $("game").classList.add("hidden");
    $("resultModal").classList.add("hidden");
  }
  function showGame() {
    $("menu").classList.add("hidden");
    $("game").classList.remove("hidden");
  }

  function startMode(m, playerColor) {
    mode = m;
    initBoard();
    if (m === "person") {
      aiColor = -1; turn = BLACK;
      $("gameTitle").textContent = "双人对战";
      $("challengeInfo").classList.add("hidden");
      idleThinkPanel("本地双人对战 · 无 AI 思考过程");
    } else if (m === "bot") {
      // playerColor 决定谁执黑先手；AI 执另一色
      aiColor = (playerColor === BLACK) ? WHITE : BLACK;
      turn = BLACK;     // 黑棋先行
      $("gameTitle").textContent = "人机对战 · " + diffName();
      $("challengeInfo").classList.add("hidden");
    }
    showGame();
    showPoem();
    renderBoard();
    updateUI();
    if (isAITurn()) aiTurn();   // AI 执黑先手时自动落首子
  }
  function diffName() { return difficulty === "easy" ? "初级" : difficulty === "hard" ? "高级" : "中级"; }

  /* ===== 事件绑定 ===== */
  function bindUI() {
    // 菜单模式按钮
    document.querySelectorAll(".mode-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        var m = b.dataset.mode;
        if (m === "challenge") {
          $("challengeModal").classList.remove("hidden");
        } else if (m === "bot") {
          $("botSetupModal").classList.remove("hidden");
        } else {
          startMode(m);
        }
      });
    });
    // 难度段控
    document.querySelectorAll("#diffSeg button").forEach(function (b) {
      b.addEventListener("click", function () {
        document.querySelectorAll("#diffSeg button").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        difficulty = b.dataset.diff;
        var hint = {
          person: "双人对战：同屏两人轮流落子，黑棋先行",
          bot: "人机对战：你执黑先手，Hy3 执白应战",
          challenge: "残局挑战：你执白，限定步数内连成五子",
        };
        $("modeHint").innerHTML = hint[mode] || "";
      });
    });

    // 残局选择
    var grid = $("challengeGrid");
    window.CHALLENGES.forEach(function (ch, i) {
      var card = document.createElement("button");
      card.className = "ch-card";
      card.innerHTML = '<b>第 ' + (i + 1) + ' 关</b><span>' + ch.name + '</span><small>' + ch.maxMoves + ' 步</small>';
      card.addEventListener("click", function () {
        $("challengeModal").classList.add("hidden");
        loadChallenge(i);
        showGame();
      });
      grid.appendChild(card);
    });
    $("closeChallenge").addEventListener("click", function () { $("challengeModal").classList.add("hidden"); });

    // 人机设置（难度 + 先后手 → 选中高亮，点确认才进游戏）
    let botFirstPick = BLACK; // 默认执黑
    const SEAL = "#3f6b4f";
    $("pickBlack").addEventListener("click", function () {
      botFirstPick = BLACK;
      $("pickBlack").style.borderColor = SEAL;
      $("pickBlack").style.background = "rgba(63,107,79,.08)";
      $("pickWhite").style.borderColor = "";
      $("pickWhite").style.background = "";
    });
    $("pickWhite").addEventListener("click", function () {
      botFirstPick = WHITE;
      $("pickWhite").style.borderColor = SEAL;
      $("pickWhite").style.background = "rgba(63,107,79,.08)";
      $("pickBlack").style.borderColor = "";
      $("pickBlack").style.background = "";
    });
    // 默认高亮执黑
    $("pickBlack").style.borderColor = SEAL;
    $("pickBlack").style.background = "rgba(63,107,79,.08)";
    $("confirmBotStart").addEventListener("click", function () {
      $("botSetupModal").classList.add("hidden");
      startMode("bot", botFirstPick);
    });
    $("closeBotSetup").addEventListener("click", function () { $("botSetupModal").classList.add("hidden"); });

    // 记录
    $("recordsBtn").addEventListener("click", showRecords);
    $("closeRecords").addEventListener("click", function () { $("recordsModal").classList.add("hidden"); });
    $("clearRecords").addEventListener("click", function () {
      if (confirm("确定清空所有对弈记录？")) { localStorage.removeItem(LS_RECORDS); showRecords(); }
    });

    // 设置
    $("settingsBtnMenu").addEventListener("click", openSettings);
    $("closeSettings").addEventListener("click", function () { $("settingsModal").classList.add("hidden"); });
    $("saveSettings").addEventListener("click", function () {
      settings.provider = $("provider").value;
      settings.baseUrl = $("baseUrl").value.trim();
      settings.model = $("model").value.trim();
      settings.apiKey = $("apiKey").value.trim();
      saveSettings(); applyDefaults();
      $("settingsModal").classList.add("hidden");
      alert(settings.apiKey ? "已保存，将使用真实 Hy3 对弈。" : "已保存，当前为本地 AI（无需联网）。");
    });
    $("provider").addEventListener("change", function () {
      var p = PROVIDERS[this.value] || PROVIDERS.custom;
      if (p.base) $("baseUrl").value = p.base;
      if (p.model) $("model").value = p.model;
    });

    // 游戏内按钮
    $("backBtn").addEventListener("click", function () {
      if (timerInterval) clearInterval(timerInterval);
      showMenu();
    });
    $("undoBtn").addEventListener("click", undo);
    $("restartBtn").addEventListener("click", function () {
      if (mode === "challenge") loadChallenge(challengeIdx);
      else startMode(mode);
    });
    $("surrenderBtn").addEventListener("click", function () {
      if (gameOver) return;
      endGame(aiColor, null);
    });
    $("chHintBtn").addEventListener("click", function () {
      var ch = window.CHALLENGES[challengeIdx];
      alert("提示：" + ch.hint);
    });

    // 结果弹窗
    $("playAgainBtn").addEventListener("click", function () {
      if (mode === "challenge") loadChallenge(challengeIdx);
      else startMode(mode);
    });
    $("backMenuBtn").addEventListener("click", showMenu);

    // 遮罩点击关闭
    document.querySelectorAll(".modal").forEach(function (m) {
      m.addEventListener("click", function (e) { if (e.target === m) m.classList.add("hidden"); });
    });

    // 键盘快捷键：Esc 返回菜单 / R 重开 / Ctrl+Z 悔棋
    document.addEventListener("keydown", function (e) {
      if (hidden("game")) return;
      if (e.key === "Escape") {
        if (timerInterval) clearInterval(timerInterval);
        showMenu();
      } else if (e.key === "r" || e.key === "R") {
        if (gameOver) return;
        if (mode === "challenge") loadChallenge(challengeIdx);
        else startMode(mode);
      } else if ((e.key === "z" || e.key === "Z") && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        undo();
      }
    });
  }

  function openSettings() {
    $("provider").value = settings.provider || "siliconflow";
    applyDefaults();
    $("baseUrl").value = settings.baseUrl || "";
    $("model").value = settings.model || "";
    $("apiKey").value = settings.apiKey || "";
    $("settingsModal").classList.remove("hidden");
  }

  /* ===== 启动 ===== */
  document.addEventListener("DOMContentLoaded", function () {
    bindUI();
    setupBoard();
    showMenu();
  });

})();
