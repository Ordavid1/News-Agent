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
  // Which section is mounted in the right rail. Defaults to Script QA because
  // it surfaces blockers / warnings the director needs to address first.
  let activeRightTab = 'qa';

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
    activeRightTab = 'qa';
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
      panelRoot.className = 'fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-2 sm:p-4 hidden';
      panelRoot.addEventListener('click', (e) => {
        if (e.target === panelRoot) window.closeDirectorPanel();
      });
      document.body.appendChild(panelRoot);
    }
  }

  function renderLoadingShell() {
    clear(panelRoot);
    const shell = el('div', {
      class: 'bg-white rounded-2xl shadow-2xl w-full max-w-7xl max-h-[95vh] overflow-hidden flex items-center justify-center',
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
      // renderRightPane() re-mounts the active right-rail tab and recomputes
      // the QA-issue-count + L3-note badges. Replaces the old direct
      // renderScriptQa() / renderDirectorNotes() calls, which were no-ops for
      // any tab whose container wasn't currently in the DOM.
      renderRightPane();
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

    // Progress feed is wrapped in a <details> so the user can collapse it once
    // they've seen the pipeline kick off. Default open on first render.
    const progressFeed = el('div', {
      id: 'dpProgress',
      class: 'max-h-32 overflow-y-auto text-xs font-mono text-ink-600 px-5 pb-2'
    });
    const progressDetails = el('details', {
      class: 'border-b border-surface-200 bg-surface-50',
      open: 'open'
    }, [
      el('summary', {
        class: 'px-5 py-1.5 cursor-pointer text-[11px] font-medium text-ink-500 hover:text-ink-700 select-none'
      }, 'Pipeline progress'),
      progressFeed
    ]);

    const sceneTimelineWrap = el('div', { class: 'border-b border-surface-200 px-5 py-2 overflow-x-auto' },
      el('div', { id: 'dpSceneTimeline', class: 'flex gap-2' })
    );
    const beatStripWrap = el('div', { class: 'border-b border-surface-200 px-5 py-2 overflow-x-auto' },
      el('div', { id: 'dpBeatStrip', class: 'flex gap-2' })
    );

    const beatDetailContainer = el('div', { id: 'dpBeatDetail' });
    // The container IDs below stay stable — the existing render*() functions
    // target them by ID. We just re-mount them under the active right-pane tab.
    const personasContainer = el('div', { id: 'dpPersonasSidebar' });
    const lutContainer = el('div', { id: 'dpLutPicker' });
    const scriptQaContainer = el('div', { id: 'dpScriptQa' });
    const directorNotesContainer = el('div', { id: 'dpDirectorNotes' });
    // Phase 7 — V4 Audio Coherence Overhaul. Sonic Series Bible (story-level)
    // + episode sonic_world (palette + spectral_anchor + scene_variations).
    const soundContainer = el('div', { id: 'dpSoundPanel' });
    // Cast Bible Phase 4 — Casting Room. View/lock/edit story-level
    // cast_bible.principals[] + per-persona gender chip + voice mismatch chip.
    const castingContainer = el('div', { id: 'dpCastingPanel' });

    // Left pane: beat editor — always visible, scrolls independently of the
    // right rail so the director can edit a beat without losing QA context.
    const leftPane = el('div', {
      class: 'flex-1 min-w-0 overflow-y-auto px-5 py-4 lg:border-r lg:border-surface-200'
    }, beatDetailContainer);

    // Right pane: tabbed (Script QA / Personas + LUT / Director's Notes). On
    // narrow viewports the right pane stacks beneath the left pane (lg: ≥1024px
    // is the breakpoint where the two-column layout activates).
    const tabBar = el('div', {
      id: 'dpRightTabBar',
      class: 'flex items-center gap-1 border-b border-surface-200 px-3 py-2 bg-surface-50'
    });
    const rightContent = el('div', {
      id: 'dpRightContent',
      class: 'flex-1 overflow-y-auto px-5 py-4'
    });
    const rightPane = el('div', {
      class: 'flex flex-col w-full lg:w-[28rem] xl:w-[32rem] border-t border-surface-200 lg:border-t-0 max-h-[55vh] lg:max-h-none'
    }, [tabBar, rightContent]);

    // Stash the right-pane containers on the panel root so renderRightPane()
    // can mount them without rebuilding their internals.
    panelRoot._dpContainers = {
      personasContainer, lutContainer, scriptQaContainer, directorNotesContainer, soundContainer, castingContainer
    };

    const body = el('div', {
      class: 'flex-1 overflow-hidden flex flex-col lg:flex-row'
    }, [leftPane, rightPane]);

    // V4 P0.5 — Director Review halt banner. Only renders when episode is
    // in `awaiting_user_review` status. Sits above the header so it's the
    // first thing the user sees on a halted episode.
    const haltBanner = el('div', { id: 'dpHaltBanner' });

    const modal = el('div', {
      class: 'bg-white rounded-2xl shadow-2xl w-full max-w-7xl max-h-[95vh] overflow-hidden flex flex-col'
    }, [haltBanner, header, progressDetails, sceneTimelineWrap, beatStripWrap, body]);

    panelRoot.appendChild(modal);

    renderHeader();
    renderHaltBanner();
    renderProgressFeed();
    renderSceneTimeline();
    renderBeatStrip();
    renderBeatDetail();
    renderRightPane();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Right-rail tab switcher — mounts one of (Script QA / Personas + LUT /
  // Director's Notes) into the right-pane content area and re-runs that
  // section's existing render function. Keeps render logic untouched.
  // ─────────────────────────────────────────────────────────────────────
  function renderRightPane() {
    const tabBar = document.getElementById('dpRightTabBar');
    const rightContent = document.getElementById('dpRightContent');
    if (!tabBar || !rightContent) return;
    clear(tabBar);
    clear(rightContent);

    const containers = panelRoot && panelRoot._dpContainers;
    if (!containers) return;

    const issuesCount = (() => {
      const r = activeEpisode?.quality_report;
      if (!r) return 0;
      const l1 = Array.isArray(r.layer_1?.issues) ? r.layer_1.issues.length : 0;
      const post = Array.isArray(r.layer_1_post_doctor?.issues) ? r.layer_1_post_doctor.issues.length : 0;
      return l1 + post;
    })();

    const hasL3Notes = (() => {
      const dr = activeEpisode?.director_report;
      if (!dr) return false;
      return Boolean(dr.lens_a) || Boolean(dr.lens_b) || Boolean(dr.lens_c) || Boolean(dr.lens_d);
    })();

    // Cast Bible Phase 4 — surface Casting Room badges:
    //   - red dot when any principal has voice_gender_match === false
    //   - amber dot when any principal has gender_resolved_from === 'unknown'
    // Both are invisible when the bible is null or all principals are clean.
    const castingBadge = (() => {
      const principals = activeStory?.cast_bible?.principals;
      if (!Array.isArray(principals) || principals.length === 0) return null;
      const anyMismatch = principals.some(p => p && p.voice_gender_match === false);
      if (anyMismatch) return '!';
      const anyUnknown = principals.some(p => p && p.gender_resolved_from === 'unknown');
      if (anyUnknown) return '?';
      const isLocked = activeStory?.cast_bible?.status === 'locked';
      return isLocked ? '🔒' : null;
    })();

    const tabs = [
      { id: 'qa', label: 'Script QA', badge: issuesCount > 0 ? String(issuesCount) : null },
      { id: 'personas', label: 'Personas & LUT', badge: null },
      { id: 'casting', label: 'Casting', badge: castingBadge },
      { id: 'sound', label: 'Sound', badge: null },
      { id: 'notes', label: 'Director\u2019s Notes', badge: hasL3Notes ? 'L3' : null }
    ];

    for (const t of tabs) {
      const isActive = activeRightTab === t.id;
      const btn = el('button', {
        type: 'button',
        class: 'px-3 py-1.5 text-xs rounded-md flex items-center gap-1.5 transition-colors ' + (
          isActive
            ? 'bg-white border border-surface-200 shadow-sm font-medium text-ink-800'
            : 'text-ink-500 hover:text-ink-700'
        ),
        onclick: () => {
          if (activeRightTab === t.id) return;
          activeRightTab = t.id;
          renderRightPane();
        }
      }, [t.label]);
      if (t.badge) {
        const badgeClass = t.id === 'notes'
          ? 'text-[10px] font-mono px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded border border-purple-200'
          : 'text-[10px] font-medium px-1.5 py-0.5 bg-red-100 text-red-700 rounded border border-red-200';
        btn.appendChild(el('span', { class: badgeClass }, t.badge));
      }
      tabBar.appendChild(btn);
    }

    if (activeRightTab === 'qa') {
      rightContent.appendChild(el('h4', { class: 'text-sm font-semibold text-ink-700 mb-2' }, 'Script QA'));
      rightContent.appendChild(containers.scriptQaContainer);
      renderScriptQa();
    } else if (activeRightTab === 'personas') {
      rightContent.appendChild(el('h4', { class: 'text-sm font-semibold text-ink-700 mb-2' }, 'Personas'));
      rightContent.appendChild(containers.personasContainer);
      rightContent.appendChild(el('h4', { class: 'text-sm font-semibold text-ink-700 mt-6 mb-2' }, 'LUT (color grade)'));
      rightContent.appendChild(containers.lutContainer);
      renderPersonasSidebar();
      renderLutPicker();
    } else if (activeRightTab === 'casting') {
      rightContent.appendChild(el('h4', { class: 'text-sm font-semibold text-ink-700 mb-2 flex items-center gap-2' }, [
        'Casting Room',
        el('span', { class: 'text-[10px] font-mono px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded border border-blue-200' }, 'V4')
      ]));
      rightContent.appendChild(containers.castingContainer);
      renderCastingPanel();
    } else if (activeRightTab === 'sound') {
      rightContent.appendChild(el('h4', { class: 'text-sm font-semibold text-ink-700 mb-2 flex items-center gap-2' }, [
        'Sound design',
        el('span', { class: 'text-[10px] font-mono px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded border border-blue-200' }, 'V4')
      ]));
      rightContent.appendChild(containers.soundContainer);
      renderSoundPanel();
    } else if (activeRightTab === 'notes') {
      rightContent.appendChild(el('h4', { class: 'text-sm font-semibold text-ink-700 mb-2 flex items-center gap-2' }, [
        'Director\u2019s Notes',
        el('span', { class: 'text-[10px] font-mono px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded border border-purple-200' }, 'L3')
      ]));
      rightContent.appendChild(containers.directorNotesContainer);
      renderDirectorNotes();
    }
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

  // ─────────────────────────────────────────────────────────────────────
  // Director's Notes (Layer 3) — surfaces the V4 Director Agent verdicts
  // emitted at four checkpoints (screenplay / scene_master / beat / episode).
  // Verdict contract: .claude/agents/branded-film-director.md §7.
  // All fields rendered via textContent through el() — no innerHTML with
  // user/model data, identical XSS posture as renderScriptQa.
  // ─────────────────────────────────────────────────────────────────────
  function renderDirectorNotes() {
    const node = document.getElementById('dpDirectorNotes');
    if (!node) return;
    clear(node);
    const report = activeEpisode?.director_report;
    if (!report || typeof report !== 'object' || Object.keys(report).length === 0) {
      node.appendChild(el('div', { class: 'text-xs text-ink-400' },
        'No Director verdicts on this episode. (Set BRAND_STORY_DIRECTOR_AGENT=shadow to activate L3 craft critic.)'
      ));
      return;
    }

    // ─── verdict color helpers ───
    const verdictColor = (v) => {
      switch (v) {
        case 'pass':            return 'bg-green-100 text-green-700 border-green-200';
        case 'pass_with_notes': return 'bg-emerald-50 text-emerald-700 border-emerald-200';
        case 'soft_reject':     return 'bg-amber-100 text-amber-700 border-amber-200';
        case 'hard_reject':     return 'bg-red-100 text-red-700 border-red-200';
        default:                return 'bg-surface-100 text-ink-600 border-surface-200';
      }
    };
    const severityColor = (s) => {
      switch (s) {
        case 'critical': return 'bg-red-100 text-red-700 border-red-200';
        case 'warning':  return 'bg-amber-50 text-amber-700 border-amber-200';
        case 'note':     return 'bg-surface-50 text-ink-600 border-surface-200';
        default:         return 'bg-surface-50 text-ink-600 border-surface-200';
      }
    };
    const scoreColor = (s) => {
      const n = Number(s);
      if (!Number.isFinite(n)) return 'bg-surface-100 text-ink-600';
      if (n >= 85) return 'bg-green-100 text-green-700';
      if (n >= 70) return 'bg-emerald-50 text-emerald-700';
      if (n >= 50) return 'bg-amber-100 text-amber-700';
      return 'bg-red-100 text-red-700';
    };

    const verdictBadge = (v) => el('span', {
      class: `inline-block text-[10px] font-medium px-1.5 py-0.5 rounded border ${verdictColor(v)}`
    }, v || 'unknown');
    const scoreBadge = (s) => el('span', {
      class: `inline-block text-[10px] font-mono px-1.5 py-0.5 rounded ${scoreColor(s)}`
    }, `${Number.isFinite(Number(s)) ? Math.round(Number(s)) : '—'}/100`);
    const severityBadge = (sev) => el('span', {
      class: `inline-block text-[10px] font-medium px-1.5 py-0.5 rounded border ${severityColor(sev)}`
    }, sev || 'note');

    // Render the dimension scores as compact chips (each dimension shown as
    // "name: 73"). Skips empty/missing scores gracefully.
    const renderDimensionScores = (scores) => {
      if (!scores || typeof scores !== 'object') return null;
      const entries = Object.entries(scores).filter(([, v]) => v != null);
      if (entries.length === 0) return null;
      return el('div', { class: 'flex flex-wrap gap-1 mt-1' },
        entries.map(([name, val]) => el('span', {
          class: `text-[10px] font-mono px-1.5 py-0.5 rounded ${scoreColor(val)}`
        }, `${name}: ${Number.isFinite(Number(val)) ? Math.round(Number(val)) : '—'}`))
      );
    };

    // Render a single finding row — id, severity, scope, message, evidence,
    // remediation prompt_delta. Click the prompt-delta block to copy to clipboard.
    // For beat-scoped findings with action='regenerate_beat' and a non-empty
    // prompt_delta, an "Apply L3 nudge & regenerate" button posts to the
    // existing regenerate route with directorNotes=prompt_delta — the route
    // stamps it onto the beat as director_nudge and the generator splices it
    // into the model prompt (Phase 5).
    const renderFinding = (f) => {
      const remediation = f.remediation || {};
      const promptDelta = remediation.prompt_delta || '';
      const targetFields = Array.isArray(remediation.target_fields) ? remediation.target_fields.join(', ') : '';
      const scope = f.scope || '';
      const beatId = scope.startsWith('beat:') ? scope.slice('beat:'.length) : '';
      const isBeatRegen = !!beatId && remediation.action === 'regenerate_beat' && promptDelta.length > 0;

      let deltaBox = null;
      if (promptDelta) {
        deltaBox = el('div', {
          class: 'mt-1 p-1.5 bg-purple-50 border border-purple-200 rounded text-[11px] text-purple-900 cursor-pointer hover:bg-purple-100',
          title: 'Click to copy prompt delta'
        }, [
          el('div', { class: 'font-mono text-[9px] text-purple-700 mb-0.5' },
            `Action: ${remediation.action || '?'}${targetFields ? ` · fields: ${targetFields}` : ''}`),
          el('div', null, promptDelta)
        ]);
        deltaBox.addEventListener('click', () => {
          try {
            navigator.clipboard.writeText(promptDelta);
            if (typeof flashStatus === 'function') flashStatus('Prompt delta copied', false);
          } catch {}
        });
      }

      let regenBtn = null;
      if (isBeatRegen && activeStoryId && activeEpisodeId) {
        regenBtn = document.createElement('button');
        regenBtn.type = 'button';
        regenBtn.className = 'mt-1 px-2 py-1 text-[11px] font-medium text-white bg-purple-600 hover:bg-purple-700 rounded transition-colors';
        regenBtn.textContent = `Apply L3 nudge & regenerate beat ${beatId}`;
        regenBtn.addEventListener('click', async () => {
          regenBtn.disabled = true;
          regenBtn.textContent = 'Regenerating…';
          try {
            const resp = await fetch(
              `/api/brand-stories/${activeStoryId}/episodes/${activeEpisodeId}/beats/${beatId}/regenerate`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
                body: JSON.stringify({ directorNotes: promptDelta })
              }
            );
            const json = await resp.json().catch(() => ({}));
            if (!resp.ok || json.success === false) {
              flashStatus(`Regenerate failed: ${json.error || resp.statusText}`, true);
              regenBtn.disabled = false;
              regenBtn.textContent = `Retry: Apply L3 nudge & regenerate beat ${beatId}`;
              return;
            }
            flashStatus(`Regenerate started for ${beatId} — closing panel`, false);
            regenBtn.textContent = `Started — closing…`;
            // V4 hotfix 2026-05-01 — close the panel so the user sees the
            // episode card flip to the regenerating_beat in-progress badge
            // and the parent polling loop picks up live progress. Without
            // this the user is stuck staring at the panel with no signal
            // that anything is happening.
            if (typeof window.closeDirectorPanel === 'function') {
              setTimeout(() => window.closeDirectorPanel(), 600);
            }
          } catch (err) {
            flashStatus(`Regenerate error: ${err.message}`, true);
            regenBtn.disabled = false;
            regenBtn.textContent = `Retry: Apply L3 nudge & regenerate beat ${beatId}`;
          }
        });
      }

      return el('li', { class: 'text-xs text-ink-700 flex items-start gap-2' }, [
        severityBadge(f.severity),
        el('div', { class: 'flex-1' }, [
          el('div', { class: 'font-mono text-[10px] text-ink-400' }, `${f.scope || '?'} — ${f.id || '?'}`),
          el('div', null, f.message || ''),
          f.evidence ? el('div', { class: 'text-ink-500 italic mt-0.5' }, `Evidence: ${f.evidence}`) : null,
          deltaBox,
          regenBtn
        ])
      ]);
    };

    // Compact verdict-card renderer used for screenplay (Lens A) and episode (Lens D).
    const renderVerdictCard = (label, verdict) => {
      if (!verdict || typeof verdict !== 'object') return null;
      if (verdict.error) {
        return el('div', { class: 'mt-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700' },
          `${label} error: ${verdict.error}`
        );
      }
      const findings = Array.isArray(verdict.findings) ? verdict.findings : [];
      const commendations = Array.isArray(verdict.commendations) ? verdict.commendations : [];
      return el('div', { class: 'mt-3 p-2 bg-surface-50 border border-surface-200 rounded' }, [
        el('div', { class: 'flex items-center gap-2 mb-1' }, [
          el('div', { class: 'text-xs font-semibold text-ink-700' }, label),
          verdictBadge(verdict.verdict),
          scoreBadge(verdict.overall_score)
        ]),
        renderDimensionScores(verdict.dimension_scores),
        findings.length > 0
          ? el('div', { class: 'mt-2' }, [
              el('div', { class: 'text-[11px] font-medium text-ink-600 mb-1' }, `Findings (${findings.length})`),
              el('ul', { class: 'space-y-1' }, findings.map(renderFinding))
            ])
          : null,
        commendations.length > 0
          ? el('div', { class: 'mt-2' }, [
              el('div', { class: 'text-[11px] font-medium text-ink-600 mb-1' }, 'Commendations'),
              el('ul', { class: 'space-y-0.5 list-disc list-inside text-xs text-ink-700' },
                commendations.map(c => el('li', null, typeof c === 'string' ? c : (c?.description || JSON.stringify(c))))
              )
            ])
          : null
      ]);
    };

    // Per-scene / per-beat: condensed list of verdicts keyed by id.
    const renderKeyedVerdicts = (label, verdictMap) => {
      if (!verdictMap || typeof verdictMap !== 'object') return null;
      const entries = Object.entries(verdictMap);
      if (entries.length === 0) return null;
      return el('div', { class: 'mt-3' }, [
        el('div', { class: 'text-xs font-semibold text-ink-700 mb-1' }, `${label} (${entries.length})`),
        el('div', { class: 'space-y-2' }, entries.map(([id, v]) => {
          if (!v || v.error) {
            return el('div', { class: 'text-xs text-red-600' },
              `${id}: ${v?.error || 'no verdict'}`
            );
          }
          const findings = Array.isArray(v.findings) ? v.findings : [];
          const card = el('div', { class: 'p-2 bg-surface-50 border border-surface-200 rounded' }, [
            el('div', { class: 'flex items-center gap-2 mb-1' }, [
              el('span', { class: 'text-[11px] font-mono text-ink-700' }, id),
              verdictBadge(v.verdict),
              scoreBadge(v.overall_score)
            ]),
            renderDimensionScores(v.dimension_scores),
            findings.length > 0
              ? el('details', { class: 'mt-1' }, [
                  el('summary', { class: 'text-[11px] cursor-pointer text-ink-600 hover:text-ink-800' },
                    `${findings.length} finding${findings.length === 1 ? '' : 's'}`),
                  el('ul', { class: 'space-y-1 mt-1' }, findings.map(renderFinding))
                ])
              : null
          ]);
          return card;
        }))
      ]);
    };

    // ─── Compose the panel ───
    const screenplayCard = renderVerdictCard('Lens A — Table Read (post-screenplay)', report.screenplay);
    if (screenplayCard) node.appendChild(screenplayCard);

    const sceneVerdicts = renderKeyedVerdicts('Lens B — Look Dev Review (per scene)', report.scene_master);
    if (sceneVerdicts) node.appendChild(sceneVerdicts);

    const beatVerdicts = renderKeyedVerdicts('Lens C — Dailies (per beat)', report.beat);
    if (beatVerdicts) node.appendChild(beatVerdicts);

    const episodeCard = renderVerdictCard('Lens D — Picture Lock (advisory only)', report.episode);
    if (episodeCard) node.appendChild(episodeCard);

    if (report.screenplay_error) {
      node.appendChild(el('div', { class: 'mt-2 text-xs text-red-600' },
        `Lens A error (non-fatal): ${report.screenplay_error}`
      ));
    }

    // Empty-state if every key was empty/missing — already handled by the
    // top-level early return, but defensive against an object with only retries.
    if (!screenplayCard && !sceneVerdicts && !beatVerdicts && !episodeCard) {
      node.appendChild(el('div', { class: 'text-xs text-ink-400' },
        'Director Agent enabled but no verdicts emitted for this episode yet.'
      ));
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

    // 2026-05-05 — Aleph Rec 2 Phase 4: opt-in commercial enhancement.
    //   - Show button when: commercial episode, status='ready', post-LUT
    //     intermediate persisted, NO enhancement yet, not currently running
    //   - Show "running" pill when aleph_job_metadata.status='running'
    //   - Show "Cinema-grade ✓" pill when aleph_enhanced_video_url exists
    //   - Show "Identity drift" pill when status='failed_identity_gate'
    //     (with a tooltip: "original preserved, no charge")
    const isCommercial = !!(activeStory?.commercial_brief || ep.commercial_brief
      || (sceneDescription?.creative_concept && (activeStory?.story_focus === 'commercial' || activeStory?.genre === 'commercial')));
    const alephJob = ep.aleph_job_metadata || {};
    const alephEnhanced = !!ep.aleph_enhanced_video_url;
    const alephRunning = alephJob.status === 'running';
    const alephFailedGate = alephJob.status === 'failed_identity_gate';
    const alephFailedError = alephJob.status === 'failed_aleph_error';
    const showEnhanceButton = isCommercial
      && status === 'ready'
      && !!ep.post_lut_intermediate_url
      && !alephEnhanced
      && !alephRunning;

    const headerChildren = [
      el('h3', { class: 'text-lg font-bold text-ink-800 truncate flex-1' },
        `Director's Panel \u2014 ${sceneDescription.title || `Episode ${ep.episode_number || ''}`}`
      ),
      el('span', { class: 'px-2 py-0.5 text-[11px] rounded bg-brand-600 text-white font-mono' }, 'V4'),
      el('span', { class: 'px-2 py-0.5 text-[11px] rounded bg-purple-100 text-purple-700 font-mono' }, lutId),
      el('span', { class: 'px-2 py-0.5 text-[11px] rounded bg-surface-100 text-ink-700' }, `${totalBeats} beats`),
      el('span', { class: 'px-2 py-0.5 text-[11px] rounded bg-green-100 text-green-700' }, `~$${totalCost.toFixed(2)}`),
      el('span', {
        class: `px-2 py-0.5 text-[11px] rounded ${status === 'ready' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`
      }, status)
    ];

    if (alephEnhanced) {
      const score = alephJob.identity_lock_score
        ? `\u00A0\u00B7\u00A0identity ${alephJob.identity_lock_score}/100`
        : '';
      headerChildren.push(el('span', {
        class: 'px-2 py-0.5 text-[11px] rounded bg-amber-100 text-amber-800 font-medium',
        title: 'Cinema-grade Aleph enhancement ready. Toggle in the player below.'
      }, `\u2728 Cinema-grade${score}`));
    } else if (alephRunning) {
      headerChildren.push(el('span', {
        class: 'px-2 py-0.5 text-[11px] rounded bg-amber-100 text-amber-800 font-medium animate-pulse',
        title: 'Aleph stylization in progress. Watch the live progress feed below.'
      }, '\u2728 Enhancing\u2026'));
    } else if (alephFailedGate) {
      const score = alephJob.identity_lock_score
        ? `${alephJob.identity_lock_score}/100`
        : 'low';
      headerChildren.push(el('span', {
        class: 'px-2 py-0.5 text-[11px] rounded bg-orange-100 text-orange-800',
        title: `Identity drift detected (${score}). Original preserved. ${alephJob.billing_status === 'refunded' ? 'Charge refunded.' : 'No charge.'}`
      }, '\u2728 Identity drift \u2014 original preserved'));
    } else if (alephFailedError) {
      headerChildren.push(el('span', {
        class: 'px-2 py-0.5 text-[11px] rounded bg-red-100 text-red-700',
        title: `Aleph error: ${alephJob.error_message || 'unknown'}`
      }, '\u2728 Enhancement failed'));
    }

    if (showEnhanceButton) {
      headerChildren.push(el('button', {
        class: 'px-3 py-1 text-xs bg-amber-500 text-white rounded hover:bg-amber-600 font-medium',
        title: 'Apply Runway Aleph cinema-grade stylization. Free during testing phase.',
        onclick: () => window._dpEnhanceWithAleph()
      }, '\u2728 Enhance with Aleph'));
    }

    headerChildren.push(el('button', {
      class: 'px-3 py-1 text-xs bg-white border border-surface-300 text-ink-700 rounded hover:bg-surface-50',
      onclick: () => window._dpReassemble()
    }, 'Reassemble'));

    headerChildren.push(el('button', {
      class: 'px-3 py-1 text-xs bg-surface-100 text-ink-700 rounded hover:bg-surface-200',
      onclick: () => window.closeDirectorPanel()
    }, 'Close'));

    const row = el('div', { class: 'flex items-center gap-3 flex-wrap' }, headerChildren);
    node.appendChild(row);
  }

  // V4 P0.5 — Director Review Resolution halt banner.
  //
  // When episode.status === 'awaiting_user_review', surface a yellow
  // warning banner at the top of the panel showing:
  //   • the halted checkpoint + artifact id (scene_id / beat_id)
  //   • verdict score + verdict kind
  //   • findings drilldown (severity / message / dimension)
  //   • three CTAs: Approve / Edit & Retry / Discard
  //
  // SECURITY: every dynamic value uses textContent or el() with text children
  // — no innerHTML on user-controlled data per the file's security contract.
  function renderHaltBanner() {
    const node = document.getElementById('dpHaltBanner');
    if (!node) return;
    clear(node);

    const ep = activeEpisode || {};
    if (ep.status !== 'awaiting_user_review') {
      // Banner only shows on halted episodes — leave the slot empty otherwise.
      return;
    }

    const dr = ep.director_report || {};
    const halt = dr.halt || {};
    const checkpoint = halt.checkpoint || 'unknown';
    const artifactId = halt.scene_id || halt.beat_id || halt.artifactKey || null;
    const verdict = halt.verdict || null;
    const score = (verdict && Number.isFinite(verdict.overall_score)) ? verdict.overall_score : null;
    const kind = verdict?.verdict || null;
    const findings = Array.isArray(verdict?.findings) ? verdict.findings : [];

    // Headline row — checkpoint + artifact + score
    const headlineParts = [
      el('span', { class: 'text-base' }, '\u26A0\uFE0F'),  // ⚠️
      el('span', { class: 'font-semibold' }, 'Director paused for your review')
    ];
    if (checkpoint) {
      headlineParts.push(el('span', { class: 'text-yellow-800/70 text-xs' }, '\u00A0\u2014\u00A0'));
      headlineParts.push(el('span', { class: 'font-mono text-xs px-1.5 py-0.5 rounded bg-yellow-200/60 text-yellow-900' },
        `Lens ${checkpoint}`));
    }
    if (artifactId) {
      headlineParts.push(el('span', { class: 'font-mono text-xs px-1.5 py-0.5 rounded bg-yellow-200/60 text-yellow-900 ml-1' },
        artifactId));
    }
    if (score != null) {
      headlineParts.push(el('span', { class: 'text-xs px-1.5 py-0.5 rounded bg-yellow-300/60 text-yellow-900 ml-1' },
        `score ${score}`));
    }
    if (kind) {
      headlineParts.push(el('span', { class: 'text-xs px-1.5 py-0.5 rounded bg-yellow-300/60 text-yellow-900 ml-1' },
        kind));
    }
    const headline = el('div', { class: 'flex items-center gap-2 flex-wrap mb-2' }, headlineParts);

    // Reason line (if any)
    const reasonLine = halt.reason
      ? el('div', { class: 'text-xs text-yellow-900/80 mb-2' }, halt.reason)
      : null;

    // Findings drilldown — collapsible
    const findingsItems = findings.map((f) => {
      const sev = String(f?.severity || '').toLowerCase();
      const sevColor =
        sev === 'critical' ? 'bg-red-100 text-red-800' :
        sev === 'warning'  ? 'bg-yellow-100 text-yellow-800' :
        'bg-surface-100 text-ink-700';
      return el('li', { class: 'flex items-start gap-2 text-xs py-1' }, [
        el('span', { class: `font-mono px-1.5 py-0.5 rounded ${sevColor} flex-shrink-0` }, sev || 'note'),
        el('div', { class: 'flex-1 min-w-0' }, [
          el('div', { class: 'text-ink-800' }, f?.message || '(no message)'),
          f?.dimension
            ? el('div', { class: 'text-[11px] text-ink-500 mt-0.5' }, `dim: ${f.dimension}`)
            : null,
          f?.remediation?.prompt_delta
            ? el('div', { class: 'text-[11px] text-ink-600 mt-0.5 italic' }, `\u2192 ${f.remediation.prompt_delta}`)
            : null
        ].filter(Boolean))
      ]);
    });
    const findingsList = findings.length > 0
      ? el('details', { class: 'mb-2 border border-yellow-300/50 rounded bg-white/40' }, [
          el('summary', { class: 'cursor-pointer text-xs font-medium px-2 py-1 text-yellow-900' },
            `${findings.length} finding(s) \u2014 click to expand`),
          el('ul', { class: 'px-3 py-1' }, findingsItems)
        ])
      : null;

    // Action CTAs
    const ctaRow = el('div', { class: 'flex items-center gap-2 flex-wrap' }, [
      el('button', {
        class: 'px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded hover:bg-green-700',
        onclick: () => _dpResolveHalt('approve')
      }, 'Approve & Continue'),
      el('button', {
        class: 'px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700',
        onclick: () => _dpResolveHalt('edit_and_retry')
      }, 'Edit & Retry'),
      el('button', {
        class: 'px-3 py-1.5 text-xs font-medium bg-red-600 text-white rounded hover:bg-red-700',
        onclick: () => _dpResolveHalt('discard')
      }, 'Discard')
    ]);

    const banner = el('div', {
      class: 'bg-yellow-50 border-b-2 border-yellow-400 px-5 py-3'
    }, [headline, reasonLine, findingsList, ctaRow].filter(Boolean));

    node.appendChild(banner);
  }

  // V4 P0.5 — handle the user's halt resolution decision.
  // V4 hotfix 2026-04-30 — Smart Edit & Retry: instead of prompting the user
  // for free-form notes (which they don't have directing knowledge to write),
  // we POST to the new /director-review/auto-edit endpoint which synthesizes
  // a director-grade edit directive from the verdict findings + failed
  // artifact content. The user sees the synthesized directive in a confirm
  // modal and can apply it (or cancel + edit by hand if they want).
  async function _dpResolveHalt(action) {
    if (!activeEpisodeId || !activeStoryId) return;

    let notes = null;
    let editedAnchor = null;
    let editedDialogue = null;

    if (action === 'edit_and_retry') {
      // Step 1 — fetch the auto-synthesized edit directive.
      flashStatus('Synthesizing director-grade edit directive…', false);
      let auto;
      try {
        const autoRes = await fetch(
          `/api/brand-stories/${encodeURIComponent(activeStoryId)}/episodes/${encodeURIComponent(activeEpisodeId)}/director-review/auto-edit`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
            body: '{}'
          }
        );
        auto = await autoRes.json().catch(() => ({}));
        if (!autoRes.ok || !auto?.success) {
          flashStatus(auto?.error || `Auto-edit synthesis failed (${autoRes.status})`, true);
          return;
        }
      } catch (err) {
        flashStatus(err?.message || 'Network error during auto-edit synthesis', true);
        return;
      }

      // Step 2 — show the synthesized directive in a confirm dialog.
      // V4 hotfix 2026-05-06 — surface SmartSynth's new fields:
      //   - diagnosis: 1-2 sentence plain-language explanation of what went wrong
      //   - source_detail: 'multimodal_rich' | 'text_rich' | 'cheap_concat'
      //     (multimodal means the synth saw the rejected image vs. text-only)
      //   - regression_warning: prior attempts have been declining → conservative
      //   - prior_attempt_count: how many directives have already been tried
      //   - reference_image_count: persona/scene refs the synth had access to
      const summary = auto.halt_summary || {};
      const sourceLabel = auto.source_detail === 'multimodal_rich'
        ? '🖼️ Multimodal (synth SAW the rejected image + reference images)'
        : auto.source_detail === 'text_rich'
        ? '📝 Text-rich (synth received verdict + context, no image)'
        : '⚙️ Cheap concat (Gemini fallback)';
      const refTag = auto.reference_image_count > 0 ? ` · ${auto.reference_image_count} ref images` : '';
      const priorTag = auto.prior_attempt_count > 0 ? ` · ${auto.prior_attempt_count} prior attempt(s)` : '';
      const confTag = auto.confidence != null ? ` · synth confidence ${(auto.confidence * 100).toFixed(0)}%` : '';
      const confirmMsg = [
        `Smart Edit & Retry — ${sourceLabel}${refTag}${priorTag}${confTag}`,
        '',
        `Halt: Lens ${summary.checkpoint || '?'}${summary.artifact_id ? ` · ${summary.artifact_id}` : ''}${summary.verdict_score != null ? ` · score ${summary.verdict_score}` : ''} · ${summary.finding_count || 0} finding(s)`,
        '',
        auto.diagnosis ? `🔍 Synth diagnosis:\n${auto.diagnosis}\n` : '',
        auto.regression_warning
          ? '⚠️ REGRESSION WARNING — prior attempts have been scoring LOWER each time. Synth has switched to conservative mode (single-target directive). Consider editing the directive yourself or trying a different angle.\n'
          : '',
        'The system will splice this directive into the next render nudge:',
        '',
        '──────────────────────────',
        auto.notes || '(no directive synthesized)',
        '──────────────────────────',
        auto.edited_anchor ? '\n[Scene anchor will be replaced with the synthesized override.]' : '',
        auto.edited_dialogue ? '\n[Beat dialogue will be replaced with the synthesized override.]' : '',
        '',
        'Click OK to apply and re-trigger generation. Cancel to back out.'
      ].filter(Boolean).join('\n');

      const confirmed = window.confirm(confirmMsg);
      if (!confirmed) return;

      notes = auto.notes || null;
      editedAnchor = auto.edited_anchor || null;
      editedDialogue = auto.edited_dialogue || null;
    } else if (action === 'discard') {
      const confirmed = window.confirm(
        'Discard this episode? This marks it as failed and cannot be undone (you can re-trigger generation afterwards).'
      );
      if (!confirmed) return;
      notes = window.prompt('Optional reason for discard (recorded in audit trail):', '') || null;
    } else if (action === 'approve') {
      // V4 hotfix 2026-05-06 — Approve at a no-video halt now resumes the
      // pipeline (skips Director critique on the approved artifact, continues
      // to beats + post-production + Lens D + ship). Previously it just
      // marked the episode failed, which was confusing UX.
      const ep = activeEpisode || {};
      const dr = ep.director_report || {};
      const halt = dr.halt || {};
      const haltCheckpoint = halt.checkpoint || 'unknown';
      if (!ep.final_video_url) {
        // Lens B is the only no-video checkpoint with full approve-and-resume
        // support today; Lens A / Lens C still record-and-fail.
        if (haltCheckpoint === 'scene_master') {
          const proceed = window.confirm(
            `Approve & Continue at Lens B halt:\n\n` +
            `The system will trust the existing scene_master for "${halt.scene_id || 'this scene'}" ` +
            `(skipping further Director critique on it) and resume the pipeline forward — ` +
            `beats → post-production → final assembly → ship.\n\n` +
            `OK to proceed?`
          );
          if (!proceed) return;
        } else {
          const proceed = window.confirm(
            `Approve at Lens ${haltCheckpoint} is not yet supported as a resume action ` +
            `(only Lens B scene_master halts can approve-and-resume). ` +
            `This will mark the episode failed; use Edit & Retry instead, or re-trigger generation.\n\n` +
            `Continue anyway?`
          );
          if (!proceed) return;
        }
      }
    }

    try {
      const res = await fetch(
        `/api/brand-stories/${encodeURIComponent(activeStoryId)}/episodes/${encodeURIComponent(activeEpisodeId)}/director-review`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf()
          },
          body: JSON.stringify({
            action,
            notes,
            edited_anchor: editedAnchor,
            edited_dialogue: editedDialogue
          })
        }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.success) {
        flashStatus(body?.error || `Resolution failed (${res.status})`, true);
        return;
      }
      flashStatus(body.message || 'Halt resolved', false);

      // V4 hotfix 2026-05-01 — once the halt is resolved (approve / edit_and_retry / discard),
      // close the panel and let the parent brand-stories detail view take over.
      // closeDirectorPanel() refreshes the story detail, which auto-resumes
      // polling for any in-progress episode (regenerating_beat is a
      // recognized in-progress status). The user sees the panel disappear,
      // the episode card flip to the in-progress badge, and the spinner
      // re-engage — same UX as the initial Generate flow.
      if (action === 'edit_and_retry' || action === 'approve' || action === 'discard') {
        if (typeof window.closeDirectorPanel === 'function') {
          window.closeDirectorPanel();
          return;
        }
      }

      // Fallback (defense-in-depth): if the close helper is missing, at
      // least re-fetch the episode and re-render the banner.
      const refreshed = await fetch(
        `/api/brand-stories/${encodeURIComponent(activeStoryId)}/episodes/${encodeURIComponent(activeEpisodeId)}`,
        { credentials: 'include' }
      ).then(r => r.json()).catch(() => null);
      if (refreshed?.episode) {
        activeEpisode = refreshed.episode;
        renderHaltBanner();
        renderHeader();
      }
    } catch (err) {
      flashStatus(err?.message || 'Network error resolving halt', true);
    }
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
    // V4 Phase 3 — framing vocabulary (read-only badge; editor surfaces it below)
    if (beat.framing) badges.push(chip('framing', beat.framing));
    // V4 Phase 2 keystone — persona lock status (green when Seedream pre-frame
    // ran, amber when persona-featuring beat skipped the pre-pass)
    if (beat.persona_locked_first_frame_url) {
      badges.push(chip('persona lock', 'on', 'strong'));
    } else if (beat.persona_lock_error) {
      badges.push(chip('persona lock', 'failed', 'warn'));
    }
    // V4 Phase 1.1 — subject mandate flag
    if (beat.subject_present === true) badges.push(chip('subject', 'on screen', 'strong'));
    // V4 Phase 8 — quality gate report
    if (beat.quality_gate && !beat.quality_gate.passed) {
      badges.push(chip('QC', 'failed', 'warn'));
    } else if (beat.quality_gate && Array.isArray(beat.quality_gate.issues) && beat.quality_gate.issues.length > 0) {
      badges.push(chip('QC', `${beat.quality_gate.issues.length} warning`, 'warn'));
    }
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

    // V4 Phase 3.2 / 5.3 / 7 — structured overrides. These four dropdowns
    // give the human director locked, non-improvised control over the shot
    // recipe without having to write prompt prose.
    //
    // `framing`           → maps to the Cinematic Framing Vocabulary
    // `preferred_generator` → per-beat model override (Phase 5.3)
    // `subject_present`   → subject mandate toggle (Phase 1.1)
    // `personas_present`  → comma-separated persona index override (Phase 2)
    const addSelect = (name, label, options, current) => {
      const sel = document.createElement('select');
      sel.name = name;
      sel.className = 'w-full text-sm p-2 border border-surface-300 rounded';
      for (const opt of options) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        if (String(opt.value) === String(current || '')) o.selected = true;
        sel.appendChild(o);
      }
      form.appendChild(el('div', null, [
        el('label', { class: 'text-xs font-medium text-ink-600' }, label),
        sel
      ]));
    };

    addSelect('framing', 'Framing (cinematic vocabulary)', [
      { value: '', label: '— default for beat type —' },
      { value: 'wide_establishing', label: 'wide_establishing (24-35mm, reveal)' },
      { value: 'medium_two_shot', label: 'medium_two_shot (35-50mm)' },
      { value: 'over_shoulder', label: 'over_shoulder (50-85mm)' },
      { value: 'tight_closeup', label: 'tight_closeup (85-100mm)' },
      { value: 'macro_insert', label: 'macro_insert (100mm+ held macro)' },
      { value: 'tracking_push', label: 'tracking_push (kinetic)' },
      { value: 'bridge_transit', label: 'bridge_transit (scene connector)' }
    ], beat.framing);

    addSelect('preferred_generator', 'Generator override (advanced)', [
      { value: '', label: '— auto-route by beat type —' },
      { value: 'CinematicDialogueGenerator', label: 'CinematicDialogueGenerator (Kling O3 + Sync)' },
      { value: 'GroupTwoShotGenerator', label: 'GroupTwoShotGenerator' },
      { value: 'SilentStareGenerator', label: 'SilentStareGenerator (Kling)' },
      { value: 'ReactionGenerator', label: 'ReactionGenerator (Veo)' },
      { value: 'InsertShotGenerator', label: 'InsertShotGenerator (Veo)' },
      { value: 'ActionGenerator', label: 'ActionGenerator (Kling V3 Pro)' },
      { value: 'BRollGenerator', label: 'BRollGenerator (Veo)' },
      { value: 'VoiceoverBRollGenerator', label: 'VoiceoverBRollGenerator (Veo + TTS)' }
    ], beat.preferred_generator);

    const subjectWrap = el('div', { class: 'flex items-center gap-2' });
    const subjChk = document.createElement('input');
    subjChk.type = 'checkbox';
    subjChk.name = 'subject_present';
    subjChk.checked = beat.subject_present === true;
    subjectWrap.appendChild(subjChk);
    subjectWrap.appendChild(el('label', { class: 'text-xs font-medium text-ink-600' }, 'Subject present (product/landscape on screen)'));
    form.appendChild(subjectWrap);

    const grid = el('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-2' });
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
    // Voice-lock map: which voice_ids are already taken by OTHER personas in
    // this story. Mirrors the backend lock enforced by PATCH /personas/:idx/voice
    // — see routes/brand-stories.js. Showing taken voices as disabled (vs
    // hiding them entirely) lets the user see who has what.
    const voiceTakenBy = new Map(); // voice_id → { personaIdx, personaName }
    personas.forEach((other, j) => {
      if (other?.elevenlabs_voice_id) {
        voiceTakenBy.set(other.elevenlabs_voice_id, {
          personaIdx: j,
          personaName: other.name || `Persona ${j + 1}`
        });
      }
    });

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
        // Lock-aware label: voice taken by ANOTHER persona is disabled and
        // labeled with that persona's name. The current persona's own voice
        // shows normally and stays selectable.
        const takenInfo = voiceTakenBy.get(v.voice_id);
        const takenByOther = takenInfo && takenInfo.personaIdx !== i;
        if (takenByOther) {
          opt.disabled = true;
          opt.textContent = `${v.name} (${v.gender}) — locked to ${takenInfo.personaName}`;
        } else {
          opt.textContent = `${v.name} (${v.gender})`;
        }
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

  // ─────────────────────────────────────────────────────────────────────
  // Phase 7 — Sound design panel: Sonic Series Bible (story-level) +
  // episode sonic_world (palette + spectral_anchor + scene_variations).
  //
  // All fields rendered via textContent through el() — no innerHTML with
  // dynamic data (XSS-safe pattern shared by every other render in this file).
  // ─────────────────────────────────────────────────────────────────────
  function renderSoundPanel() {
    const node = document.getElementById('dpSoundPanel');
    if (!node) return;
    clear(node);

    // ─── Sonic Series Bible (story-level) ───
    const bibleSection = el('section', { class: 'mb-6 pb-4 border-b border-surface-200' });
    bibleSection.appendChild(el('h5', { class: 'text-xs font-semibold text-ink-700 mb-2 flex items-center gap-2' }, [
      'Sonic Series Bible',
      el('span', { class: 'text-[10px] font-mono px-1.5 py-0.5 bg-ink-100 text-ink-600 rounded' }, 'STORY-LEVEL')
    ]));

    const bible = activeStory?.sonic_series_bible;
    if (!bible || typeof bible !== 'object') {
      bibleSection.appendChild(el('div', { class: 'text-xs text-ink-500 italic' },
        'No bible authored yet — will be generated on the next episode (lazy + idempotent, mirrors LUT pattern).'
      ));
    } else {
      const drone = bible.signature_drone || {};
      const palette = bible.base_palette || {};
      const anchor = bible.spectral_anchor || {};
      const policy = bible.inheritance_policy || {};
      const generatedBy = bible._generated_by || 'gemini';

      const provBadgeClass = generatedBy === 'manual_override'
        ? 'text-[10px] font-mono px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded border border-amber-200'
        : generatedBy === 'default_fallback'
          ? 'text-[10px] font-mono px-1.5 py-0.5 bg-ink-100 text-ink-600 rounded border border-ink-200'
          : 'text-[10px] font-mono px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded border border-emerald-200';
      bibleSection.appendChild(el('div', { class: 'mb-2' },
        el('span', { class: provBadgeClass }, generatedBy)
      ));

      const grid = el('div', { class: 'space-y-2 text-xs' });

      // PALETTE
      grid.appendChild(el('div', {}, [
        el('div', { class: 'font-semibold text-ink-700' }, 'Signature drone'),
        el('div', { class: 'text-ink-600' }, drone.description || '—'),
        el('div', { class: 'text-ink-500 font-mono mt-0.5' },
          `${(drone.frequency_band_hz || []).join('–') || '—'} Hz · presence ${drone.presence_dB ?? '—'} dB`
        )
      ]));

      grid.appendChild(el('div', {}, [
        el('div', { class: 'font-semibold text-ink-700' }, 'Base palette'),
        el('div', { class: 'text-ink-600' }, (palette.ambient_keywords || []).join(', ') || '—'),
        el('div', { class: 'text-ink-500 font-mono mt-0.5' },
          `BPM ${(palette.bpm_range || []).join('–') || '—'} · ${palette.key_or_modal_center || '—'}`
        )
      ]));

      grid.appendChild(el('div', {}, [
        el('div', { class: 'font-semibold text-ink-700' }, 'Spectral anchor (seam-hider)'),
        el('div', { class: 'text-ink-600' }, anchor.description || '—'),
        el('div', { class: 'text-ink-500 font-mono mt-0.5' },
          `${anchor.always_present === true ? 'always present' : 'NOT always present'} · ${anchor.level_dB ?? '—'} dB`
        )
      ]));

      // GRAMMAR
      grid.appendChild(el('div', { class: 'pt-2 border-t border-surface-100' }, [
        el('div', { class: 'font-semibold text-ink-700 mb-1' }, 'Grammar'),
        el('div', { class: 'text-ink-600' },
          `Foley: ${bible.foley_density || '—'} · Score under dialogue: ${bible.score_under_dialogue || '—'} · Silence: ${bible.silence_as_punctuation || '—'} · Diegetic: ${typeof bible.diegetic_ratio === 'number' ? bible.diegetic_ratio.toFixed(2) : '—'}`
        ),
        el('div', { class: 'text-ink-500 mt-0.5' },
          `Transitions: ${(bible.transition_grammar || []).join(', ') || '—'}`
        )
      ]));

      // NO-FLY
      grid.appendChild(el('div', { class: 'pt-2 border-t border-surface-100' }, [
        el('div', { class: 'font-semibold text-ink-700 mb-1' }, 'No-fly list'),
        el('div', { class: 'text-ink-600' },
          `Instruments: ${(bible.prohibited_instruments || []).join(', ') || 'none'}`
        ),
        el('div', { class: 'text-ink-600' },
          `Tropes: ${(bible.prohibited_tropes || []).join(', ') || 'none'}`
        )
      ]));

      // INHERITANCE POLICY
      grid.appendChild(el('div', { class: 'pt-2 border-t border-surface-100' }, [
        el('div', { class: 'font-semibold text-ink-700 mb-1' }, 'Inheritance policy'),
        el('div', { class: 'text-ink-500 font-mono text-[11px]' },
          `grammar=${policy.grammar || 'immutable'} · no_fly=${policy.no_fly_list || 'immutable'} · base=${policy.base_palette || 'overridable_with_justification'} · drone=${policy.signature_drone || 'must_appear_at_least_once_per_episode'}`
        )
      ]));

      // REFERENCE SHOWS
      if (Array.isArray(bible.reference_shows) && bible.reference_shows.length > 0) {
        grid.appendChild(el('div', { class: 'pt-2 border-t border-surface-100' }, [
          el('div', { class: 'font-semibold text-ink-700 mb-1' }, 'Reference shows'),
          el('div', { class: 'text-ink-600' }, bible.reference_shows.join(', ')),
          bible.reference_rationale ? el('div', { class: 'text-ink-500 italic mt-0.5' }, bible.reference_rationale) : null
        ].filter(Boolean)));
      }

      bibleSection.appendChild(grid);

      // Regenerate button — clears the bible so the next episode call regenerates
      const regenBtn = el('button', {
        type: 'button',
        class: 'mt-3 text-xs px-2.5 py-1 border border-surface-300 rounded text-ink-600 hover:bg-surface-50',
        onclick: () => window._dpRegenerateSonicBible()
      }, 'Clear & regenerate on next episode');
      bibleSection.appendChild(regenBtn);
    }

    node.appendChild(bibleSection);

    // ─── Episode sonic_world ───
    const epSection = el('section', { class: 'mb-4' });
    epSection.appendChild(el('h5', { class: 'text-xs font-semibold text-ink-700 mb-2 flex items-center gap-2' }, [
      'Episode sound world',
      el('span', { class: 'text-[10px] font-mono px-1.5 py-0.5 bg-ink-100 text-ink-600 rounded' }, 'EPISODE-LEVEL')
    ]));

    const sw = activeEpisode?.scene_description?.sonic_world;
    if (!sw || typeof sw !== 'object') {
      // Check for legacy per-scene beds
      const legacyBeds = (activeEpisode?.scene_description?.scenes || [])
        .map(s => s?.ambient_bed_prompt)
        .filter(Boolean);
      if (legacyBeds.length > 0) {
        epSection.appendChild(el('div', { class: 'text-xs text-amber-700 mb-1' },
          `Legacy episode — ${legacyBeds.length} per-scene bed(s) (Phase 4 backward-compat synthesizes a base palette from these at post-production).`
        ));
        legacyBeds.forEach(b => epSection.appendChild(el('div', { class: 'text-[11px] text-ink-500 font-mono pl-2' }, `· ${b}`)));
      } else {
        epSection.appendChild(el('div', { class: 'text-xs text-ink-500 italic' },
          'No sonic_world on this episode.'
        ));
      }
    } else {
      const scenes = activeEpisode?.scene_description?.scenes || [];
      const scenesById = new Map(scenes.map(s => [s.scene_id, s]));

      const grid = el('div', { class: 'space-y-2 text-xs' });
      grid.appendChild(el('div', {}, [
        el('div', { class: 'font-semibold text-ink-700' }, 'Base palette (uncut, episode-length)'),
        el('div', { class: 'text-ink-600' }, sw.base_palette || '—')
      ]));
      grid.appendChild(el('div', {}, [
        el('div', { class: 'font-semibold text-ink-700' }, 'Spectral anchor'),
        el('div', { class: 'text-ink-600' },
          typeof sw.spectral_anchor === 'string' ? sw.spectral_anchor : (sw.spectral_anchor?.description || '—')
        )
      ]));

      const overlays = Array.isArray(sw.scene_variations) ? sw.scene_variations : [];
      grid.appendChild(el('div', { class: 'pt-2 border-t border-surface-100' }, [
        el('div', { class: 'font-semibold text-ink-700 mb-1' }, `Scene overlays (${overlays.length})`),
        ...(overlays.length === 0
          ? [el('div', { class: 'text-ink-500 italic' }, 'No per-scene overlays — base palette plays alone.')]
          : overlays.map(v => {
              const known = scenesById.has(v.scene_id);
              return el('div', { class: 'pl-2 border-l-2 border-surface-200 mb-1' }, [
                el('div', { class: 'text-ink-700 font-mono text-[11px]' },
                  `${v.scene_id || '?'} · intensity ${typeof v.intensity === 'number' ? v.intensity.toFixed(2) : '—'}${known ? '' : ' (UNKNOWN scene_id)'}`
                ),
                el('div', { class: 'text-ink-600' }, v.overlay || '—')
              ]);
            }))
      ]));

      epSection.appendChild(grid);
    }

    node.appendChild(epSection);

    // ─── Foley discipline note ───
    node.appendChild(el('div', { class: 'mt-4 pt-3 border-t border-surface-200 text-[11px] text-ink-500' }, [
      el('div', { class: 'font-semibold text-ink-700 mb-1' }, 'Per-beat ambient_sound discipline (Phase 5)'),
      el('div', {}, 'Beat-level ambient_sound is FOLEY EVENTS only (1-3s percussive: door click, glass clink, fabric rustle). Bed material (ambient/drone/atmosphere/room tone) is rejected at SFX-call time and belongs in sonic_world above.')
    ]));
  }

  // Phase 7 — clear the bible on the server so the next episode regenerates.
  // Mirrors the lut clear pattern (PATCH with null body).
  window._dpRegenerateSonicBible = async function () {
    if (!activeStoryId) return;
    if (!confirm('Clear the Sonic Series Bible? The next episode will regenerate it from scratch.')) return;
    try {
      const resp = await fetch(`/api/brand-stories/${activeStoryId}/sonic-series-bible`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify({ bible: null })
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'Clear failed');
      if (activeStory) activeStory.sonic_series_bible = null;
      renderSoundPanel();
      flashStatus('Bible cleared — next episode will regenerate it');
    } catch (err) {
      flashStatus(`Clear failed: ${err.message}`, true);
    }
  };

  // ─────────────────────────────────────────────────────────────────────
  // Cast Bible Phase 4 — Casting Room
  //
  // Mirrors the Sonic Series Bible's SOUND tab pattern. Renders story-level
  // cast_bible.principals[] with:
  //   - persona index badge + name (read-only at this phase)
  //   - role chip
  //   - gender chip — green (explicit/persona_signal), amber (storyline_signal),
  //     red (unknown). Click to open gender override dropdown.
  //   - voice dropdown (lock-aware via voiceTakenBy from renderPersonasSidebar
  //     pattern — disables options taken by OTHER principals)
  //   - voice mismatch chip — red when voice_gender_match === false. Click to
  //     open the re-acquisition confirmation dialog.
  //
  // All field rendering goes through el() — no innerHTML with dynamic data
  // (XSS-safe pattern shared by every render in this file).
  // ─────────────────────────────────────────────────────────────────────
  function renderCastingPanel() {
    const node = document.getElementById('dpCastingPanel');
    if (!node) return;
    clear(node);

    const bible = activeStory?.cast_bible;
    const personas = activeStory?.persona_config?.personas
      || (activeStory?.persona_config ? [activeStory.persona_config] : []);

    // Header: provenance badge + lock status + actions
    const headerSection = el('section', { class: 'mb-4 pb-3 border-b border-surface-200' });
    headerSection.appendChild(el('h5', { class: 'text-xs font-semibold text-ink-700 mb-2 flex items-center gap-2' }, [
      'Cast Bible',
      el('span', { class: 'text-[10px] font-mono px-1.5 py-0.5 bg-ink-100 text-ink-600 rounded' }, 'STORY-LEVEL')
    ]));

    if (!bible || typeof bible !== 'object' || !Array.isArray(bible.principals) || bible.principals.length === 0) {
      headerSection.appendChild(el('div', { class: 'text-xs text-ink-500 italic' },
        'No cast bible derived yet — will be created on the next episode generation (lazy + idempotent, derived from storyline.characters[] + persona_config.personas[]).'
      ));
      node.appendChild(headerSection);
      return;
    }

    const generatedBy = bible._generated_by || 'derived_from_storyline';
    const status = bible.status || 'derived';
    const isLocked = status === 'locked';

    const provBadgeClass = isLocked
      ? 'text-[10px] font-mono px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded border border-emerald-200'
      : generatedBy === 'manual_override'
        ? 'text-[10px] font-mono px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded border border-amber-200'
        : 'text-[10px] font-mono px-1.5 py-0.5 bg-ink-100 text-ink-600 rounded border border-ink-200';

    headerSection.appendChild(el('div', { class: 'mb-2 flex items-center gap-2 flex-wrap' }, [
      el('span', { class: provBadgeClass }, isLocked ? `🔒 locked (${generatedBy})` : generatedBy),
      el('span', { class: 'text-[10px] font-mono text-ink-500' },
        `${bible.principals.length} principal${bible.principals.length === 1 ? '' : 's'}`
      )
    ]));

    // Action buttons row
    const actions = el('div', { class: 'flex items-center gap-2 flex-wrap' });
    if (!isLocked) {
      actions.appendChild(el('button', {
        type: 'button',
        class: 'text-xs px-2.5 py-1 border border-emerald-300 rounded text-emerald-700 hover:bg-emerald-50',
        onclick: () => window._dpLockCastBible()
      }, 'Lock cast'));
    } else {
      actions.appendChild(el('span', { class: 'text-[11px] text-ink-500 italic' },
        'Cast is locked — clear to make structural changes.'
      ));
    }
    actions.appendChild(el('button', {
      type: 'button',
      class: 'text-xs px-2.5 py-1 border border-surface-300 rounded text-ink-600 hover:bg-surface-50',
      onclick: () => window._dpResetCastBible()
    }, isLocked ? 'Unlock & re-derive' : 'Reset & re-derive'));
    headerSection.appendChild(actions);
    node.appendChild(headerSection);

    // Voice-lock map — same pattern as renderPersonasSidebar at lines 1158-1200
    const voiceTakenBy = new Map();
    personas.forEach((other, j) => {
      if (other?.elevenlabs_voice_id) {
        voiceTakenBy.set(other.elevenlabs_voice_id, {
          personaIdx: j,
          personaName: other.name || `Persona ${j + 1}`
        });
      }
    });

    // Principals list
    const principalsSection = el('section', { class: 'space-y-3' });
    bible.principals.forEach((p, i) => {
      principalsSection.appendChild(_renderPrincipalCard(p, i, personas, voiceTakenBy, isLocked));
    });
    node.appendChild(principalsSection);
  }

  // Helper: render a single principal card. Extracted so the tab function
  // stays readable.
  function _renderPrincipalCard(principal, displayIdx, personas, voiceTakenBy, isLocked) {
    const personaIdx = principal.persona_index;
    const persona = personas[personaIdx] || {};

    const card = el('div', { class: 'p-3 border border-surface-200 rounded' });

    // Top row: persona index badge + name + role + lock indicator
    const topRow = el('div', { class: 'flex items-center gap-2 mb-2 flex-wrap' });
    topRow.appendChild(el('div', {
      class: 'flex-shrink-0 w-7 h-7 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center text-xs font-bold'
    }, String(personaIdx + 1)));
    topRow.appendChild(el('div', { class: 'text-sm font-medium text-ink-800 flex-1 min-w-0 truncate' },
      principal.name || `Persona ${personaIdx + 1}`
    ));
    if (principal.role) {
      topRow.appendChild(el('span', {
        class: 'text-[10px] font-mono px-1.5 py-0.5 bg-surface-100 text-ink-600 rounded'
      }, principal.role));
    }
    card.appendChild(topRow);

    // Phase 3.5 — Gender chip + override
    const genderRow = el('div', { class: 'flex items-center gap-2 mb-2 flex-wrap' });
    genderRow.appendChild(el('span', { class: 'text-[11px] text-ink-500' }, 'Gender:'));

    const inferredGender = principal.gender_inferred || 'unknown';
    const resolvedFrom = principal.gender_resolved_from || 'unknown';

    let genderChipClass;
    let genderChipText;
    if (resolvedFrom === 'persona_explicit' || resolvedFrom === 'persona_signal') {
      genderChipClass = 'text-[10px] font-mono px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded border border-emerald-200';
      genderChipText = `${inferredGender} (${resolvedFrom === 'persona_explicit' ? 'explicit' : 'inferred'})`;
    } else if (resolvedFrom === 'storyline_signal') {
      genderChipClass = 'text-[10px] font-mono px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded border border-amber-200';
      genderChipText = `${inferredGender} (storyline)`;
    } else {
      genderChipClass = 'text-[10px] font-mono px-1.5 py-0.5 bg-red-100 text-red-700 rounded border border-red-200';
      genderChipText = 'unknown — set explicitly';
    }
    genderRow.appendChild(el('span', { class: genderChipClass }, genderChipText));

    // Override dropdown — always shown unless locked
    if (!isLocked) {
      const genderSelect = document.createElement('select');
      genderSelect.className = 'text-xs border border-surface-300 rounded px-1 py-0.5 ml-auto';
      const options = [
        { value: '', label: '— set —' },
        { value: 'male', label: '♂ Male' },
        { value: 'female', label: '♀ Female' },
        { value: 'neutral', label: 'Neutral' },
        { value: 'unknown', label: 'Unknown' }
      ];
      options.forEach(o => {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        if (persona.gender && o.value === String(persona.gender).toLowerCase()) opt.selected = true;
        genderSelect.appendChild(opt);
      });
      genderSelect.addEventListener('change', () => {
        if (!genderSelect.value) return;
        window._dpSetPersonaGender(personaIdx, genderSelect.value);
      });
      genderRow.appendChild(genderSelect);
    }
    card.appendChild(genderRow);

    // Voice dropdown — lock-aware (same pattern as renderPersonasSidebar)
    const voiceRow = el('div', { class: 'flex items-center gap-2 mb-2 flex-wrap' });
    voiceRow.appendChild(el('span', { class: 'text-[11px] text-ink-500' }, 'Voice:'));

    const voiceName = principal.elevenlabs_voice_name
      || (principal.elevenlabs_voice_id ? principal.elevenlabs_voice_id.slice(0, 8) : '—');
    voiceRow.appendChild(el('span', { class: 'text-xs text-ink-700 font-mono' }, voiceName));

    if (!isLocked) {
      const voiceSelect = document.createElement('select');
      voiceSelect.className = 'text-xs border border-surface-300 rounded px-1 py-0.5 ml-auto';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '— override —';
      voiceSelect.appendChild(placeholder);
      (voiceLibrary || []).forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.voice_id;
        const takenInfo = voiceTakenBy.get(v.voice_id);
        const takenByOther = takenInfo && takenInfo.personaIdx !== personaIdx;
        if (takenByOther) {
          opt.disabled = true;
          opt.textContent = `${v.name} (${v.gender}) — locked to ${takenInfo.personaName}`;
        } else {
          opt.textContent = `${v.name} (${v.gender})`;
        }
        if (v.voice_id === principal.elevenlabs_voice_id) opt.selected = true;
        voiceSelect.appendChild(opt);
      });
      voiceSelect.addEventListener('change', () => {
        if (!voiceSelect.value) return;
        // Reuse the EXISTING canonical voice override path — Casting Room
        // does NOT have its own voice PATCH (Failure Mode #2 contract).
        window._dpOverridePersonaVoice(
          personaIdx,
          voiceSelect.value,
          voiceSelect.options[voiceSelect.selectedIndex].textContent
        );
      });
      voiceRow.appendChild(voiceSelect);
    }
    card.appendChild(voiceRow);

    // Phase 3.5 + V4 Wave 6 / F8 — Voice mismatch chip with three states.
    //
    // After Fix 6 + F3 ship, the original two-state chip ("mismatch + Re-pick"
    // unless locked) is ambiguous: a high-confidence mismatch (visual_anchor
    // grounded) on an unlocked bible will be auto-recast on the next pipeline
    // run, so showing a Re-pick button just confuses the user — they don't
    // need to act. A weak-signal mismatch (storyline_signal disagreeing with
    // voice) should still show Re-pick. A locked-bible mismatch can't be
    // re-cast at all without unlocking first. Three distinct chip states:
    //
    //   Auto-recast pending (info, no button)
    //   Manual re-pick (warning, Re-pick button)
    //   Locked (info, no Re-pick button + secondary "Unlock" link)
    if (principal.voice_gender_match === false) {
      const mismatchLabel = `voice gender (${principal.elevenlabs_voice_gender || '?'}) ≠ persona (${principal.gender_inferred || '?'})`;
      const isHighConfidence = principal.gender_resolved_from === 'visual_anchor';
      let chipState;
      if (isLocked) {
        chipState = 'locked';
      } else if (isHighConfidence) {
        chipState = 'auto_recast_pending';
      } else {
        chipState = 'manual_repick';
      }

      const mismatchRow = el('div', { class: 'flex items-center gap-2 mt-1' });

      if (chipState === 'auto_recast_pending') {
        // Info — blue, no button. The next pipeline run will auto-recast
        // because gender_resolved_from='visual_anchor' AND bible unlocked.
        mismatchRow.appendChild(el('span', {
          class: 'text-[10px] font-mono px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded border border-blue-200'
        }, `↻ ${mismatchLabel} — will auto-recast next run`));
      } else if (chipState === 'manual_repick') {
        // Warning — red, Re-pick button. Weak-signal mismatch (storyline /
        // persona text inference disagreeing with voice). User decides.
        mismatchRow.appendChild(el('span', {
          class: 'text-[10px] font-mono px-1.5 py-0.5 bg-red-100 text-red-700 rounded border border-red-200'
        }, `⚠ ${mismatchLabel}`));
        mismatchRow.appendChild(el('button', {
          type: 'button',
          class: 'text-[10px] px-2 py-0.5 border border-red-300 rounded text-red-700 hover:bg-red-50 ml-auto',
          onclick: () => window._dpReacquirePersonaVoice(personaIdx)
        }, 'Re-pick'));
      } else {
        // Locked — info gray. Re-pick is impossible while bible is locked
        // (lock is total per Failure Mode #3). Surface Unlock link.
        mismatchRow.appendChild(el('span', {
          class: 'text-[10px] font-mono px-1.5 py-0.5 bg-gray-100 text-gray-700 rounded border border-gray-300'
        }, `🔒 ${mismatchLabel} — locked, clear bible to re-cast`));
        if (typeof window._dpUnlockCastBible === 'function') {
          mismatchRow.appendChild(el('button', {
            type: 'button',
            class: 'text-[10px] underline text-gray-600 hover:text-gray-800 ml-auto',
            onclick: () => window._dpUnlockCastBible()
          }, 'Unlock'));
        }
      }
      card.appendChild(mismatchRow);
    }

    // Arc preview (read-only)
    if (principal.arc) {
      card.appendChild(el('div', { class: 'text-[11px] text-ink-500 italic mt-2 line-clamp-2' },
        `Arc: ${principal.arc}`
      ));
    }

    return card;
  }

  // Reset / unlock — clears the cast bible so the next runV4Pipeline re-derives.
  // This is the ONLY way to undo a lock (Failure Mode #3 contract).
  window._dpResetCastBible = async function () {
    if (!activeStoryId) return;
    const isLocked = activeStory?.cast_bible?.status === 'locked';
    const msg = isLocked
      ? 'Unlock & clear the Cast Bible? The next episode will re-derive it from the storyline + personas.'
      : 'Clear the Cast Bible? The next episode will re-derive it from scratch.';
    if (!confirm(msg)) return;
    try {
      const resp = await fetch(`/api/brand-stories/${activeStoryId}/cast-bible`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify({ bible: null })
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'Clear failed');
      if (activeStory) activeStory.cast_bible = null;
      renderCastingPanel();
      renderRightPane(); // refresh tab badge
      flashStatus('Cast cleared — next episode will re-derive it');
    } catch (err) {
      flashStatus(`Clear failed: ${err.message}`, true);
    }
  };

  // Lock the cast bible. PATCHes status: 'locked' + locked_at timestamp.
  // Lock is total — all structural mutations (principal count, persona_index,
  // name, role, gender, voice) are rejected by the API until the user clears
  // via _dpResetCastBible.
  window._dpLockCastBible = async function () {
    if (!activeStoryId || !activeStory?.cast_bible) return;
    if (!confirm('Lock the cast? This freezes principals + voices. To make structural changes you\'ll need to clear and re-derive.')) return;
    try {
      const lockedBible = {
        ...activeStory.cast_bible,
        status: 'locked',
        locked_at: new Date().toISOString()
      };
      const resp = await fetch(`/api/brand-stories/${activeStoryId}/cast-bible`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify({ bible: lockedBible })
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'Lock failed');
      activeStory.cast_bible = data.bible;
      renderCastingPanel();
      renderRightPane();
      flashStatus('Cast locked');
    } catch (err) {
      flashStatus(`Lock failed: ${err.message}`, true);
    }
  };

  // Phase 3.5 — set explicit gender on a persona. Writes to persona_config
  // (canonical truth path, Failure Mode #2). Cast bible's gender_inferred
  // field re-resolves on next read.
  window._dpSetPersonaGender = async function (personaIdx, gender) {
    if (!activeStoryId || personaIdx == null || !gender) return;
    try {
      const resp = await fetch(`/api/brand-stories/${activeStoryId}/personas/${personaIdx}/gender`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify({ gender })
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'Set gender failed');
      // Update local state — gender writes to persona_config canonical path
      const personas = activeStory.persona_config?.personas
        || [activeStory.persona_config];
      if (personas[personaIdx]) personas[personaIdx].gender = gender.toLowerCase();
      // Re-fetch the cast bible so derived fields (gender_inferred,
      // gender_resolved_from, voice_gender_match) reflect the new gender.
      await _refreshCastBible();
      renderCastingPanel();
      renderRightPane();
      flashStatus(`Gender set: ${gender}`);
    } catch (err) {
      renderCastingPanel(); // revert dropdown on error
      flashStatus(`Set gender failed: ${err.message}`, true);
    }
  };

  // Phase 3.5 — voice re-acquisition confirmation. Clears the persona's voice
  // (PATCH /personas/:idx/voice with voice_id: null) so the next runV4Pipeline
  // picks a fresh voice with the correct gender filter.
  window._dpReacquirePersonaVoice = async function (personaIdx) {
    if (!activeStoryId || personaIdx == null) return;
    const personas = activeStory.persona_config?.personas
      || [activeStory.persona_config];
    const persona = personas[personaIdx];
    if (!persona) return;
    const msg = `Voice "${persona.elevenlabs_voice_name || persona.elevenlabs_voice_id || '(unknown)'}" doesn't match the persona's gender. Clear it so the next episode picks a fresh voice?`;
    if (!confirm(msg)) return;
    try {
      const resp = await fetch(`/api/brand-stories/${activeStoryId}/personas/${personaIdx}/voice`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify({ voice_id: null })
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'Clear voice failed');
      personas[personaIdx].elevenlabs_voice_id = null;
      personas[personaIdx].elevenlabs_voice_name = null;
      personas[personaIdx].elevenlabs_voice_gender = null;
      await _refreshCastBible();
      renderCastingPanel();
      renderRightPane();
      flashStatus('Voice cleared — will re-pick on next generation');
    } catch (err) {
      flashStatus(`Clear voice failed: ${err.message}`, true);
    }
  };

  // Helper: fetch the resolved cast bible from the server (re-resolves voice
  // fields + voice_gender_match per the canonical-source contract).
  async function _refreshCastBible() {
    if (!activeStoryId) return;
    try {
      const resp = await fetch(`/api/brand-stories/${activeStoryId}/cast-bible`);
      const data = await resp.json();
      if (data && data.success && data.bible) {
        if (activeStory) activeStory.cast_bible = data.bible;
      }
    } catch {
      // Silent — UI stays on local state until next refresh
    }
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

  // 2026-05-05 — Aleph Rec 2 Phase 4: opt-in commercial-only enhancement.
  // Confirmation copy explicitly names the cost model + identity hard gate
  // so the user understands what they're agreeing to BEFORE the spend.
  window._dpEnhanceWithAleph = async function () {
    const billingEnabled = !!window._brandStoryAlephBillingEnabled; // set by parent page if billing on
    const costNote = billingEnabled
      ? 'Cost: ~$12 per enhancement. Auto-refunded if identity check fails.'
      : 'Free during the current testing phase.';
    const message =
      'Apply Runway Aleph cinema-grade stylization to this commercial episode?\n\n' +
      '• Operates on the post-LUT intermediate (graded video, no music/cards/subs yet)\n' +
      '• Re-applies music + cards + subtitles AFTER stylization\n' +
      '• Hard gate: identity_lock must score \u2265 85/100 — if it fails, the original is kept\n' +
      `• Estimated wait: 3\u20135 minutes for a 60s spot\n\n${costNote}`;

    if (!confirm(message)) return;

    try {
      const resp = await fetch(`/api/brand-stories/${activeStoryId}/episodes/${activeEpisodeId}/enhance/aleph`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify({ strength: 0.20 })
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data.error || `Aleph request failed (${resp.status})`);
      }
      flashStatus('\u2728 Aleph enhancement started — watch the progress feed');
      // Update local state so the header re-renders with the "Enhancing\u2026" pill
      // immediately, before the first SSE tick arrives.
      if (activeEpisode) {
        activeEpisode.aleph_job_metadata = {
          ...activeEpisode.aleph_job_metadata,
          status: 'running',
          requested_at: new Date().toISOString()
        };
        renderHeader();
      }
      connectSSE();
    } catch (err) {
      flashStatus(`Aleph enhancement failed: ${err.message}`, true);
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
      // Revert the dropdown's optimistic change — the select shows the
      // rejected option until we re-render from current state. The 409
      // case (voice locked to another persona, or gender mismatch) lands
      // here with a descriptive backend error in err.message.
      renderPersonasSidebar();
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
