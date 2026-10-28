/* WORD FLOW Ver.2 — 화면 · 이벤트 처리
 * 모든 학습 상태는 이 페이지의 JS 메모리에만 존재한다(localStorage/쿠키/서버 저장 없음).
 */
(function () {
  'use strict';

  var E = window.WordFlowEngine;
  var DATA_DIR = 'data/';               // 상대 경로: 하위 경로에 배포해도 동작
  var MANIFEST_FILE = 'manifest.json';  // data 폴더 안의 데이터셋 목록(파일명 배열)
  var DELAY_CORRECT_MS = 800;
  var DELAY_WRONG_MS = 1800;            // 정답 뜻을 읽을 시간을 조금 더 준다

  var state = {
    datasets: [],         // [{ file, name }]  data 폴더의 데이터셋 목록
    cache: new Map(),     // file → { engine, total }  (메모리 캐시, 저장하지 않음)
    selectedFile: null,
    loadToken: 0,         // 늦게 도착한 응답을 무시하기 위한 토큰
    direction: E.DIR_EN2KO,
    engine: null,
    totalWords: 0,
    session: null,
    stopwatch: null,
    question: null,
    locked: false,       // 한 문제에 대한 중복 입력 차단
    active: false,       // 세션 진행 중 여부
    advanceTimer: null,
    tickTimer: null
  };

  function $(id) { return document.getElementById(id); }

  var el = {
    screens: { home: $('screen-home'), quiz: $('screen-quiz'), result: $('screen-result') },
    startBtn: $('start-btn'), wordCount: $('word-count'),
    homeOptions: $('home-options'), datasetSelect: $('dataset-select'),
    dirSwitch: $('direction-switch'), dirLeft: $('dir-left'), dirRight: $('dir-right'),
    meanings: $('quiz-meanings'),
    loadError: $('load-error'), loadErrorMsg: $('load-error-message'), retryBtn: $('retry-btn'),
    attempt: $('attempt-count'), clock: $('clock'), exitBtn: $('exit-btn'),
    word: $('quiz-word'), pos: $('pos-label'), feedback: $('feedback'),
    choices: Array.prototype.slice.call(document.querySelectorAll('.choice')),
    resultTitle: $('result-title'), headline: $('result-headline'), notice: $('result-notice'),
    sumCorrect: $('sum-correct'), sumWrong: $('sum-wrong'), sumAcc: $('sum-accuracy'), sumTime: $('sum-time'),
    reviewTitle: $('review-title'), reviewList: $('review-list'), homeBtn: $('home-btn')
  };

  /* ---------------- 화면 전환 ---------------- */

  function showScreen(name) {
    Object.keys(el.screens).forEach(function (key) {
      el.screens[key].hidden = key !== name;
    });
    window.scrollTo(0, 0);
    var focusTarget = name === 'home' ? $('home-title') : name === 'result' ? el.resultTitle : null;
    if (focusTarget) focusTarget.focus({ preventScroll: true });
  }

  /* ---------------- 데이터셋 목록 · 로딩 ---------------- */

  function datasetName(file) { return file.replace(/\.json$/i, ''); }

  function isSafeFileName(f) {
    return typeof f === 'string' && f.trim() !== '' && !/[\\/]/.test(f) && f.charAt(0) !== '.';
  }

  function noManifestError() {
    return new E.DataError('data 폴더의 데이터셋 목록을 찾을 수 없습니다.\n' +
      'data/manifest.json 파일에 ["이름1.json", "이름2.json"] 형태로 파일명을 적어 주세요.');
  }

  function parseManifest(text) {
    var json;
    try { json = JSON.parse(text); }
    catch (e) { throw new E.DataError('data/manifest.json의 형식이 올바르지 않습니다. (JSON 문법 오류)\n' + e.message); }
    var list = Array.isArray(json) ? json : (json && Array.isArray(json.files) ? json.files : null);
    if (!list) throw new E.DataError('data/manifest.json은 파일명 배열이어야 합니다. 예: ["이름1.json", "이름2.json"]');
    var seen = {};
    var files = list.filter(function (f) {
      if (!isSafeFileName(f) || seen[f]) return false;
      seen[f] = true;
      return true;
    });
    if (files.length === 0) throw new E.DataError('data/manifest.json에 사용할 수 있는 파일명이 없습니다.');
    return files.map(function (f) { return { file: f, name: datasetName(f) }; });
  }

  /** manifest.json 이 없을 때만 쓰는 대체 수단: 서버가 폴더 목록(디렉터리 리스팅)을 보여주면 .json 링크를 읽는다. */
  function listFromDirectory() {
    return fetch(DATA_DIR, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw noManifestError();
      return res.text();
    }).then(function (html) {
      var found = [], seen = {}, re = /href\s*=\s*["']([^"'?#]+?\.json)["']/gi, m;
      while ((m = re.exec(html)) !== null) {
        var name;
        try { name = decodeURIComponent(m[1]); } catch (e) { name = m[1]; }
        name = name.split('/').pop();
        if (!isSafeFileName(name) || name.toLowerCase() === MANIFEST_FILE || seen[name]) continue;
        seen[name] = true;
        found.push(name);
      }
      if (found.length === 0) throw noManifestError();
      found.sort(function (x, y) { return x.localeCompare(y, 'ko', { numeric: true }); });
      return found.map(function (f) { return { file: f, name: datasetName(f) }; });
    });
  }

  function fetchDatasetList() {
    return fetch(DATA_DIR + MANIFEST_FILE, { cache: 'no-cache' }).then(
      function (res) { return res.ok ? res.text().then(parseManifest) : listFromDirectory(); },
      function () { return listFromDirectory(); }
    );
  }

  function networkErrorMessage(what) {
    return what + '을(를) 읽는 중 문제가 발생했습니다.\n' + (location.protocol === 'file:'
      ? '파일을 직접 열면(file://) 브라우저가 읽기를 막습니다. 로컬 서버(예: python -m http.server)로 실행해 주세요.'
      : '네트워크 연결과 파일 위치를 확인해 주세요.');
  }

  /** keepOptions: 데이터셋 하나만 실패한 경우 드롭다운은 그대로 두어 다른 데이터셋을 고를 수 있게 한다. */
  function setLoadError(message, keepOptions) {
    el.loadErrorMsg.textContent = message;
    el.loadError.hidden = false;
    el.startBtn.hidden = true;
    el.startBtn.disabled = true;
    el.wordCount.textContent = '';
    state.engine = null;
    if (!keepOptions) el.homeOptions.hidden = true;
  }

  function populateSelect() {
    el.datasetSelect.textContent = '';
    state.datasets.forEach(function (d) {
      var opt = document.createElement('option');
      opt.value = d.file;
      opt.textContent = d.name;      // 확장자를 뺀 이름
      el.datasetSelect.appendChild(opt);
    });
    el.datasetSelect.disabled = false;
  }

  function applyDataset(entry) {
    state.engine = entry.engine;
    state.totalWords = entry.total;
    el.wordCount.textContent = entry.total.toLocaleString('ko-KR') + ' words';
    el.startBtn.disabled = false;
  }

  function loadDataset(file) {
    var token = ++state.loadToken;
    state.selectedFile = file;
    state.engine = null;
    el.loadError.hidden = true;
    el.startBtn.hidden = false;
    el.startBtn.disabled = true;

    if (state.cache.has(file)) { applyDataset(state.cache.get(file)); return; }
    el.wordCount.textContent = '단어를 불러오는 중…';

    var label = '「' + datasetName(file) + '」';
    fetch(DATA_DIR + encodeURIComponent(file), { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new E.DataError(label + ' 파일을 불러오지 못했습니다. (HTTP ' + res.status + ')\ndata 폴더에 파일이 있는지 확인해 주세요.');
        return res.text();
      })
      .then(function (text) {
        var json;
        try { json = JSON.parse(text); }
        catch (e) { throw new E.DataError(label + ' 파일의 형식이 올바르지 않습니다. (JSON 문법 오류)\n' + e.message); }
        var parsed;
        try { parsed = E.normalizeRecords(json); }
        catch (e) { if (e instanceof E.DataError) e = new E.DataError(label + ' ' + e.userMessage); throw e; }
        var engine;
        try { engine = new E.QuizEngine(parsed.records); }
        catch (e) { if (e instanceof E.DataError) e = new E.DataError(label + ' ' + e.userMessage); throw e; }
        if (parsed.skipped > 0 && window.console) console.warn(label + ': word가 없거나 잘못된 항목 ' + parsed.skipped + '개를 건너뛰었습니다.');
        var entry = { engine: engine, total: parsed.records.length };
        state.cache.set(file, entry);
        if (token === state.loadToken) applyDataset(entry);   // 그 사이 다른 데이터셋을 골랐다면 무시
      })
      .catch(function (err) {
        if (token !== state.loadToken) return;
        setLoadError(err instanceof E.DataError ? err.userMessage : networkErrorMessage(label + ' 파일'), true);
      });
  }

  function init() {
    state.datasets = [];
    el.homeOptions.hidden = false;
    el.datasetSelect.disabled = true;
    el.loadError.hidden = true;
    el.startBtn.hidden = false;
    el.startBtn.disabled = true;
    el.wordCount.textContent = '단어장을 불러오는 중…';

    fetchDatasetList()
      .then(function (list) {
        state.datasets = list;
        populateSelect();
        loadDataset(list[0].file);
      })
      .catch(function (err) {
        setLoadError(err instanceof E.DataError ? err.userMessage : networkErrorMessage('data 폴더'), false);
      });
  }

  function retryLoad() {
    if (state.datasets.length === 0) init();
    else loadDataset(el.datasetSelect.value || state.selectedFile);
  }

  /* ---------------- 출제 방향 토글 ---------------- */

  function setDirection(dir) {
    state.direction = dir;
    var ko2en = dir === E.DIR_KO2EN;
    el.dirSwitch.setAttribute('aria-checked', ko2en ? 'true' : 'false');
    el.dirSwitch.setAttribute('aria-label', ko2en
      ? '출제 방향: 한국어 뜻을 보고 영어 단어 고르기'
      : '출제 방향: 영어 단어를 보고 한국어 뜻 고르기');
    el.dirLeft.classList.toggle('is-on', !ko2en);
    el.dirRight.classList.toggle('is-on', ko2en);
  }

  /* ---------------- 세션 ---------------- */

  function updateClock() {
    if (!state.stopwatch) return;
    var text = E.formatClock(state.stopwatch.elapsedMs());
    if (el.clock.textContent !== text) el.clock.textContent = text;
  }

  function clearTimers() {
    if (state.advanceTimer !== null) { clearTimeout(state.advanceTimer); state.advanceTimer = null; }
    if (state.tickTimer !== null) { clearInterval(state.tickTimer); state.tickTimer = null; }
  }

  function startSession() {
    if (!state.engine || state.active) return;
    clearTimers();
    state.session = new E.QuizSession();
    state.stopwatch = new E.Stopwatch();
    state.stopwatch.start();
    state.active = true;
    state.locked = false;
    state.question = null;
    el.attempt.textContent = '0';
    el.notice.hidden = true;
    updateClock();
    state.tickTimer = setInterval(updateClock, 250);
    showScreen('quiz');
    renderQuestion();
  }

  function endSession(noticeMessage) {
    if (!state.active) return;
    state.active = false;       // 이후 들어오는 선택/타이머는 모두 무시된다
    state.locked = true;
    clearTimers();
    state.stopwatch.stop();
    renderResult(noticeMessage);
    showScreen('result');
  }

  function renderQuestion() {
    if (!state.active) return;
    var q;
    try {
      q = state.engine.nextQuestion(state.direction);
    } catch (err) {
      endSession(err instanceof E.DataError ? err.userMessage : '문제를 만드는 중 오류가 발생해 세션을 종료했어요.');
      return;
    }
    state.question = q;
    state.locked = false;

    if (q.direction === E.DIR_KO2EN) {
      // 한 → 영: 뜻이 여러 개면 모두 보여준다
      el.word.hidden = true;
      el.meanings.textContent = '';
      q.promptMeanings.forEach(function (m) {
        var li = document.createElement('li');
        li.textContent = m;
        el.meanings.appendChild(li);
      });
      el.meanings.classList.toggle('is-multi', q.promptMeanings.length > 1);
      el.meanings.hidden = false;
    } else {
      el.meanings.hidden = true;
      el.word.hidden = false;
      el.word.textContent = q.promptWord;
    }
    el.pos.textContent = E.toList(q.record.raw.pos).join(', ');
    el.feedback.className = 'feedback';
    el.feedback.textContent = '';

    el.choices.forEach(function (btn, i) {
      var label = btn.querySelector('.choice-text');
      label.textContent = q.choices[i];
      label.lang = q.direction === E.DIR_KO2EN ? 'en' : 'ko';
      btn.removeAttribute('data-state');
      btn.removeAttribute('aria-disabled');
    });
  }

  function onChoose(index) {
    if (!state.active || state.locked || !state.question) return;
    state.locked = true;                       // 즉시 잠가서 중복 집계를 막는다

    var q = state.question;
    var isCorrect = state.session.record(q, index);
    el.attempt.textContent = String(state.session.attempted);

    el.choices.forEach(function (btn) { btn.setAttribute('aria-disabled', 'true'); });
    if (isCorrect) {
      el.choices[index].setAttribute('data-state', 'correct');
    } else {
      el.choices[index].setAttribute('data-state', 'wrong');
      el.choices[q.correctIndex].setAttribute('data-state', 'correct');
    }

    el.feedback.textContent = '';
    var main = document.createElement('span');
    main.className = 'fb-main';
    el.feedback.appendChild(main);
    if (isCorrect) {
      el.feedback.className = 'feedback is-correct';
      main.textContent = '✓ 정답입니다';
    } else {
      el.feedback.className = 'feedback is-wrong';
      main.textContent = '✗ 오답입니다';
      var sub = document.createElement('span');
      sub.className = 'fb-sub';
      sub.textContent = '정답: ' + q.correctText;
      el.feedback.appendChild(sub);
    }

    state.advanceTimer = setTimeout(function () {
      state.advanceTimer = null;
      renderQuestion();
    }, isCorrect ? DELAY_CORRECT_MS : DELAY_WRONG_MS);
  }

  /* ---------------- 결과 화면 ---------------- */

  var FIELD_LABELS = [
    ['pos', '품사', false],
    ['pronunciation', '발음', false],
    ['meaning', '뜻', false],
    ['example', 'Example', true],
    ['example_translation', '예문 해석', true]
  ];

  function isEmptyValue(v) {
    if (v === null || v === undefined) return true;
    if (typeof v === 'string') return v.trim() === '';
    if (Array.isArray(v)) return v.length === 0 || v.every(isEmptyValue);
    return false;
  }

  function valueToText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return ''; } }
    return String(v);
  }

  /** 원본 값을 정보 손실 없이, textContent 로만 채운다. */
  function fillValue(dd, key, value) {
    if (isEmptyValue(value)) { dd.textContent = '—'; dd.className = 'is-empty'; return; }
    if (Array.isArray(value)) {
      if (key === 'pos') { dd.textContent = value.map(valueToText).join(', '); return; }
      var ul = document.createElement('ul');
      value.forEach(function (item) {
        if (isEmptyValue(item)) return;
        var li = document.createElement('li');
        li.textContent = valueToText(item);
        ul.appendChild(li);
      });
      dd.appendChild(ul);
      return;
    }
    dd.textContent = valueToText(value);
  }

  function buildCard(entry) {
    var raw = entry.record.raw;
    var card = document.createElement('article');
    card.className = 'card';

    var head = document.createElement('div');
    head.className = 'card-head';
    var h = document.createElement('h4');
    h.className = 'card-word';
    h.textContent = valueToText(raw.word) || entry.record.word;
    var cnt = document.createElement('span');
    cnt.className = 'card-count';
    cnt.textContent = '오답 ' + entry.count + '회';
    head.appendChild(h);
    head.appendChild(cnt);
    card.appendChild(head);

    var dl = document.createElement('dl');
    dl.className = 'card-fields';
    FIELD_LABELS.forEach(function (f) {
      var wrap = document.createElement('div');
      wrap.className = 'field' + (f[2] ? ' field-wide' : '');
      var dt = document.createElement('dt');
      dt.textContent = f[1];
      var dd = document.createElement('dd');
      fillValue(dd, f[0], raw[f[0]]);
      wrap.appendChild(dt);
      wrap.appendChild(dd);
      dl.appendChild(wrap);
    });
    card.appendChild(dl);

    var meta = document.createElement('div');
    meta.className = 'card-meta';
    [['Level', raw.level], ['Group', raw.group]].forEach(function (pair) {
      var s = document.createElement('span');
      s.appendChild(document.createTextNode(pair[0]));
      var strong = document.createElement('strong');
      strong.textContent = isEmptyValue(pair[1]) ? '—' : (Array.isArray(pair[1]) ? pair[1].map(valueToText).join(', ') : valueToText(pair[1]));
      s.appendChild(strong);
      meta.appendChild(s);
    });
    card.appendChild(meta);

    return card;
  }

  function renderResult(noticeMessage) {
    var s = state.session;
    var elapsed = state.stopwatch.elapsedMs();
    var acc = s.accuracy();
    var entries = s.wrongEntries();

    el.headline.textContent = s.attempted === 0
      ? '이번에는 바로 종료했어요. 언제든 다시 시작해 보세요.'
      : s.attempted.toLocaleString('ko-KR') + '번 단어를 만났어요.';
    el.sumCorrect.textContent = String(s.correct);
    el.sumWrong.textContent = String(s.wrong);
    el.sumAcc.textContent = acc === null ? '–' : acc.toFixed(1) + '%';
    el.sumTime.textContent = E.formatKorean(elapsed);

    if (noticeMessage) { el.notice.textContent = noticeMessage; el.notice.hidden = false; }
    else { el.notice.hidden = true; }

    el.reviewList.textContent = '';
    if (entries.length === 0) {
      el.reviewTitle.textContent = '다시 만난 단어';
      var empty = document.createElement('p');
      empty.className = 'review-empty';
      empty.textContent = s.attempted === 0 ? '아직 만난 단어가 없어요.' : '이번에는 틀린 단어가 없어요. 잘하셨어요!';
      el.reviewList.appendChild(empty);
    } else {
      el.reviewTitle.textContent = '다시 만난 단어 · ' + entries.length + '개';
      entries.forEach(function (entry) { el.reviewList.appendChild(buildCard(entry)); });
    }
  }

  /* ---------------- 이벤트 ---------------- */

  el.startBtn.addEventListener('click', startSession);
  el.retryBtn.addEventListener('click', retryLoad);
  el.datasetSelect.addEventListener('change', function () { loadDataset(el.datasetSelect.value); });
  el.dirSwitch.addEventListener('click', function () {
    setDirection(state.direction === E.DIR_KO2EN ? E.DIR_EN2KO : E.DIR_KO2EN);
  });
  el.dirLeft.addEventListener('click', function () { setDirection(E.DIR_EN2KO); });
  el.dirRight.addEventListener('click', function () { setDirection(E.DIR_KO2EN); });
  el.exitBtn.addEventListener('click', function () { endSession(); });
  el.homeBtn.addEventListener('click', function () { showScreen('home'); });

  el.choices.forEach(function (btn) {
    btn.addEventListener('click', function () { onChoose(Number(btn.getAttribute('data-index'))); });
  });

  document.addEventListener('keydown', function (e) {
    if (!state.active || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    var n = parseInt(e.key, 10);
    if (n >= 1 && n <= 5) { e.preventDefault(); onChoose(n - 1); }
  });

  // 탭이 다시 보일 때 실제 경과 시각 기준으로 즉시 갱신
  document.addEventListener('visibilitychange', updateClock);

  setDirection(E.DIR_EN2KO);
  init();
})();
