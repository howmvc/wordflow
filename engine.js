/* WORD FLOW Ver.2 — 데이터 해석 · 문제 생성 · 세션 로직 (DOM 비의존)
 *
 * 이 파일은 화면(DOM)을 전혀 건드리지 않는다. 브라우저에서는 window.WordFlowEngine 으로,
 * Node 에서는 require() 로 사용할 수 있어 로직만 따로 테스트할 수 있다.
 */
(function (root) {
  'use strict';

  var NUM_CHOICES = 5;
  var NUM_DISTRACTORS = NUM_CHOICES - 1;
  var DIR_EN2KO = 'en2ko';   // 영어 → 한국어 뜻
  var DIR_KO2EN = 'ko2en';   // 한국어 뜻 → 영어

  /** 사용자에게 그대로 보여줄 수 있는 데이터 오류 */
  function DataError(message) {
    this.name = 'DataError';
    this.message = message;
    this.userMessage = message;
  }
  DataError.prototype = Object.create(Error.prototype);
  DataError.prototype.constructor = DataError;

  /* ------------------------------------------------------------------ */
  /* 값 해석 유틸                                                        */
  /* ------------------------------------------------------------------ */

  /** 화면 표시/비교용 문자열. null/undefined → '' (원본은 수정하지 않는다) */
  function toText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return '';
  }

  /** pos / meaning 처럼 문자열 또는 배열일 수 있는 값을 "문자열 목록"으로 해석한다. */
  function toList(v) {
    if (Array.isArray(v)) {
      return v.map(toText).filter(Boolean);
    }
    var t = toText(v);
    return t ? [t] : [];
  }

  /** 비교용 정규화: 공백 정리 + 유니코드 정규화 + 소문자 */
  function normKey(s) {
    return String(s).normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /* ------------------------------------------------------------------ */
  /* 랜덤 유틸 (rng 주입 가능)                                           */
  /* ------------------------------------------------------------------ */

  function randInt(n, rng) {
    return Math.floor(rng() * n);
  }

  function pick(arr, rng) {
    return arr[randInt(arr.length, rng)];
  }

  function shuffle(arr, rng) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = randInt(i + 1, rng);
      var t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  /* ------------------------------------------------------------------ */
  /* JSON 검증 · 정규화                                                  */
  /* ------------------------------------------------------------------ */

  /** 최상위가 배열이거나, 배열 하나를 담은 객체({ "words": [...] } 등)를 허용한다. */
  function extractArray(json) {
    if (Array.isArray(json)) return json;
    if (json && typeof json === 'object') {
      var keys = Object.keys(json).filter(function (k) { return Array.isArray(json[k]); });
      if (keys.length === 1) return json[keys[0]];
      var preferred = ['words', 'data', 'items', 'entries', 'list'];
      for (var i = 0; i < preferred.length; i++) {
        if (Array.isArray(json[preferred[i]])) return json[preferred[i]];
      }
    }
    throw new DataError('파일의 최상위 구조를 해석할 수 없습니다. 단어 객체의 배열이어야 합니다.');
  }

  /**
   * 원본 레코드를 보존한 채, 출제에 필요한 파생 정보만 덧붙인다.
   * raw 는 절대 수정하지 않으며, 결과 화면의 카드도 raw 를 그대로 사용한다.
   */
  function normalizeRecords(json) {
    var arr = extractArray(json);
    var records = [];
    var skipped = 0;
    arr.forEach(function (raw, index) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { skipped++; return; }
      var word = toText(raw.word);
      if (!word) { skipped++; return; }
      var posList = toList(raw.pos);
      var meaningList = toList(raw.meaning);
      var posKeys = [];
      posList.forEach(function (p) {
        var k = normKey(p);
        if (k && posKeys.indexOf(k) === -1) posKeys.push(k);
      });
      records.push({
        id: records.length,        // 레코드 고유 식별자(원본 배열 내 유효 레코드 순번)
        sourceIndex: index,
        raw: raw,
        word: word,
        posKeys: posKeys,
        meaningList: meaningList,
        eligible: posKeys.length > 0 && meaningList.length > 0
      });
    });
    if (records.length === 0) {
      throw new DataError('파일에서 유효한 단어를 찾지 못했습니다. 각 항목에 word 필드가 있는지 확인해 주세요.');
    }
    return { records: records, skipped: skipped };
  }

  /* ------------------------------------------------------------------ */
  /* 문제 생성                                                           */
  /* ------------------------------------------------------------------ */

  function QuizEngine(records, rng) {
    this.rng = rng || Math.random;
    this.records = records;
    this.eligible = records.filter(function (r) { return r.eligible; });
    if (this.eligible.length === 0) {
      throw new DataError('pos와 meaning이 모두 있는 단어가 없어 문제를 만들 수 없습니다.');
    }
    // 품사 키 → 레코드 목록 (오답 후보 검색용)
    this.posIndex = new Map();
    var self = this;
    this.eligible.forEach(function (r) {
      r.posKeys.forEach(function (k) {
        if (!self.posIndex.has(k)) self.posIndex.set(k, []);
        self.posIndex.get(k).push(r);
      });
    });
  }

  /**
   * 한 레코드에 대한 문제를 만든다. 5개 보기를 만들 수 없으면 null.
   * direction:
   *  - 'en2ko' : 영어 단어를 보여주고 한국어 뜻(하나)을 고른다
   *  - 'ko2en' : 단어의 한국어 뜻을 (여러 개면 모두) 보여주고 영어 단어를 고른다
   * 규칙(두 방향 공통):
   *  - 오답 후보 = 정답과 품사 항목을 하나라도 공유하는 다른 레코드
   *  - 후보의 뜻이 정답 레코드의 어떤 뜻과도 겹치면 후보에서 제외(정답이 둘로 해석되는 것 방지)
   *  - 표시되는 보기 문구는 서로 중복되지 않음
   *  - en2ko 에서 뜻이 여러 개면 보기 하나에는 항목 하나만 사용
   */
  QuizEngine.prototype.buildQuestion = function (answerRec, direction) {
    var rng = this.rng;
    var toEnglish = direction === DIR_KO2EN;

    var seen = new Set();
    var candidates = [];
    answerRec.posKeys.forEach(function (k) {
      (this.posIndex.get(k) || []).forEach(function (r) {
        if (r.id !== answerRec.id && !seen.has(r.id)) {
          seen.add(r.id);
          candidates.push(r);
        }
      });
    }, this);

    var forbidden = new Set(answerRec.meaningList.map(normKey));
    var answerText = toEnglish ? answerRec.word : pick(answerRec.meaningList, rng);
    var used = new Set([normKey(answerText)]);

    var distractors = [];
    var shuffled = shuffle(candidates, rng);
    for (var i = 0; i < shuffled.length && distractors.length < NUM_DISTRACTORS; i++) {
      var cand = shuffled[i];
      var overlaps = cand.meaningList.some(function (m) { return forbidden.has(normKey(m)); });
      if (overlaps) continue;
      var texts = toEnglish ? [cand.word] : cand.meaningList;
      var usable = texts.filter(function (t) { return !used.has(normKey(t)); });
      if (usable.length === 0) continue;
      var text = pick(usable, rng);
      used.add(normKey(text));
      distractors.push({ text: text, isCorrect: false });
    }
    if (distractors.length < NUM_DISTRACTORS) return null;

    var choices = shuffle(distractors.concat([{ text: answerText, isCorrect: true }]), rng);
    var correctIndex = -1;
    choices.forEach(function (c, i) { if (c.isCorrect) correctIndex = i; });

    return {
      record: answerRec,
      direction: toEnglish ? DIR_KO2EN : DIR_EN2KO,
      promptWord: toEnglish ? null : answerRec.word,                       // en2ko: 제시할 영어 단어
      promptMeanings: toEnglish ? answerRec.meaningList.slice() : null,    // ko2en: 제시할 뜻 전체
      choices: choices.map(function (c) { return c.text; }),
      correctIndex: correctIndex,
      correctText: answerText
    };
  };

  /**
   * 다음 문제. 문제 단어는 이전 출제와 무관하게 전체에서 독립적으로 균등 선택한다.
   * 선택한 단어로 보기를 만들 수 없을 때만 다시 뽑는다(안전하게 건너뜀).
   */
  QuizEngine.prototype.nextQuestion = function (direction) {
    direction = direction === DIR_KO2EN ? DIR_KO2EN : DIR_EN2KO;
    for (var t = 0; t < 200; t++) {
      var q = this.buildQuestion(pick(this.eligible, this.rng), direction);
      if (q) return q;
    }
    // 보기를 만들 수 있는 단어가 매우 드문 경우: 전수 탐색
    var order = shuffle(this.eligible, this.rng);
    for (var i = 0; i < order.length; i++) {
      var q2 = this.buildQuestion(order[i], direction);
      if (q2) return q2;
    }
    throw new DataError('같은 품사의 서로 다른 보기 5개를 만들 수 있는 단어가 없어 문제를 출제할 수 없습니다.');
  };

  /* ------------------------------------------------------------------ */
  /* 세션 상태                                                           */
  /* ------------------------------------------------------------------ */

  function QuizSession() {
    this.attempted = 0;
    this.correct = 0;
    this.wrong = 0;
    this.wrongMap = new Map(); // record.id → { record, count } (삽입 순서 = 최초 오답 순서)
  }

  QuizSession.prototype.record = function (question, selectedIndex) {
    var isCorrect = selectedIndex === question.correctIndex;
    this.attempted += 1;
    if (isCorrect) {
      this.correct += 1;
    } else {
      this.wrong += 1;
      var id = question.record.id;
      var entry = this.wrongMap.get(id);
      if (entry) entry.count += 1;
      else this.wrongMap.set(id, { record: question.record, count: 1 });
    }
    return isCorrect;
  };

  QuizSession.prototype.accuracy = function () {
    return this.attempted === 0 ? null : (this.correct / this.attempted) * 100;
  };

  QuizSession.prototype.wrongEntries = function () {
    return Array.from(this.wrongMap.values());
  };

  /* ------------------------------------------------------------------ */
  /* 스톱워치 (실제 경과 시각 기준)                                      */
  /* ------------------------------------------------------------------ */

  function Stopwatch(now) {
    this.now = now || Date.now;
    this.startedAt = null;
    this.stoppedAt = null;
  }
  Stopwatch.prototype.start = function () { this.startedAt = this.now(); this.stoppedAt = null; };
  Stopwatch.prototype.stop = function () { if (this.startedAt !== null && this.stoppedAt === null) this.stoppedAt = this.now(); };
  Stopwatch.prototype.elapsedMs = function () {
    if (this.startedAt === null) return 0;
    return Math.max(0, (this.stoppedAt !== null ? this.stoppedAt : this.now()) - this.startedAt);
  };

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  /** 00:07:32 */
  function formatClock(ms) {
    var s = Math.floor(ms / 1000);
    return pad2(Math.floor(s / 3600)) + ':' + pad2(Math.floor((s % 3600) / 60)) + ':' + pad2(s % 60);
  }

  /** 7분 32초 / 1시간 2분 3초 */
  function formatKorean(ms) {
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h > 0) return h + '시간 ' + m + '분 ' + sec + '초';
    if (m > 0) return m + '분 ' + sec + '초';
    return sec + '초';
  }

  var api = {
    DataError: DataError,
    normalizeRecords: normalizeRecords,
    QuizEngine: QuizEngine,
    DIR_EN2KO: DIR_EN2KO,
    DIR_KO2EN: DIR_KO2EN,
    QuizSession: QuizSession,
    Stopwatch: Stopwatch,
    formatClock: formatClock,
    formatKorean: formatKorean,
    toText: toText,
    toList: toList
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WordFlowEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
