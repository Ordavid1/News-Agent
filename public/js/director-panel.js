// public/js/director-panel.js
// V4 Director's Panel — the rich testing UI for V4 episodes.
//
// Loaded as a plain (non-module) script alongside marketing.js. Exposes:
//   window.openDirectorPanel(episodeId, storyId)  — open the modal
//   window.closeDirectorPanel()                   — close + cleanup
//
// SECURITY: This file uses textContent / safe DOM construction for ALL
// dynamic data (beat fields, persona names, LUT ids, dialogue, etc.) so
// no untrusted value is ever injected via innerHTML. The only innerHTML
// use is for the static layout shell with empty placeholders that we
// then populate via DOM methods.

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────────────
  let activeEpisodeId = null;
  let activeStoryId = null;
  let activeEpisode = null;
  let activeStory = null;
  let activeSceneIdx = 0;
  let activeBeatIdx = null;
  let voiceLibrary = null;
  let lutLibrary = null;
  let sse = null;
  let panelRoot = null;
  let pollFallbackInterval = null;
  let progressLog = [];

  const BEAT_TYPE_ICON = {
    TALKING_HEAD_CLOSEUP: '\uD83C\uDFAD',
    DIALOGUE_IN_SCENE: '\uD83D\uDDE3',
    GROUP_DIALOGUE_TWOSHOT: '\uD83D\uDC65',
    SHOT_REVERSE_SHOT: '\uD83D\uDD04',
    SILENT_STARE: '\uD83D\uDC41',
    REACTION: '\uD83D\uDE32',
    INSERT_SHOT: '\uD83C\uDFAF',
    ACTION_NO_DIALOGUE: '\u26A1',
    MONTAGE_SEQUENCE: '\uD83C\uDFAC',
    B_ROLL_ESTABLISHING: '\uD83C\uDFD9',
    VOICEOVER_OVER_BROLL: '\uD83C\uDFA4',
    TEXT_OVERLAY_CARD: '\uD83D\uDCDD',
    SPEED_RAMP_TRANSITION: '\u23E9'
  };

  const BEAT_STATUS_CLASS = {
    pending: 'bg-surface-100 text-ink-500',
    generating: 'bg-blue-100 text-blue-700 animate-pulse',
    generated: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700'
  };

  function csrf() {
    if (typeof window.getCsrfToken === 'function') return window.getCsrfToken();
    return window.csrfToken || '';
  }

  // ─────────────────────────────────────────────────────────────────────
  // Tiny safe-DOM helpers — all dynamic strings go through textContent
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Create an element with attributes + children.
   * Children may be: string (textContent), Node, or array thereof.
   */
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'style') node.style.cssText = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'value' && (tag === 'input' || tag === 'textarea' || tag === 'select')) node.value = v;
        else node.setAttribute(k, v);
      }
    }
    if (children != null) {
      const list = Array.isArray(children) ? children : [children];
      for (const c of list) {
        if (c == null || c === false) continue;
        if (typeof c === 'string' || typeof c === 'number') {
          node.appendChild(document.createTextNode(String(c)));
        } else if (c instanceof Node) {
          node.appendChild(c);
        }
      }
    }
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Public entry points
  // ─────────────────────────────────────────────────────────────────────

  window.openDirectorPanel = async function openDirectorPanel(episodeId, storyId) {
    if (!episodeId || !storyId) {
      console.warn('openDirectorPanel: episodeId and storyId required');
      return;
    }
    activeEpisodeId = episodeId;
    activeStoryId = storyId;
    activeSceneIdx = 0;
    activeBeatIdx = null;
    progressLog = [];

    ensureRoot();
    panelRoot.classList.remove('hidden');
    renderLoadingShell();

    try {
      const [storyResp, voiceResp] = await Promise.all([
        fetch(`/api/brand-stories/${storyId}`).then(r => r.json()),
        fetch(`/api/brand-stories/personas/voice-library`).then(r => r.json()).catch(() => ({ voices: [] }))
      ]);

      activeStory = storyResp.story;
      activeEpisode = (activeStory?.episodes || []).find(ep => ep.id === episodeId);
      voiceLibrary = voiceResp.voices || [];

      if (!activeEpisode) {
        clear(panelRoot);
        panelRoot.appendChild(el('div', { class: 'p-6 text-red-600' }, `Episode ${episodeId} not found in story.`));
        return;
      }

      lutLibrary = await fetchLutLibrary();
      renderPanel();
      connectSSE();
    } catch (err) {
      console.error('openDirectorPanel error:', err);
      clear(panelRoot);
      panelRoot.appendChild(el('div', { class: 'p-6 text-red-600' }, `Failed to load Director's Panel: ${err.message}`));
    }
  };

  window.closeDirectorPanel = function closeDirectorPanel() {
    // Capture the story id BEFORE wiping state so we can refresh the parent
    // brand-stories detail view with any side-effects from the panel
    // (regenerated beats, reassembled episodes with new final_video_url, etc.)
    const refreshStoryId = activeStoryId;

    if (sse) { try { sse.close(); } catch {} sse = null; }
    if (pollFallbackInterval) { clearInterval(pollFallbackInterval); pollFallbackInterval = null; }
    if (panelRoot) panelRoot.classList.add('hidden');
    activeEpisodeId = null;
    activeStoryId = null;
    activeEpisode = null;
    activeStory = null;
    activeBeatIdx = null;
    progressLog = [];

    // Re-render the brand-stories detail view so the episode list picks up
    // any updated final_video_url / subtitle_url / status from the panel's
    // reassemble/regenerate actions. Without this, the user returns to a
    // stale DOM and sees the OLD video URL even though the episode row in
    // the DB was updated. Caught 2026-04-21 during SFX reassembly test.
    if (refreshStoryId && typeof window.showStoryDetail === 'function') {
      window.showStoryDetail(refreshStoryId);
    }
  };

  // ─────────────────────────────────────────────────────────────────────
  // Setup
  // ─────────────────────────────────────────────────────────────────────

  function ensureRoot() {
    if (panelRoot) return;
    panelRoot = document.getElementById('directorPanelRoot');
    if (!panelRoot) {
      panelRoot = document.createElement('div');
      panelRoot.id = 'directorPanelRoot';
      panelRoot.className = 'fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 hidden';
      panelRoot.addEventListener('click', (e) => {
        if (e.target === panelRoot) window.closeDirectorPanel();
      });
      document.body.appendChild(panelRoot);
    }
  }

  function renderLoadingShell() {
    clear(panelRoot);
    const shell = el('div', {
      class: 'bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[95vh] overflow-hidden flex items-center justify-center',
      style: 'min-height: 400px;'
    }, el('div', { class: 'text-ink-500' }, 'Loading Director\'s Panel\u2026'));
    panelRoot.appendChild(shell);
  }

  // Curated LUT list — mirrors services/v4/BrandKitLutMatcher.js
  async function fetchLutLibrary() {
    return [
      { id: 'bs_warm_cinematic', name: 'Warm Cinematic', look: 'Kodak Portra 400, warm shadows' },
      { id: 'bs_cool_noir', name: 'Cool Noir', look: 'Desaturated, blue shadows, high contrast' },
      { id: 'bs_golden_hour', name: 'Golden Hour', look: 'Amber highlights, warm midtones' },
      { id: 'bs_urban_grit', name: 'Urban Grit', look: 'Teal & orange, crushed blacks' },
      { id: 'bs_dreamy_ethereal', name: 'Dreamy Ethereal', look: 'Bloom highlights, soft pastels' },
      { id: 'bs_retro_film', name: 'Retro Film', look: 'Fuji 8mm, muted saturation, warm grain' },
      { id: 'bs_high_contrast_moody', name: 'High Contrast Moody', look: 'Deep blacks, punchy highlights' },
      { id: 'bs_naturalistic', name: 'Naturalistic', look: 'Minimal grade, subtle warmth (safe fallback)' }
    ];
  }

  // ─────────────────────────────────────────────────────────────────────
  // SSE
  // ─────────────────────────────────────────────────────────────────────

  function connectSSE() {
    if (sse) { try { sse.close(); } catch {} }
    try {
      sse = new EventSource(`/api/brand-stories/${activeStoryId}/episodes/${activeEpisodeId}/stream`);
      sse.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          progressLog.push(event);
          if (progressLog.length > 200) progressLog.shift();
          renderProgressFeed();
          if (event.stage === 'beats' || event.stage === 'episode_created' || event.stage === 'beat:done') {
            refreshEpisodeData();
          }
          if (event.stage === 'complete' || event.stage === 'failed') {
            try { sse.close(); } catch {}
            sse = null;
            refreshEpisodeData();
          }
        } catch (err) {
          console.warn('SSE parse error:', err);
        }
      };
      sse.addEventListener('done', () => {
        try { sse.close(); } catch {}
        sse = null;
      });
      sse.onerror = () => {
        if (!pollFallbackInterval) {
          pollFallbackInterval = setInterval(refreshEpisodeData, 5000);
        }
      };
    } catch (err) {
      console.warn('SSE not available, falling back to polling:', err);
      pollFallbackInterval = setInterval(refreshEpisodeData, 5000);
    }
  }

  async function refreshEpisodeData() {
    try {
      const resp = await fetch(`/api/brand-stories/${activeStoryId}`).then(r => r.json());
      const story = resp.story;
      const episode = (story?.episodes || []).find(ep => ep.id === activeEpisodeId);
      if (!episode) return;
      activeStory = story;
      activeEpisode = episode;
      renderHeader();
      renderSceneTimeline();
      renderBeatStrip();
      renderBeatDetail();
      renderScriptQa();
    } catch (err) {
      console.warn('refreshEpisodeData failed:', err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Render — top-level layout shell, then DOM-built sections
  // ─────────────────────────────────────────────────────────────────────

  function renderPanel() {
    clear(panelRoot);

    const header = el('div', { id: 'dpHeader', class: 'border-b border-surface-200 px-5 py-3' });
    const progress = el('div', { id: 'dpProgress', class: 'border-b border-surface-200 bg-surface-50 px-5 py-2 max-h-24 overflow-y-auto text-xs font-mono text-ink-600' });
    const sceneTimelineWrap = el('div', { class: 'border-b border-surface-200 px-5 py-2 overflow-x-auto' },
      el('div', { id: 'dpSceneTimeline', class: 'flex gap-2' })
    );
    const beatStripWrap = el('div', { class: 'border-b border-surface-200 px-5 py-2 overflow-x-auto' },
      el('div', { id: 'dpBeatStrip', class: 'flex gap-2' })
    );

    const beatDetailContainer = el('div', { id: 'dpBeatDetail' });
    const personasContainer = el('div', { id: 'dpPersonasSidebar' });
    const lutContainer = el('div', { id: 'dpLutPicker' });
    const scriptQaContainer = el('div', { id: 'dpScriptQa' });

    const body = el('div', { class: 'flex-1 overflow-y-auto px-5 py-4' }, [
      beatDetailContainer,
      el('div', { class: 'mt-6' }, [
        el('h4', { class: 'text-sm font-semibold text-ink-700 mb-2' }, 'Personas'),
        personasContainer
      ]),
      el('div', { class: 'mt-6' }, [
        el('h4', { class: 'text-sm font-semibold text-ink-700 mb-2' }, 'LUT (color grade)'),
        lutContainer
      ]),
      el('div', { class: 'mt-6' }, [
        el('h4', { class: 'text-sm font-semibold text-ink-700 mb-2' }, 'Script QA'),
        scriptQaContainer
      ])
    ]);

    const modal = el('div', {
      class: 'bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[95vh] overflow-hidden flex flex-col'
    }, [header, progress, sceneTimelineWrap, beatStripWrap, body]);

    panelRoot.appendChild(modal);

    renderHeader();
    renderProgressFeed();
    renderSceneTimeline();
    renderBeatStrip();
    renderBeatDetail();
    renderPersonasSidebar();
    renderLutPicker();
    renderScriptQa();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Script QA panel — surfaces the V4 quality-gate output (Layer-1 validator
  // issues + optional Layer-2 Doctor patches). All fields rendered via
  // textContent through el() — no innerHTML with user data.
  // ─────────────────────────────────────────────────────────────────────
  function renderScriptQa() {
    const node = document.getElementById('dpScriptQa');
    if (!node) return;
    clear(node);
    const report = activeEpisode?.quality_report;
    if (!report || typeof report !== 'object' || Object.keys(report).length === 0) {
      node.appendChild(el('div', { class: 'text-xs text-ink-400' }, 'No quality report on this episode.'));
      return;
    }

    const severityBadge = (sev) => el('span', {
      class: `inline-block text-[10px] font-medium px-1.5 py-0.5 rounded ${
        sev === 'blocker' ? 'bg-red-100 text-red-700 border border-red-200' : 'bg-amber-50 text-amber-700 border border-amber-200'
      }`
    }, sev);

    const renderIssues = (issues, heading) => {
      if (!Array.isArray(issues) || issues.length === 0) return null;
      return el('div', { class: 'mt-2' }, [
        el('div', { class: 'text-xs font-medium text-ink-600 mb-1' }, heading),
        el('ul', { class: 'space-y-1' }, issues.map(i => el('li', {
          class: 'text-xs text-ink-700 flex items-start gap-2'
        }, [
          severityBadge(i.severity || 'warning'),
          el('div', { class: 'flex-1' }, [
            el('div', { class: 'font-mono text-[10px] text-ink-400' }, `${i.scope || '?'} — ${i.id || '?'}`),
            el('div', null, i.message || ''),
            i.hint ? el('div', { class: 'text-ink-500 italic mt-0.5' }, `Hint: ${i.hint}`) : null
          ])
        ])))
      ]);
    };

    const validator = report.validator;
    const validatorPost = report.validator_post_doctor;
    const doctor = report.doctor;

    if (validator?.stats && typeof validator.stats === 'object') {
      const s = validator.stats;
      const statsRow = el('div', { class: 'flex flex-wrap gap-2 text-[11px] text-ink-600 mb-2' }, [
        el('span', { class: 'px-2 py-0.5 bg-surface-50 border border-surface-200 rounded' }, `beats: ${s.total_beats ?? '—'}`),
        el('span', { class: 'px-2 py-0.5 bg-surface-50 border border-surface-200 rounded' }, `dialogue: ${s.dialogue_beats ?? '—'}`),
        el('span', { class: 'px-2 py-0.5 bg-surface-50 border border-surface-200 rounded' }, `avg words: ${typeof s.avg_dialogue_words === 'number' ? s.avg_dialogue_words.toFixed(1) : '—'}`),
        el('span', { class: 'px-2 py-0.5 bg-surface-50 border border-surface-200 rounded' }, `subtext: ${typeof s.subtext_coverage === 'number' ? Math.round(s.subtext_coverage * 100) + '%' : '—'}`)
      ]);
      node.appendChild(statsRow);
    }

    if (validator) {
      const issuesBlock = renderIssues(validator.issues, 'Layer-1 validator');
      if (issuesBlock) node.appendChild(issuesBlock);
    }

    if (doctor) {
      const sub = el('div', { class: 'mt-3 bg-surface-50 border border-surface-200 rounded p-2 text-xs text-ink-600' }, [
        el('div', { class: 'font-medium mb-0.5 text-ink-700' }, 'Script Doctor pass'),
        doctor.skipped
          ? el('div', { class: 'italic text-ink-500' }, `skipped: ${doctor.skipped}`)
          : el('div', null, [
              el('div', null, `applied: ${Array.isArray(doctor.applied) ? doctor.applied.length : 0}, rejected: ${Array.isArray(doctor.rejected) ? doctor.rejected.length : 0}`),
              doctor.notes ? el('div', { class: 'italic text-ink-500 mt-0.5' }, `"${doctor.notes}"`) : null
            ])
      ]);
      node.appendChild(sub);
    }

    if (validatorPost) {
      const issuesBlock2 = renderIssues(validatorPost.issues, 'Layer-1 (post-doctor)');
      if (issuesBlock2) node.appendChild(issuesBlock2);
    }

    if (report.error) {
      node.appendChild(el('div', { class: 'mt-2 text-xs text-red-600' }, `Quality-gate error (non-fatal): ${report.error}`));
    }
  }

  function renderHeader() {
    const node = document.getElementById('dpHeader');
    if (!node) return;
    clear(node);

    const ep = activeEpisode || {};
    const sceneDescription = ep.scene_description || {};
    const totalBeats = (sceneDescription.scenes || []).reduce((n, s) => n + (s.beats?.length || 0), 0);
    const totalCost = (sceneDescription.scenes || []).reduce((sum, s) =>
      sum + (s.beats || []).reduce((bs, b) => bs + (b.cost_usd || b.estimated_cost_usd || 0), 0)
    , 0);
    const lutId = ep.lut_id || activeStory?.brand_kit_lut_id || activeStory?.locked_lut_id || 'bs_naturalistic';
    const status = ep.status || 'pending';

    const row = el('div', { class: 'flex items-center gap-3 flex-wrap' }, [
      el('h3', { class: 'text-lg font-bold text-ink-800 truncate flex-1' },
        `Director's Panel \u2014 ${sceneDescription.title || `Episode ${ep.episode_number || ''}`}`
      ),
      el('span', { class: 'px-2 py-0.5 text-[11px] rounded bg-brand-600 text-white font-mono' }, 'V4'),
      el('span', { class: 'px-2 py-0.5 text-[11px] rounded bg-purple-100 text-purple-700 font-mono' }, lutId),
      el('span', { class: 'px-2 py-0.5 text-[11px] rounded bg-surface-100 text-ink-700' }, `${totalBeats} beats`),
      el('span', { class: 'px-2 py-0.5 text-[11px] rounded bg-green-100 text-green-700' }, `~$${totalCost.toFixed(2)}`),
      el('span', {
        class: `px-2 py-0.5 text-[11px] rounded ${status === 'ready' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`
      }, status),
      el('button', {
        class: 'px-3 py-1 text-xs bg-white border border-surface-300 text-ink-700 rounded hover:bg-surface-50',
        onclick: () => window._dpReassemble()
      }, 'Reassemble'),
      el('button', {
        class: 'px-3 py-1 text-xs bg-surface-100 text-ink-700 rounded hover:bg-surface-200',
        onclick: () => window.closeDirectorPanel()
      }, 'Close')
    ]);
    node.appendChild(row);
  }

  function renderProgressFeed() {
    const node = document.getElementById('dpProgress');
    if (!node) return;
    clear(node);
    if (progressLog.length === 0) {
      node.appendChild(el('div', { class: 'text-ink-400' }, 'Waiting for progress events\u2026'));
      return;
    }
    for (const e of progressLog.slice(-8)) {
      const ts = new Date(e.ts).toLocaleTimeString();
      const line = el('div', null, [
        document.createTextNode(`[${ts}] `),
        el('span', { class: 'text-brand-600' }, e.stage || ''),
        document.createTextNode(' '),
        document.createTextNode(e.detail || '')
      ]);
      node.appendChild(line);
    }
  }

  function renderSceneTimeline() {
    const node = document.getElementById('dpSceneTimeline');
    if (!node) return;
    clear(node);
    const scenes = activeEpisode?.scene_description?.scenes || [];
    if (scenes.length === 0) {
      node.appendChild(el('div', { class: 'text-ink-400 text-xs' }, 'No scenes'));
      return;
    }
    scenes.forEach((scene, i) => {
      const isActive = i === activeSceneIdx;
      const beatCount = (scene.beats || []).length;
      const sceneType = scene.type === 'montage' ? '\uD83C\uDFAC ' : '';
      const btn = el('button', {
        class: `px-3 py-2 rounded text-xs whitespace-nowrap ${isActive ? 'bg-brand-600 text-white' : 'bg-surface-100 text-ink-700 hover:bg-surface-200'}`,
        onclick: () => window._dpSelectScene(i)
      }, `${sceneType}Scene ${i + 1} \u00B7 ${beatCount} beats`);
      node.appendChild(btn);
    });
  }

  function renderBeatStrip() {
    const node = document.getElementById('dpBeatStrip');
    if (!node) return;
    clear(node);
    const scene = (activeEpisode?.scene_description?.scenes || [])[activeSceneIdx];
    if (!scene) {
      node.appendChild(el('div', { class: 'text-ink-400 text-xs' }, 'No active scene'));
      return;
    }
    const beats = scene.beats || [];
    if (beats.length === 0) {
      node.appendChild(el('div', { class: 'text-ink-400 text-xs' }, 'No beats in this scene'));
      return;
    }
    beats.forEach((beat, i) => {
      const isActive = i === activeBeatIdx;
      const icon = BEAT_TYPE_ICON[beat.type] || '\u2753';
      const statusClass = BEAT_STATUS_CLASS[beat.status] || BEAT_STATUS_CLASS.pending;
      const dur = beat.actual_duration_sec || beat.duration_seconds;
      const durStr = dur ? `\u00B7${typeof dur === 'number' ? dur.toFixed(0) : dur}s` : '';
      const card = el('button', {
        class: `flex-shrink-0 w-28 p-2 rounded border ${isActive ? 'border-brand-500 bg-brand-50' : 'border-surface-200 hover:border-brand-300'} text-left`,
        onclick: () => window._dpSelectBeat(i)
      }, [
        el('div', { class: 'text-xl mb-1' }, icon),
        el('div', { class: 'text-[10px] font-mono text-ink-400' }, beat.beat_id || ''),
        el('div', { class: 'text-[10px] truncate' }, `${(beat.type || '').split('_').join(' ').toLowerCase()}${durStr}`),
        el('div', { class: `mt-1 px-1 py-0.5 text-[9px] rounded inline-block ${statusClass}` }, beat.status || 'pending')
      ]);
      node.appendChild(card);
    });
  }

  function renderBeatDetail() {
    const node = document.getElementById('dpBeatDetail');
    if (!node) return;
    clear(node);

    const scene = (activeEpisode?.scene_description?.scenes || [])[activeSceneIdx];
    const beat = scene && activeBeatIdx != null ? (scene.beats || [])[activeBeatIdx] : null;
    if (!beat) {
      node.appendChild(el('div', { class: 'text-ink-400 text-sm py-8 text-center' }, 'Click a beat above to edit it'));
      return;
    }

    const personas = activeStory?.persona_config?.personas || (activeStory?.persona_config ? [activeStory.persona_config] : []);
    const personaName = (typeof beat.persona_index === 'number' && personas[beat.persona_index]?.name) || '\u2014';

    const wrap = el('div', { class: 'space-y-3' });

    // Header row
    const headerRow = el('div', { class: 'flex items-center gap-3' }, [
      el('div', { class: 'text-2xl' }, BEAT_TYPE_ICON[beat.type] || '\u2753'),
      el('div', { class: 'flex-1' }, [
        el('div', { class: 'text-xs font-mono text-ink-400' }, beat.beat_id || ''),
        el('div', { class: 'text-base font-semibold text-ink-800' }, beat.type || '')
      ]),
      el('div', { class: 'text-xs text-ink-500' }, [
        beat.model_used ? el('div', null, `Model: ${beat.model_used}`) : null,
        beat.cost_usd ? el('div', null, `Cost: $${Number(beat.cost_usd).toFixed(3)}`) : null,
        beat.actual_duration_sec ? el('div', null, `Actual: ${Number(beat.actual_duration_sec).toFixed(1)}s`) : null
      ])
    ]);
    wrap.appendChild(headerRow);

    // V4 director-metadata badges. Read-only chips surfacing the screenwriter's
    // intent on this beat so the human director can see Gemini's reasoning
    // before deciding whether to edit or regenerate.
    const chip = (label, value, tone) => el('span', {
      class: `inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border ${
        tone === 'strong' ? 'bg-brand-50 border-brand-200 text-brand-700' :
        tone === 'warn'   ? 'bg-amber-50 border-amber-200 text-amber-700' :
                            'bg-surface-50 border-surface-200 text-ink-600'
      }`
    }, [
      el('span', { class: 'font-medium' }, label),
      el('span', { class: 'text-ink-500' }, value)
    ]);
    const badges = [];
    if (beat.narrative_purpose) badges.push(chip('purpose', beat.narrative_purpose, 'strong'));
    if (beat.beat_intent) badges.push(chip('intent', beat.beat_intent));
    if (beat.subtext) badges.push(chip('subtext', beat.subtext, 'warn'));
    if (beat.emotional_hold === true) badges.push(chip('hold', 'silence after', 'warn'));
    if (beat.pace_hint) badges.push(chip('pace', beat.pace_hint));
    // Scene-level metadata surfaced on every beat of the scene for quick read
    if (scene) {
      if (scene.scene_goal) badges.push(chip('scene goal', scene.scene_goal));
      if (scene.dramatic_question) badges.push(chip('scene Q', scene.dramatic_question));
      if (Array.isArray(scene.hook_types) && scene.hook_types.length > 0) {
        badges.push(chip('hooks', scene.hook_types.join(', '), 'strong'));
      }
    }
    if (badges.length > 0) {
      wrap.appendChild(el('div', { class: 'flex flex-wrap gap-1.5' }, badges));
    }

    if (beat.error_message) {
      wrap.appendChild(el('div', {
        class: 'bg-red-50 border border-red-200 text-red-700 text-xs p-2 rounded'
      }, beat.error_message));
    }

    if (beat.generated_video_url) {
      const video = document.createElement('video');
      video.src = beat.generated_video_url;
      video.controls = true;
      video.className = 'w-full max-w-xs rounded border border-surface-200';
      wrap.appendChild(el('div', null, video));
    }

    // Edit form — built with input/textarea elements that take values via .value
    // (textContent-equivalent for form fields, no innerHTML)
    const form = el('form', {
      id: 'dpBeatEditForm',
      class: 'space-y-2',
      onsubmit: (e) => { e.preventDefault(); window._dpSaveBeatEdits(); }
    });

    if (typeof beat.persona_index === 'number') {
      form.appendChild(el('div', null, [
        el('label', { class: 'text-xs font-medium text-ink-600' }, 'Persona'),
        el('div', { class: 'text-sm text-ink-700' }, `${personaName} (index ${beat.persona_index})`)
      ]));
    }

    const addTextarea = (name, label, value) => {
      const ta = document.createElement('textarea');
      ta.name = name;
      ta.rows = 2;
      ta.className = 'w-full text-sm p-2 border border-surface-300 rounded';
      ta.value = value || '';
      form.appendChild(el('div', null, [
        el('label', { class: 'text-xs font-medium text-ink-600' }, label),
        ta
      ]));
    };

    const addText = (name, label, value, type) => {
      const inp = document.createElement('input');
      inp.type = type || 'text';
      inp.name = name;
      inp.className = 'w-full text-sm p-2 border border-surface-300 rounded';
      inp.value = value == null ? '' : value;
      if (type === 'number') {
        inp.min = '2'; inp.max = '15'; inp.step = '1';
      }
      form.appendChild(el('div', null, [
        el('label', { class: 'text-xs font-medium text-ink-600' }, label),
        inp
      ]));
    };

    if ('dialogue' in beat) addTextarea('dialogue', 'Dialogue', beat.dialogue);
    if ('subtext' in beat || beat.dialogue) {
      // Always offer the subtext field on any dialogue-bearing beat so a
      // director can add subtext even if Gemini didn't emit one.
      addTextarea('subtext', 'Subtext (what the line really means — not shown to viewer)', beat.subtext);
    }
    if ('expression_notes' in beat) addTextarea('expression_notes', 'Expression notes', beat.expression_notes);
    addTextarea('narrative_purpose', 'Narrative purpose (why this beat exists)', beat.narrative_purpose);
    if ('action_prompt' in beat) addTextarea('action_prompt', 'Action prompt', beat.action_prompt);
    if ('subject_focus' in beat) addText('subject_focus', 'Subject focus', beat.subject_focus);
    if ('lighting_intent' in beat) addText('lighting_intent', 'Lighting intent', beat.lighting_intent);
    if ('camera_move' in beat) addText('camera_move', 'Camera move', beat.camera_move);

    const grid = el('div', { class: 'grid grid-cols-2 gap-2' });
    if ('duration_seconds' in beat) {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.name = 'duration_seconds';
      inp.min = '2'; inp.max = '15'; inp.step = '1';
      inp.className = 'w-full text-sm p-2 border border-surface-300 rounded';
      inp.value = beat.duration_seconds || 4;
      grid.appendChild(el('div', null, [
        el('label', { class: 'text-xs font-medium text-ink-600' }, 'Duration (sec)'),
        inp
      ]));
    } else {
      grid.appendChild(el('div', null));
    }
    if ('lens' in beat) {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.name = 'lens';
      inp.className = 'w-full text-sm p-2 border border-surface-300 rounded';
      inp.value = beat.lens || '';
      grid.appendChild(el('div', null, [
        el('label', { class: 'text-xs font-medium text-ink-600' }, 'Lens'),
        inp
      ]));
    }
    form.appendChild(grid);

    // Action buttons
    const buttonRow = el('div', { class: 'flex gap-2 pt-2' }, [
      el('button', {
        type: 'submit',
        class: 'px-4 py-1.5 text-xs bg-white border border-surface-300 text-ink-700 rounded hover:bg-surface-50'
      }, 'Save edits'),
      el('button', {
        type: 'button',
        class: 'px-4 py-1.5 text-xs bg-brand-600 text-white rounded hover:bg-brand-700',
        onclick: () => window._dpRegenerateBeat()
      }, 'Regenerate this beat'),
      el('button', {
        type: 'button',
        class: 'px-4 py-1.5 text-xs bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100',
        onclick: () => window._dpDeleteBeat()
      }, 'Delete')
    ]);
    form.appendChild(buttonRow);

    wrap.appendChild(form);
    node.appendChild(wrap);
  }

  function renderPersonasSidebar() {
    const node = document.getElementById('dpPersonasSidebar');
    if (!node) return;
    clear(node);
    const personas = activeStory?.persona_config?.personas || (activeStory?.persona_config ? [activeStory.persona_config] : []);
    if (personas.length === 0) {
      node.appendChild(el('div', { class: 'text-ink-400 text-xs' }, 'No personas'));
      return;
    }
    personas.forEach((p, i) => {
      const voiceName = p.elevenlabs_voice_name || (p.elevenlabs_voice_id ? p.elevenlabs_voice_id.slice(0, 8) : '\u2014');

      const select = document.createElement('select');
      select.className = 'text-xs border border-surface-300 rounded px-1 py-0.5';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '— override —';
      select.appendChild(placeholder);
      (voiceLibrary || []).forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.voice_id;
        opt.textContent = `${v.name} (${v.gender})`;
        if (v.voice_id === p.elevenlabs_voice_id) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener('change', () => {
        window._dpOverridePersonaVoice(i, select.value, select.options[select.selectedIndex].textContent);
      });

      const row = el('div', { class: 'flex items-center gap-2 p-2 border border-surface-200 rounded mb-1' }, [
        el('div', { class: 'flex-shrink-0 w-8 h-8 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center text-xs font-bold' }, String(i + 1)),
        el('div', { class: 'flex-1 min-w-0' }, [
          el('div', { class: 'text-sm font-medium text-ink-800 truncate' }, p.name || `Persona ${i + 1}`),
          el('div', { class: 'text-[10px] text-ink-400 truncate' }, `Voice: ${voiceName}`)
        ]),
        select
      ]);
      node.appendChild(row);
    });
  }

  function renderLutPicker() {
    const node = document.getElementById('dpLutPicker');
    if (!node) return;
    clear(node);
    const lockedId = activeStory?.locked_lut_id;
    const brandKitId = activeStory?.brand_kit_lut_id;
    const episodeLutId = activeEpisode?.lut_id;
    const resolved = lockedId || brandKitId || episodeLutId || 'bs_naturalistic';
    const sourceLabel = lockedId ? '(locked by user)'
      : brandKitId ? '(from brand kit)'
        : episodeLutId ? '(from screenplay)' : '(default)';

    node.appendChild(el('div', { class: 'text-xs text-ink-500 mb-2' }, [
      document.createTextNode('Current resolved LUT: '),
      el('span', { class: 'font-mono text-ink-700' }, resolved),
      document.createTextNode(' ' + sourceLabel)
    ]));

    const select = document.createElement('select');
    select.id = 'dpLutLockSelect';
    select.className = 'text-xs border border-surface-300 rounded p-1';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— Auto (no lock) —';
    select.appendChild(placeholder);
    (lutLibrary || []).forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.id;
      opt.textContent = `${l.name} \u2014 ${l.look}`;
      if (l.id === lockedId) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => window._dpSetLockedLut(select.value));
    node.appendChild(select);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Action handlers
  // ─────────────────────────────────────────────────────────────────────

  window._dpSelectScene = function (idx) {
    activeSceneIdx = idx;
    activeBeatIdx = null;
    renderSceneTimeline();
    renderBeatStrip();
    renderBeatDetail();
  };

  window._dpSelectBeat = function (idx) {
    activeBeatIdx = idx;
    renderBeatStrip();
    renderBeatDetail();
  };

  window._dpSaveBeatEdits = async function () {
    const form = document.getElementById('dpBeatEditForm');
    if (!form) return;
    const beat = ((activeEpisode?.scene_description?.scenes || [])[activeSceneIdx]?.beats || [])[activeBeatIdx];
    if (!beat) return;

    const formData = new FormData(form);
    const payload = {};
    for (const [k, v] of formData.entries()) {
      if (k === 'duration_seconds') payload[k] = parseInt(v, 10);
      else payload[k] = v;
    }

    try {
      const resp = await fetch(`/api/brand-stories/${activeStoryId}/episodes/${activeEpisodeId}/beats/${beat.beat_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify(payload)
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'Save failed');
      Object.assign(beat, payload);
      flashStatus('Saved');
    } catch (err) {
      flashStatus(`Save failed: ${err.message}`, true);
    }
  };

  window._dpRegenerateBeat = async function () {
    const beat = ((activeEpisode?.scene_description?.scenes || [])[activeSceneIdx]?.beats || [])[activeBeatIdx];
    if (!beat) return;
    if (!confirm(`Regenerate beat ${beat.beat_id}? This will burn fresh API calls.`)) return;
    try {
      const resp = await fetch(`/api/brand-stories/${activeStoryId}/episodes/${activeEpisodeId}/beats/${beat.beat_id}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify({})
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'Regenerate failed');
      flashStatus('Regenerate started');
      connectSSE();
    } catch (err) {
      flashStatus(`Regenerate failed: ${err.message}`, true);
    }
  };

  window._dpDeleteBeat = async function () {
    const beat = ((activeEpisode?.scene_description?.scenes || [])[activeSceneIdx]?.beats || [])[activeBeatIdx];
    if (!beat) return;
    if (!confirm(`Delete beat ${beat.beat_id}? This cannot be undone.`)) return;
    try {
      const resp = await fetch(`/api/brand-stories/${activeStoryId}/episodes/${activeEpisodeId}/beats/${beat.beat_id}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': csrf() }
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'Delete failed');
      flashStatus('Beat deleted');
      activeBeatIdx = null;
      await refreshEpisodeData();
    } catch (err) {
      flashStatus(`Delete failed: ${err.message}`, true);
    }
  };

  window._dpReassemble = async function () {
    if (!confirm('Re-run post-production (assembly + LUT + music + cards)?')) return;
    try {
      const resp = await fetch(`/api/brand-stories/${activeStoryId}/episodes/${activeEpisodeId}/reassemble`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrf() }
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'Reassemble failed');
      flashStatus('Reassembly started');
      connectSSE();
    } catch (err) {
      flashStatus(`Reassemble failed: ${err.message}`, true);
    }
  };

  window._dpOverridePersonaVoice = async function (personaIdx, voiceId, voiceName) {
    if (!voiceId) return;
    try {
      const resp = await fetch(`/api/brand-stories/${activeStoryId}/personas/${personaIdx}/voice`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify({ voice_id: voiceId, voice_name: voiceName })
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'Voice override failed');
      const personas = activeStory.persona_config?.personas || [activeStory.persona_config];
      personas[personaIdx].elevenlabs_voice_id = voiceId;
      personas[personaIdx].elevenlabs_voice_name = voiceName;
      renderPersonasSidebar();
      flashStatus(`Voice updated: ${voiceName}`);
    } catch (err) {
      flashStatus(`Voice override failed: ${err.message}`, true);
    }
  };

  window._dpSetLockedLut = async function (lutId) {
    try {
      const resp = await fetch(`/api/brand-stories/${activeStoryId}/lut`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify({ locked_lut_id: lutId || null })
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'LUT lock failed');
      activeStory.locked_lut_id = lutId || null;
      renderLutPicker();
      renderHeader();
      flashStatus(lutId ? `LUT locked: ${lutId}` : 'LUT lock cleared');
    } catch (err) {
      flashStatus(`LUT lock failed: ${err.message}`, true);
    }
  };

  // ─────────────────────────────────────────────────────────────────────
  // Status flash
  // ─────────────────────────────────────────────────────────────────────

  function flashStatus(msg, isError) {
    const div = el('div', {
      class: `fixed top-6 right-6 z-[60] px-4 py-2 rounded shadow-lg text-sm ${isError ? 'bg-red-600 text-white' : 'bg-green-600 text-white'}`
    }, msg);
    document.body.appendChild(div);
    setTimeout(() => { try { document.body.removeChild(div); } catch {} }, 3000);
  }
})();
