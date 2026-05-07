// affiliate.js - AE Affiliate dashboard logic (embedded in profile.html)
//
// Shared variables (csrfToken, currentUser) and CSRF functions are provided
// by profile.js. Affiliate init is triggered via the showTab wrapper in
// profile.html when the Affiliate tab is shown.

// Affiliate-specific state
var affiliateCredentials = null;
var affiliateKeywords = [];
var affiliateAgents = [];
var affiliateHistory = [];
var affiliateStats = null;

// Platforms allowed for affiliate agents (must match backend AFFILIATE_ALLOWED_PLATFORMS)
const AFF_ALLOWED_PLATFORMS = ['whatsapp', 'telegram', 'twitter', 'linkedin', 'facebook', 'reddit', 'instagram', 'threads'];

// Platform display info for affiliate UI
const AFF_PLATFORM_INFO = {
    twitter:   { name: 'Twitter/X',  color: '#1DA1F2', icon: '\uD835\uDD4F' },
    linkedin:  { name: 'LinkedIn',   color: '#0077B5', icon: 'in' },
    reddit:    { name: 'Reddit',     color: '#FF4500', icon: 'r/' },
    facebook:  { name: 'Facebook',   color: '#1877F2', icon: 'f' },
    telegram:  { name: 'Telegram',   color: '#0088cc', icon: 'tg' },
    whatsapp:  { name: 'WhatsApp',   color: '#25D366', icon: 'wa' },
    instagram: { name: 'Instagram',  color: '#E4405F', icon: 'ig' },
    threads:   { name: 'Threads',    color: '#000000', icon: '@' }
};

// ============================================
// INITIALIZATION
// ============================================

function updateAffiliateTierBadge() {
    const label = document.getElementById('affiliateTierLabel');
    const badge = document.getElementById('affiliateTierBadge');
    if (!label || !badge) return;

    const tier = currentUser?.subscription?.tier || 'free';
    const tierDisplay = tier.charAt(0).toUpperCase() + tier.slice(1);
    label.textContent = tierDisplay;

    // Color-code by tier
    const tierColors = {
        free: { bg: 'bg-ink-100', text: 'text-ink-600', border: 'border-ink-200' },
        starter: { bg: 'bg-brand-100', text: 'text-brand-700', border: 'border-brand-200' },
        growth: { bg: 'bg-green-100', text: 'text-green-700', border: 'border-green-200' },
        business: { bg: 'bg-purple-100', text: 'text-purple-700', border: 'border-purple-200' }
    };
    const colors = tierColors[tier] || tierColors.free;
    badge.className = `inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${colors.bg} ${colors.text} border ${colors.border}`;
}

async function initAffiliate() {
    // Idempotent — Affiliate is now invoked from `showMarketingTab('affiliate')`
    // which can fire on every visit. The first call performs the full init;
    // subsequent calls only refresh the tier badge so the plan label stays current.
    if (window.__affiliateInited) {
        updateAffiliateTierBadge();
        return;
    }
    window.__affiliateInited = true;

    // Update tier badge
    updateAffiliateTierBadge();

    // Load credentials status, keywords, and categories in parallel
    await Promise.all([
        loadCredentialStatus(),
        loadKeywords(),
        loadCategories()
    ]);

    // Support deep-link editing from agents grid (profile.html?tab=affiliate&editKeyword=...)
    const urlParams = new URLSearchParams(window.location.search);
    const editKeywordId = urlParams.get('editKeyword');
    if (editKeywordId) {
        showAffiliateSubTab('keywords');
        const kw = affiliateKeywords.find(k => k.id === editKeywordId);
        if (kw) showKeywordModal(kw);
    }
}

// ============================================
// CREDENTIAL MANAGEMENT
// ============================================

async function loadCredentialStatus() {
    try {
        const data = await affApiGet('/api/affiliate/credentials/status');
        affiliateCredentials = data;
        renderCredentialStatus(data);
    } catch (error) {
        // No credentials yet - show setup form
        renderCredentialStatus({ configured: false });
    }
}

function renderCredentialStatus(status) {
    const container = document.getElementById('credentialStatusContainer');
    if (!container) return;

    if (status.oauthConnected && status.trackingId) {
        // State 3: OAuth connected + tracking ID set
        container.innerHTML = `
            <div class="flex items-center justify-between p-4 rounded-xl bg-green-50 border border-green-200">
                <div class="flex items-center gap-3">
                    <div class="w-9 h-9 rounded-full bg-green-100 flex items-center justify-center">
                        <svg class="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                        </svg>
                    </div>
                    <div>
                        <p class="font-medium text-green-800">AliExpress Account Connected</p>
                        <p class="text-sm text-green-600">
                            ${status.oauthUsername ? escapeHtml(status.oauthUsername) + ' &middot; ' : ''}Tracking ID: ${escapeHtml(status.trackingId)}
                        </p>
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <button onclick="toggleCredentialForm()" class="text-sm text-ink-500 hover:text-ink-700 border border-ink-300 rounded-lg px-3 py-1.5 transition-colors">
                        Edit Tracking ID
                    </button>
                    <button onclick="disconnectAliExpress()" class="text-sm text-red-500 hover:text-red-700 border border-red-300 rounded-lg px-3 py-1.5 transition-colors">
                        Disconnect
                    </button>
                </div>
            </div>
            <div id="credentialFormWrapper" class="hidden mt-4">
                ${getTrackingIdFormHtml()}
            </div>
        `;
    } else if (status.oauthConnected) {
        // State 2: OAuth connected, no tracking ID
        container.innerHTML = `
            <div class="flex items-center justify-between p-4 rounded-xl bg-green-50 border border-green-200">
                <div class="flex items-center gap-3">
                    <div class="w-9 h-9 rounded-full bg-green-100 flex items-center justify-center">
                        <svg class="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                        </svg>
                    </div>
                    <div>
                        <p class="font-medium text-green-800">AliExpress Account Connected</p>
                        <p class="text-sm text-green-600">
                            ${status.oauthUsername ? escapeHtml(status.oauthUsername) : 'Account linked'}
                        </p>
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <button onclick="toggleCredentialForm()" class="text-sm text-ink-500 hover:text-ink-700 border border-ink-300 rounded-lg px-3 py-1.5 transition-colors">
                        Set Tracking ID
                    </button>
                    <button onclick="disconnectAliExpress()" class="text-sm text-red-500 hover:text-red-700 border border-red-300 rounded-lg px-3 py-1.5 transition-colors">
                        Disconnect
                    </button>
                </div>
            </div>
            <div id="credentialFormWrapper" class="hidden mt-4">
                <p class="text-xs text-ink-400 mb-3">Tracking ID is optional. It adds a sub-label for analytics in your AliExpress Portals dashboard.</p>
                ${getTrackingIdFormHtml()}
            </div>
        `;
    } else {
        // State 1: Not connected — show connect button
        container.innerHTML = `
            <div class="p-4 rounded-xl bg-amber-50 border border-amber-200">
                <div class="flex items-center gap-3 mb-3">
                    <div class="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center">
                        <svg class="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"></path>
                        </svg>
                    </div>
                    <div>
                        <p class="font-medium text-amber-800">Connect Your AliExpress Account</p>
                        <p class="text-sm text-amber-600">Link your AliExpress account to start generating commission-earning affiliate links.</p>
                    </div>
                </div>
                <button onclick="connectAliExpress()" class="btn-primary btn-sm">
                    Connect AliExpress Account
                </button>
            </div>
        `;
    }
}

function getTrackingIdFormHtml() {
    return `
        <div class="space-y-4" id="credentialForm">
            <div>
                <label class="block text-sm font-medium text-ink-600 mb-1">Tracking ID</label>
                <input type="text" id="affTrackingId" class="input-field" placeholder="e.g. my_telegram_bot">
                <p class="text-xs text-ink-400 mt-1">Your affiliate tracking ID. Found in <a href="https://portals.aliexpress.com" target="_blank" class="text-brand-600 hover:underline">AliExpress Portals</a> &rarr; Account &rarr; Tracking ID.</p>
            </div>
            <div class="flex gap-3">
                <button onclick="saveCredentials()" id="saveCredentialsBtn" class="btn-primary btn-sm">
                    Save Tracking ID
                </button>
            </div>
        </div>
    `;
}

function toggleCredentialForm() {
    const wrapper = document.getElementById('credentialFormWrapper');
    if (wrapper) {
        wrapper.classList.toggle('hidden');
    }
}

async function saveCredentials() {
    const trackingId = document.getElementById('affTrackingId')?.value?.trim();

    if (!trackingId) {
        showToast('Please enter a Tracking ID.', 'error');
        return;
    }

    const btn = document.getElementById('saveCredentialsBtn');
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<div class="loader" style="width:16px;height:16px;"></div> Saving...';
    }

    try {
        await affApiPost('/api/affiliate/credentials', { trackingId });
        showToast('Tracking ID saved!', 'success');
        await loadCredentialStatus();
    } catch (error) {
        showToast(error.message || 'Failed to save tracking ID.', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
    }
}

async function removeTrackingId() {
    if (!confirm('Remove your tracking ID? Your affiliate links will still work but without sub-tracking.')) {
        return;
    }

    try {
        await affApiDelete('/api/affiliate/credentials');
        showToast('Tracking ID removed.', 'success');
        await loadCredentialStatus();
    } catch (error) {
        showToast('Failed to remove tracking ID.', 'error');
    }
}

// Legacy alias
async function deleteCredentials() { await removeTrackingId(); }

async function connectAliExpress() {
    // Uses the shared connectPlatform from profile.js which handles OAuth redirect
    connectPlatform('aliexpress');
}

async function disconnectAliExpress() {
    if (!confirm('Disconnect your AliExpress account? Affiliate product search and link generation will stop working.')) {
        return;
    }
    try {
        // Delete OAuth connection
        const token = localStorage.getItem('token');
        await fetch('/api/connections/aliexpress', {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-CSRF-Token': getCsrfToken()
            }
        });
        // Also clean up tracking ID from affiliate_credentials
        try { await affApiDelete('/api/affiliate/credentials'); } catch { /* may not exist */ }
        showToast('AliExpress account disconnected.', 'success');
        await loadCredentialStatus();
    } catch (error) {
        showToast('Failed to disconnect. Please try again.', 'error');
    }
}

// ============================================
// KEYWORD MANAGEMENT
// ============================================

async function loadKeywords() {
    try {
        // Load keywords and agents in parallel for cross-referencing
        const [kwData, agentsData] = await Promise.all([
            affApiGet('/api/affiliate/keywords'),
            affApiGet('/api/agents').catch(() => ({ agents: [] }))
        ]);
        affiliateKeywords = kwData.keywords || [];
        affiliateAgents = (agentsData.agents || []).filter(a => a.settings?.contentSource === 'affiliate_products');
        renderKeywords();
    } catch (error) {
        console.error('Error loading keywords:', error);
        affiliateKeywords = [];
        affiliateAgents = [];
        renderKeywords();
    }
}

function renderKeywords() {
    const container = document.getElementById('keywordsContainer');
    if (!container) return;

    if (affiliateKeywords.length === 0) {
        container.innerHTML = `
            <div class="text-center py-8 text-ink-400">
                <svg class="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
                </svg>
                <p class="font-medium mb-1">No affiliate agents yet</p>
                <p class="text-sm">Create an affiliate agent to start automatically posting products.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = affiliateKeywords.map(kw => {
        const linkedAgent = affiliateAgents.find(a => kw.metadata?.linkedAgentId === a.id);
        const platform = linkedAgent?.platform;
        const platformInfo = platform ? AFF_PLATFORM_INFO[platform] : null;
        const agentStatus = linkedAgent?.status;

        return `
        <div class="card-gradient p-4 rounded-xl mb-3" data-keyword-id="${kw.id}">
            <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-2 flex-wrap">
                    ${platformInfo ? `
                    <span class="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full" style="background: ${platformInfo.color}15; color: ${platformInfo.color};">
                        <span class="font-bold text-[10px]">${platformInfo.icon}</span>
                        ${platformInfo.name}
                    </span>` : ''}
                    <h4 class="font-medium text-ink-800">${escapeHtml(kw.name || 'Unnamed Agent')}</h4>
                    ${agentStatus ? `
                    <span class="text-xs px-2 py-0.5 rounded-full ${agentStatus === 'active' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}">
                        ${agentStatus === 'active' ? 'Publishing' : 'Paused'}
                    </span>` : !linkedAgent ? `
                    <span class="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">No Agent</span>` : ''}
                </div>
                <div class="flex items-center gap-2">
                    <button onclick="toggleKeywordActive('${kw.id}', ${!kw.is_active})" class="text-xs ${kw.is_active ? 'text-amber-600 hover:text-amber-700' : 'text-green-600 hover:text-green-700'} transition-colors">
                        ${kw.is_active ? 'Pause' : 'Activate'}
                    </button>
                    <button onclick="editKeyword('${kw.id}')" class="text-xs text-brand-600 hover:text-brand-700 transition-colors">
                        Edit
                    </button>
                    <button onclick="deleteKeyword('${kw.id}')" class="text-xs text-red-500 hover:text-red-700 transition-colors">
                        Delete
                    </button>
                </div>
            </div>
            <div class="flex flex-wrap gap-1.5 mb-2">
                ${(kw.keywords || []).map(k => `<span class="text-xs bg-brand-50 text-brand-700 px-2 py-0.5 rounded-full">${escapeHtml(k)}</span>`).join('')}
            </div>
            <div class="flex flex-wrap gap-3 text-xs text-ink-400">
                ${kw.min_price || kw.max_price ? `<span>Price: ${kw.min_price ? '$' + kw.min_price : ''}${kw.min_price && kw.max_price ? '-' : ''}${kw.max_price ? '$' + kw.max_price : ''}</span>` : ''}
                ${kw.min_commission_rate ? `<span>Min Commission: ${kw.min_commission_rate}%</span>` : ''}
                ${kw.min_rating ? `<span>Min Rating: ${kw.min_rating}</span>` : ''}
                ${kw.sort_by ? `<span>Sort: ${kw.sort_by.replace('_', ' ')}</span>` : ''}
                ${kw.target_currency && kw.target_currency !== 'USD' ? `<span>Currency: ${kw.target_currency}</span>` : ''}
                ${linkedAgent ? `<span>Schedule: ${linkedAgent.settings?.schedule?.postsPerDay || 3}/day</span>` : ''}
                ${linkedAgent?.settings?.geoFilter?.contentLanguage && linkedAgent.settings.geoFilter.contentLanguage !== 'en' ? `<span>Lang: ${linkedAgent.settings.geoFilter.contentLanguage === 'he' ? 'Hebrew' : linkedAgent.settings.geoFilter.contentLanguage === 'ar' ? 'Arabic' : linkedAgent.settings.geoFilter.contentLanguage}</span>` : ''}
            </div>
        </div>`;
    }).join('');
}

async function showKeywordModal(keyword = null) {
    const modal = document.getElementById('keywordModal');
    if (!modal) return;

    const isEdit = !!keyword;
    const linkedAgentId = keyword?.metadata?.linkedAgentId;
    document.getElementById('keywordModalTitle').textContent = isEdit ? 'Edit Affiliate Agent' : 'Create Affiliate Agent';
    document.getElementById('keywordModalSubmitBtn').textContent = isEdit ? 'Update' : 'Create';
    document.getElementById('keywordModalSubmitBtn').setAttribute('data-keyword-id', keyword?.id || '');

    // Populate keyword fields
    document.getElementById('kwName').value = keyword?.name || '';
    document.getElementById('kwKeywords').value = (keyword?.keywords || []).join(', ');
    document.getElementById('kwCategory').value = keyword?.category || '';
    document.getElementById('kwMinPrice').value = keyword?.min_price || '';
    document.getElementById('kwMaxPrice').value = keyword?.max_price || '';
    document.getElementById('kwMinCommission').value = keyword?.min_commission_rate || '';
    document.getElementById('kwMinRating').value = keyword?.min_rating || '';
    document.getElementById('kwMinOrders').value = keyword?.min_orders || '';
    document.getElementById('kwSortBy').value = keyword?.sort_by || 'commission_rate';
    document.getElementById('kwCurrency').value = keyword?.target_currency || 'USD';

    // Clear platform error
    const platformError = document.getElementById('kwPlatformError');
    if (platformError) { platformError.textContent = ''; platformError.classList.add('hidden'); }

    // Load connections and populate platform dropdown
    const platformSelect = document.getElementById('kwPlatform');
    if (platformSelect) {
        platformSelect.innerHTML = '<option value="">Loading platforms...</option>';
        platformSelect.disabled = true;

        try {
            const token = localStorage.getItem('token');
            const [connResp, agentsResp] = await Promise.all([
                fetch('/api/connections', { headers: { 'Authorization': `Bearer ${token}` }, credentials: 'include' }),
                fetch('/api/agents', { headers: { 'Authorization': `Bearer ${token}` }, credentials: 'include' })
            ]);

            const connData = connResp.ok ? await connResp.json() : { connections: [] };
            const agentsData = agentsResp.ok ? await agentsResp.json() : { agents: [] };

            const connections = (connData.connections || []).filter(c => c.status === 'active' && AFF_ALLOWED_PLATFORMS.includes(c.platform));
            const existingAgentConnectionIds = (agentsData.agents || []).map(a => a.connection_id);

            platformSelect.innerHTML = '<option value="">Select a connected platform...</option>';

            if (connections.length === 0) {
                platformSelect.innerHTML = '<option value="">No supported platforms connected</option>';
            } else {
                for (const conn of connections) {
                    const info = AFF_PLATFORM_INFO[conn.platform] || { name: conn.platform };
                    const hasAgent = existingAgentConnectionIds.includes(conn.id);
                    const isLinkedToThis = linkedAgentId && affiliateAgents.find(a => a.id === linkedAgentId && a.connection_id === conn.id);
                    const opt = document.createElement('option');
                    opt.value = conn.id;
                    opt.dataset.platform = conn.platform;
                    opt.textContent = `${info.name}${conn.platform_username ? ' - @' + conn.platform_username : ''}${hasAgent && !isLinkedToThis ? ' (agent exists)' : ''}`;
                    if (hasAgent && !isLinkedToThis) opt.disabled = true;
                    platformSelect.appendChild(opt);
                }
            }

            // If editing with linked agent, pre-select the platform
            if (isEdit && linkedAgentId) {
                const linkedAgent = affiliateAgents.find(a => a.id === linkedAgentId);
                if (linkedAgent) {
                    platformSelect.value = linkedAgent.connection_id;
                    platformSelect.disabled = true; // Can't change platform for existing agent
                }
            }
        } catch (error) {
            console.error('Error loading connections for modal:', error);
            platformSelect.innerHTML = '<option value="">Failed to load platforms</option>';
        }

        if (!isEdit || !linkedAgentId) platformSelect.disabled = false;
    }

    // Populate agent settings (schedule/tone) from linked agent or defaults
    const linkedAgent = linkedAgentId ? affiliateAgents.find(a => a.id === linkedAgentId) : null;
    const agentSettings = linkedAgent?.settings || {};

    document.getElementById('kwPostsPerDay').value = agentSettings.schedule?.postsPerDay || '3';
    document.getElementById('kwStartTime').value = agentSettings.schedule?.startTime || '09:00';
    document.getElementById('kwEndTime').value = agentSettings.schedule?.endTime || '21:00';
    document.getElementById('kwTone').value = agentSettings.contentStyle?.tone || 'casual';
    document.getElementById('kwIncludeHashtags').checked = agentSettings.contentStyle?.includeHashtags ?? true;
    document.getElementById('kwLanguage').value = agentSettings.geoFilter?.contentLanguage || 'en';

    // Product source toggles
    const affSettings = agentSettings.affiliateSettings || {};
    document.getElementById('kwIncludeHotProducts').checked = affSettings.includeHotProducts ?? true;
    document.getElementById('kwIncludeSmartMatch').checked = affSettings.includeSmartMatch ?? true;

    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeKeywordModal() {
    const modal = document.getElementById('keywordModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}

async function submitKeyword() {
    const btn = document.getElementById('keywordModalSubmitBtn');
    const keywordId = btn?.getAttribute('data-keyword-id');
    const isEdit = !!keywordId;

    // Validate keywords
    const keywordsRaw = document.getElementById('kwKeywords')?.value?.trim();
    if (!keywordsRaw) {
        showToast('Please enter at least one keyword.', 'error');
        return;
    }

    const keywords = keywordsRaw.split(',').map(k => k.trim()).filter(Boolean);
    if (keywords.length === 0) {
        showToast('Please enter valid keywords.', 'error');
        return;
    }

    // Validate platform selection (only for new agents)
    const platformSelect = document.getElementById('kwPlatform');
    const selectedConnectionId = platformSelect?.value;
    const platformError = document.getElementById('kwPlatformError');

    if (!isEdit && !selectedConnectionId) {
        if (platformError) {
            platformError.textContent = 'Please select a platform to post to.';
            platformError.classList.remove('hidden');
        }
        showToast('Please select a platform for this affiliate agent.', 'error');
        return;
    }
    if (platformError) platformError.classList.add('hidden');

    // Build keyword payload
    const kwName = document.getElementById('kwName')?.value?.trim() || 'Default';
    const kwPayload = {
        name: kwName,
        keywords,
        category: document.getElementById('kwCategory')?.value?.trim() || null,
        minPrice: parseFloat(document.getElementById('kwMinPrice')?.value) || null,
        maxPrice: parseFloat(document.getElementById('kwMaxPrice')?.value) || null,
        minCommissionRate: parseFloat(document.getElementById('kwMinCommission')?.value) || null,
        minRating: parseFloat(document.getElementById('kwMinRating')?.value) || null,
        minOrders: parseInt(document.getElementById('kwMinOrders')?.value) || null,
        sortBy: document.getElementById('kwSortBy')?.value || 'commission_rate',
        targetCurrency: document.getElementById('kwCurrency')?.value || 'USD'
    };

    // Agent settings from publishing section
    const selectedLanguage = document.getElementById('kwLanguage')?.value || 'en';
    const agentSettings = {
        contentSource: 'affiliate_products',
        affiliateSettings: {
            keywordSetIds: [],
            includeHotProducts: document.getElementById('kwIncludeHotProducts')?.checked ?? true,
            includeSmartMatch: document.getElementById('kwIncludeSmartMatch')?.checked ?? true
        },
        topics: [],
        keywords: [],
        geoFilter: {
            contentLanguage: selectedLanguage
        },
        schedule: {
            postsPerDay: parseInt(document.getElementById('kwPostsPerDay')?.value) || 3,
            startTime: document.getElementById('kwStartTime')?.value || '09:00',
            endTime: document.getElementById('kwEndTime')?.value || '21:00'
        },
        contentStyle: {
            tone: document.getElementById('kwTone')?.value || 'casual',
            includeHashtags: document.getElementById('kwIncludeHashtags')?.checked ?? true
        }
    };

    const originalText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

    try {
        if (isEdit) {
            // UPDATE flow: update keyword set + update linked agent
            await affApiPut(`/api/affiliate/keywords/${keywordId}`, kwPayload);

            // If there's a linked agent, update its settings too
            const existingKw = affiliateKeywords.find(k => k.id === keywordId);
            const linkedAgentId = existingKw?.metadata?.linkedAgentId;
            if (linkedAgentId) {
                try {
                    const token = localStorage.getItem('token');
                    await fetch(`/api/agents/${linkedAgentId}`, {
                        method: 'PUT',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json',
                            'X-CSRF-Token': getCsrfToken()
                        },
                        credentials: 'include',
                        body: JSON.stringify({ name: `${kwName} Agent`, settings: agentSettings })
                    });
                } catch (agentErr) {
                    console.warn('Failed to update linked agent:', agentErr);
                }
            }
            showToast('Affiliate agent updated.', 'success');
        } else {
            // CREATE flow: create keyword → create agent → link them
            const kwResult = await affApiPost('/api/affiliate/keywords', kwPayload);
            const createdKeywordId = kwResult.keyword?.id;

            if (!createdKeywordId) {
                showToast('Keyword set created but failed to get ID.', 'warning');
                closeKeywordModal();
                await loadKeywords();
                return;
            }

            // Create agent linked to this keyword set
            agentSettings.affiliateSettings.keywordSetIds = [createdKeywordId];

            try {
                const token = localStorage.getItem('token');
                const agentResp = await fetch('/api/agents', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': getCsrfToken()
                    },
                    credentials: 'include',
                    body: JSON.stringify({
                        connectionId: selectedConnectionId,
                        name: `${kwName} Agent`,
                        settings: agentSettings
                    })
                });

                const agentData = await agentResp.json();

                if (agentResp.ok && agentData.agent?.id) {
                    // Link keyword set to agent via metadata
                    try {
                        await affApiPut(`/api/affiliate/keywords/${createdKeywordId}`, {
                            metadata: { linkedAgentId: agentData.agent.id }
                        });
                    } catch (linkErr) {
                        console.warn('Failed to link keyword to agent:', linkErr);
                    }
                    showToast('Affiliate agent created successfully!', 'success');
                } else {
                    // Agent creation failed - show specific error
                    const errorMsg = agentData.error || 'Failed to create agent';
                    showToast(`Keywords saved but agent creation failed: ${errorMsg}`, 'warning');
                }
            } catch (agentErr) {
                showToast(`Keywords saved but agent creation failed: ${agentErr.message}`, 'warning');
            }
        }

        closeKeywordModal();
        await loadKeywords();
    } catch (error) {
        showToast(error.message || 'Failed to save affiliate agent.', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = originalText; }
    }
}

function editKeyword(id) {
    const kw = affiliateKeywords.find(k => k.id === id);
    if (kw) showKeywordModal(kw);
}

async function deleteKeyword(id) {
    const kw = affiliateKeywords.find(k => k.id === id);
    const linkedAgentId = kw?.metadata?.linkedAgentId;
    const confirmMsg = linkedAgentId
        ? 'Delete this affiliate agent and its keyword set? The agent will stop posting. This cannot be undone.'
        : 'Delete this keyword set? This cannot be undone.';

    if (!confirm(confirmMsg)) return;

    try {
        // Delete keyword set
        await affApiDelete(`/api/affiliate/keywords/${id}`);

        // Also delete linked agent if exists
        if (linkedAgentId) {
            try {
                const token = localStorage.getItem('token');
                await fetch(`/api/agents/${linkedAgentId}`, {
                    method: 'DELETE',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'X-CSRF-Token': getCsrfToken()
                    },
                    credentials: 'include'
                });
            } catch (agentErr) {
                console.warn('Failed to delete linked agent:', agentErr);
            }
        }

        showToast('Affiliate agent deleted.', 'success');
        await loadKeywords();
    } catch (error) {
        showToast('Failed to delete affiliate agent.', 'error');
    }
}

async function toggleKeywordActive(id, isActive) {
    try {
        await affApiPut(`/api/affiliate/keywords/${id}`, { isActive });
        await loadKeywords();
    } catch (error) {
        showToast('Failed to update keyword status.', 'error');
    }
}

// ============================================
// PRODUCT PREVIEW & SEARCH
// ============================================

// ============================================
// CATEGORY FILTER
// ============================================

let _categoriesLoaded = false;

async function loadCategories() {
    if (_categoriesLoaded) return;
    const select = document.getElementById('productCategoryFilter');
    if (!select) return;

    try {
        const data = await affApiGet('/api/affiliate/categories');
        const categories = data.categories || [];

        for (const cat of categories) {
            const opt = document.createElement('option');
            opt.value = cat.categoryId;
            opt.textContent = cat.categoryName;
            select.appendChild(opt);

            if (cat.children?.length) {
                for (const child of cat.children) {
                    const subOpt = document.createElement('option');
                    subOpt.value = child.categoryId;
                    subOpt.textContent = `  \u2514 ${child.categoryName}`;
                    select.appendChild(subOpt);
                }
            }
        }
        _categoriesLoaded = true;
    } catch (e) {
        console.warn('Failed to load categories:', e.message);
    }
}

// ============================================
// PRODUCT SEARCH
// ============================================

// Product cache for instant detail modal opening
let _productCache = {};
// Track current search state for pagination
let _searchState = { keywords: '', sortBy: '', categoryId: '', pageNo: 1, totalResults: 0, pageSize: 20 };
// Detail modal state
let _detailState = { affiliateUrl: null, generatedContent: null, selectedPlatform: 'whatsapp', selectedLanguage: 'en' };

async function previewProducts(pageNo) {
    const container = document.getElementById('productPreviewContainer');
    if (!container) return;

    const keywordsInput = document.getElementById('previewKeywords');
    const keywords = keywordsInput?.value?.trim();

    if (!keywords) {
        showToast('Enter keywords to search for products.', 'error');
        return;
    }

    const sortSelect = document.getElementById('productSortBy');
    const sortBy = sortSelect?.value || '';
    const categorySelect = document.getElementById('productCategoryFilter');
    const categoryId = categorySelect?.value || '';
    const page = pageNo || 1;

    _searchState.keywords = keywords;
    _searchState.sortBy = sortBy;
    _searchState.categoryId = categoryId;
    _searchState.pageNo = page;

    container.innerHTML = `
        <div class="text-center py-8">
            <div class="loader mx-auto mb-3" style="width:32px;height:32px;"></div>
            <p class="text-ink-400 text-sm">Searching AliExpress products...</p>
        </div>
    `;

    try {
        let url = `/api/affiliate/products/search?keywords=${encodeURIComponent(keywords)}&pageNo=${page}&pageSize=${_searchState.pageSize}`;
        if (sortBy) url += `&sortBy=${encodeURIComponent(sortBy)}`;
        if (categoryId) url += `&categoryIds=${encodeURIComponent(categoryId)}`;

        const data = await affApiGet(url);
        const products = data.products || [];
        const totalResults = data.totalResults || 0;
        _searchState.totalResults = totalResults;

        // Cache products for instant detail modal
        for (const p of products) {
            _productCache[p.productId] = p;
        }

        // Update results count
        const countEl = document.getElementById('searchResultsCount');
        if (countEl) {
            const start = (page - 1) * _searchState.pageSize + 1;
            const end = start + products.length - 1;
            countEl.textContent = totalResults > 0 ? `${start}-${end} of ${totalResults.toLocaleString()} results` : '';
        }

        if (products.length === 0) {
            container.innerHTML = `
                <div class="text-center py-8 text-ink-400">
                    <p class="font-medium">No products found</p>
                    <p class="text-sm mt-1">Try different keywords or broaden your search.</p>
                </div>
            `;
            return;
        }

        const totalPages = Math.ceil(totalResults / _searchState.pageSize);

        container.innerHTML = `
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                ${products.map(p => renderProductCard(p)).join('')}
            </div>
            ${totalPages > 1 ? `
            <div class="flex items-center justify-center gap-4 mt-6 pt-4 border-t border-surface-200">
                <button onclick="previewProducts(${page - 1})" class="btn-secondary btn-sm ${page <= 1 ? 'opacity-30 pointer-events-none' : ''}" ${page <= 1 ? 'disabled' : ''}>
                    <svg class="w-4 h-4 inline mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>Previous
                </button>
                <span class="text-sm text-ink-500">Page ${page} of ${totalPages.toLocaleString()}</span>
                <button onclick="previewProducts(${page + 1})" class="btn-secondary btn-sm ${page >= totalPages ? 'opacity-30 pointer-events-none' : ''}" ${page >= totalPages ? 'disabled' : ''}>
                    Next<svg class="w-4 h-4 inline ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
                </button>
            </div>` : ''}
        `;
    } catch (error) {
        container.innerHTML = `
            <div class="text-center py-8 text-red-400">
                <p class="font-medium">Search failed</p>
                <p class="text-sm mt-1">${escapeHtml(error.message || 'Please try again.')}</p>
            </div>
        `;
    }
}

async function previewHotProducts(pageNo) {
    const container = document.getElementById('productPreviewContainer');
    if (!container) return;

    const page = pageNo || 1;

    container.innerHTML = `
        <div class="text-center py-8">
            <div class="loader mx-auto mb-3" style="width:32px;height:32px;"></div>
            <p class="text-ink-400 text-sm">Fetching hot products...</p>
        </div>
    `;

    try {
        const data = await affApiGet(`/api/affiliate/products/hot?pageNo=${page}&pageSize=${_searchState.pageSize}`);
        const products = data.products || [];
        const totalResults = data.totalResults || 0;

        for (const p of products) {
            _productCache[p.productId] = p;
        }

        const countEl = document.getElementById('searchResultsCount');
        if (countEl) {
            const start = (page - 1) * _searchState.pageSize + 1;
            const end = start + products.length - 1;
            countEl.textContent = totalResults > 0 ? `${start}-${end} of ${totalResults.toLocaleString()} hot products` : '';
        }

        if (products.length === 0) {
            container.innerHTML = `
                <div class="text-center py-8 text-ink-400">
                    <p class="font-medium">No hot products found</p>
                </div>
            `;
            return;
        }

        const totalPages = Math.ceil(totalResults / _searchState.pageSize);

        container.innerHTML = `
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                ${products.map(p => renderProductCard(p, 'hot')).join('')}
            </div>
            ${totalPages > 1 ? `
            <div class="flex items-center justify-center gap-4 mt-6 pt-4 border-t border-surface-200">
                <button onclick="previewHotProducts(${page - 1})" class="btn-secondary btn-sm ${page <= 1 ? 'opacity-30 pointer-events-none' : ''}" ${page <= 1 ? 'disabled' : ''}>
                    <svg class="w-4 h-4 inline mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>Previous
                </button>
                <span class="text-sm text-ink-500">Page ${page} of ${totalPages.toLocaleString()}</span>
                <button onclick="previewHotProducts(${page + 1})" class="btn-secondary btn-sm ${page >= totalPages ? 'opacity-30 pointer-events-none' : ''}" ${page >= totalPages ? 'disabled' : ''}>
                    Next<svg class="w-4 h-4 inline ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
                </button>
            </div>` : ''}
        `;
    } catch (error) {
        container.innerHTML = `
            <div class="text-center py-8 text-red-400">
                <p class="font-medium">Failed to load hot products</p>
                <p class="text-sm mt-1">${escapeHtml(error.message || 'Please try again.')}</p>
            </div>
        `;
    }
}

async function previewSmartMatch(pageNo, productId) {
    const container = document.getElementById('productPreviewContainer');
    if (!container) return;

    const page = pageNo || 1;
    const keywordsInput = document.getElementById('previewKeywords');
    const keywords = keywordsInput?.value?.trim() || '';

    if (!keywords && !productId) {
        showToast('Enter keywords to get AI-recommended products, or click "Find Similar" on a product card.', 'error');
        return;
    }

    container.innerHTML = `
        <div class="text-center py-8">
            <div class="loader mx-auto mb-3" style="width:32px;height:32px;"></div>
            <p class="text-ink-400 text-sm">${productId ? 'Finding similar products...' : 'Getting AI recommendations...'}</p>
        </div>
    `;

    try {
        let url = `/api/affiliate/products/smart-match?pageNo=${page}&pageSize=${_searchState.pageSize}`;
        if (keywords) url += `&keywords=${encodeURIComponent(keywords)}`;
        if (productId) url += `&productId=${encodeURIComponent(productId)}`;

        const data = await affApiGet(url);
        const products = data.products || [];
        const totalResults = data.totalResults || 0;

        for (const p of products) {
            _productCache[p.productId] = p;
        }

        const countEl = document.getElementById('searchResultsCount');
        if (countEl) {
            const start = (page - 1) * _searchState.pageSize + 1;
            const end = start + products.length - 1;
            countEl.textContent = totalResults > 0 ? `${start}-${end} of ${totalResults.toLocaleString()} smart match results` : '';
        }

        if (products.length === 0) {
            container.innerHTML = `
                <div class="text-center py-8 text-ink-400">
                    <p class="font-medium">No recommendations found</p>
                    <p class="text-sm mt-1">Try different keywords or search for products first.</p>
                </div>
            `;
            return;
        }

        const totalPages = Math.ceil(totalResults / _searchState.pageSize);
        const paginationFn = productId ? `previewSmartMatch(PAGE, '${escapeHtml(productId)}')` : 'previewSmartMatch(PAGE)';

        container.innerHTML = `
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                ${products.map(p => renderProductCard(p, 'smart')).join('')}
            </div>
            ${totalPages > 1 ? `
            <div class="flex items-center justify-center gap-4 mt-6 pt-4 border-t border-surface-200">
                <button onclick="${paginationFn.replace('PAGE', page - 1)}" class="btn-secondary btn-sm ${page <= 1 ? 'opacity-30 pointer-events-none' : ''}" ${page <= 1 ? 'disabled' : ''}>
                    <svg class="w-4 h-4 inline mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>Previous
                </button>
                <span class="text-sm text-ink-500">Page ${page} of ${totalPages.toLocaleString()}</span>
                <button onclick="${paginationFn.replace('PAGE', page + 1)}" class="btn-secondary btn-sm ${page >= totalPages ? 'opacity-30 pointer-events-none' : ''}" ${page >= totalPages ? 'disabled' : ''}>
                    Next<svg class="w-4 h-4 inline ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
                </button>
            </div>` : ''}
        `;
    } catch (error) {
        container.innerHTML = `
            <div class="text-center py-8 text-red-400">
                <p class="font-medium">Smart Match failed</p>
                <p class="text-sm mt-1">${escapeHtml(error.message || 'Please try again.')}</p>
            </div>
        `;
    }
}

// ============================================
// PRODUCT CARDS (clickable → detail modal)
// ============================================

function renderProductCard(product, source) {
    const discount = product.discount ? Math.round(product.discount) : 0;
    const commission = product.commissionRate ? product.commissionRate.toFixed(1) : '0';
    const rating = product.rating ? product.rating.toFixed(1) : 'N/A';
    const orders = product.totalOrders ? product.totalOrders.toLocaleString() : '0';

    const sourceBadge = source === 'hot'
        ? '<span class="text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full font-medium">Hot</span>'
        : source === 'smart'
        ? '<span class="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full font-medium">Smart Match</span>'
        : '';

    return `
        <div class="card-gradient rounded-xl p-4 flex gap-4 cursor-pointer hover:shadow-md hover:border-brand-200 border border-transparent transition-all" onclick="openProductDetail('${escapeHtml(product.productId)}')">
            <div class="w-20 h-20 rounded-lg overflow-hidden flex-shrink-0 bg-surface-100">
                ${product.imageUrl ? `<img src="${escapeHtml(product.imageUrl)}" alt="" class="w-full h-full object-cover" loading="lazy" onerror="this.style.display='none'">` : ''}
            </div>
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 mb-1">
                    <h4 class="text-sm font-medium text-ink-800 line-clamp-2">${escapeHtml(product.title || 'Untitled')}</h4>
                    ${sourceBadge}
                </div>
                <div class="flex items-center gap-2 mb-1">
                    ${product.originalPrice && product.originalPrice > product.salePrice ? `<span class="text-xs text-ink-400 line-through">$${product.originalPrice.toFixed(2)}</span>` : ''}
                    <span class="text-sm font-bold text-green-600">$${(product.salePrice || 0).toFixed(2)}</span>
                    ${discount > 0 ? `<span class="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full font-medium">${discount}% OFF</span>` : ''}
                </div>
                <div class="flex flex-wrap gap-2 text-xs text-ink-400">
                    <span class="bg-green-50 text-green-700 px-1.5 py-0.5 rounded">${commission}% comm.</span>
                    <span>${rating} rating</span>
                    <span>${orders} orders</span>
                    <button class="text-purple-600 hover:text-purple-800 font-medium hover:underline" onclick="event.stopPropagation(); previewSmartMatch(1, '${escapeHtml(product.productId)}')">Find Similar</button>
                </div>
            </div>
            <div class="flex items-center flex-shrink-0">
                <svg class="w-5 h-5 text-ink-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
            </div>
        </div>
    `;
}

// ============================================
// PRODUCT DETAIL MODAL
// ============================================

function openProductDetail(productId) {
    const product = _productCache[productId];
    if (!product) {
        showToast('Product data not found. Please search again.', 'error');
        return;
    }

    // Reset detail state
    _detailState = { affiliateUrl: null, generatedContent: null, selectedPlatform: 'whatsapp', selectedLanguage: 'en' };

    const modal = document.getElementById('productDetailModal');
    if (!modal) return;

    modal.innerHTML = renderProductDetailModal(product);
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden'; // Prevent background scroll

    // Close on Escape
    const escHandler = (e) => {
        if (e.key === 'Escape') { closeProductDetail(); document.removeEventListener('keydown', escHandler); }
    };
    document.addEventListener('keydown', escHandler);
}

function closeProductDetail() {
    const modal = document.getElementById('productDetailModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.innerHTML = '';
        document.body.style.overflow = '';
    }
}

function renderProductDetailModal(product) {
    const discount = product.discount ? Math.round(product.discount) : 0;
    const commission = product.commissionRate ? product.commissionRate.toFixed(1) : '0';
    const rating = product.rating ? product.rating.toFixed(1) : 'N/A';
    const orders = product.totalOrders ? product.totalOrders.toLocaleString() : '0';
    const images = [product.imageUrl, ...(product.smallImages || [])].filter(Boolean);
    const uniqueImages = [...new Set(images)];
    const mainImage = uniqueImages[0] || '';
    const pid = escapeHtml(product.productId);

    return `
        <div style="display:flex;align-items:flex-start;justify-content:center;min-height:100%;padding:16px;" onclick="if(event.target===this)closeProductDetail()">
            <div class="bg-surface-0 rounded-2xl shadow-2xl" style="width:100%;max-width:880px;margin:auto 0;" onclick="event.stopPropagation()">
                <!-- Header -->
                <div class="flex items-center justify-between px-4 py-2.5 border-b border-surface-200" style="position:sticky;top:0;background:inherit;border-radius:16px 16px 0 0;z-index:10;">
                    <h3 class="text-sm font-bold text-ink-800 truncate pr-4" style="font-family:'Satoshi',sans-serif;">Product Details</h3>
                    <button onclick="closeProductDetail()" class="w-7 h-7 rounded-full bg-surface-100 hover:bg-surface-200 flex items-center justify-center transition-colors flex-shrink-0">
                        <svg class="w-3.5 h-3.5 text-ink-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                    </button>
                </div>

                <!-- Body: two-column on desktop via CSS grid with inline style -->
                <div style="display:grid;grid-template-columns:1fr;gap:16px;padding:16px;" class="detail-modal-body">
                    <!-- Left: Product Info -->
                    <div style="min-width:0;">
                        <!-- Image + Title Row -->
                        <div style="display:flex;gap:12px;align-items:flex-start;">
                            <div id="detailMainImage" style="width:140px;height:140px;flex-shrink:0;border-radius:12px;overflow:hidden;background:var(--color-surface-100,#f3f4f6);">
                                ${mainImage ? `<img src="${escapeHtml(mainImage)}" alt="" style="width:100%;height:100%;object-fit:contain;">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#ccc;">No image</div>'}
                            </div>
                            <div style="flex:1;min-width:0;">
                                <h4 class="text-sm font-semibold text-ink-800 leading-snug" style="font-family:'Satoshi',sans-serif;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;">${escapeHtml(product.title || 'Untitled')}</h4>
                                <div class="flex items-center gap-2 flex-wrap" style="margin-top:6px;">
                                    ${product.originalPrice && product.originalPrice > product.salePrice ? `<span class="text-xs text-ink-400 line-through">$${product.originalPrice.toFixed(2)}</span>` : ''}
                                    <span class="text-lg font-bold text-green-600">$${(product.salePrice || 0).toFixed(2)}</span>
                                    ${discount > 0 ? `<span class="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full font-medium">${discount}% OFF</span>` : ''}
                                </div>
                                <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px;" class="text-xs text-ink-500">
                                    <span title="Commission" class="font-medium text-green-600">${commission}% comm</span>
                                    <span title="Rating">&#9733; ${rating}</span>
                                    <span title="Orders">${orders} sold</span>
                                </div>
                            </div>
                        </div>

                        <!-- Thumbnails -->
                        ${uniqueImages.length > 1 ? `
                        <div class="flex gap-1.5 overflow-x-auto" style="margin-top:8px;padding-bottom:2px;">
                            ${uniqueImages.slice(0, 6).map((img, i) => `
                                <button onclick="document.querySelector('#detailMainImage img').src='${escapeHtml(img)}';document.querySelectorAll('.detail-thumb').forEach(t=>t.classList.remove('ring-2','ring-brand-500'));this.classList.add('ring-2','ring-brand-500')" class="detail-thumb flex-shrink-0 bg-surface-100 border border-surface-200 hover:border-brand-300 transition-colors ${i === 0 ? 'ring-2 ring-brand-500' : ''}" style="width:40px;height:40px;border-radius:8px;overflow:hidden;">
                                    <img src="${escapeHtml(img)}" alt="" style="width:100%;height:100%;object-fit:cover;" loading="lazy">
                                </button>
                            `).join('')}
                        </div>` : ''}

                        <!-- Meta info -->
                        <div class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-500" style="margin-top:8px;">
                            ${product.category ? `<span>Category: <span class="font-medium text-ink-700">${escapeHtml(product.category)}</span></span>` : ''}
                            ${product.storeName ? `<span>Store: <span class="font-medium text-ink-700">${escapeHtml(product.storeName)}</span></span>` : ''}
                            ${product.shipToDays ? `<span>Shipping: <span class="font-medium text-ink-700">~${product.shipToDays} days</span></span>` : ''}
                            ${product.productUrl ? `
                            <a href="${escapeHtml(product.productUrl)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-brand-600 hover:text-brand-700 font-medium transition-colors">
                                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
                                View on AliExpress
                            </a>` : ''}
                            ${product.videoUrl ? `
                            <a href="${escapeHtml(product.videoUrl)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-brand-600 hover:text-brand-700 font-medium transition-colors">
                                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                                Product Video
                            </a>` : ''}
                        </div>
                        ${product.promoCode?.code ? `
                        <div class="flex items-center gap-2 text-xs" style="margin-top:6px;padding:4px 8px;background:var(--color-accent-50,#fef3c7);border-radius:8px;">
                            <svg class="w-3.5 h-3.5 text-amber-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"/></svg>
                            <span class="text-amber-800 font-medium">Coupon: <code class="bg-amber-100 px-1 py-0.5 rounded text-amber-900">${escapeHtml(product.promoCode.code)}</code>${product.promoCode.value ? ` — save ${escapeHtml(product.promoCode.value)}` : ''}${product.promoCode.minSpend ? ` (min $${escapeHtml(product.promoCode.minSpend)})` : ''}</span>
                        </div>` : ''}
                    </div>

                    <!-- Right: Content Generation & Actions -->
                    <div style="min-width:0;">
                        <h4 class="text-sm font-semibold text-ink-800" style="font-family:'Satoshi',sans-serif;margin-bottom:8px;">Generate & Share</h4>

                        <!-- Platform Tabs -->
                        <div class="flex gap-2" style="margin-bottom:8px;">
                            <button onclick="selectDetailPlatform('whatsapp')" id="detailPlatformWhatsapp" class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all border-2 border-green-500 bg-green-50 text-green-700">
                                <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/></svg>
                                WhatsApp
                            </button>
                            <button onclick="selectDetailPlatform('telegram')" id="detailPlatformTelegram" class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all border-2 border-surface-200 text-ink-500 hover:border-blue-300">
                                <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
                                Telegram
                            </button>
                        </div>

                        <!-- Language Toggle -->
                        <div class="flex gap-2" style="margin-bottom:8px;">
                            <button onclick="selectDetailLanguage('en')" id="detailLangEn" class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border-2 border-blue-500 bg-blue-50 text-blue-700">
                                🇺🇸 English
                            </button>
                            <button onclick="selectDetailLanguage('he')" id="detailLangHe" class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border-2 border-surface-200 text-ink-500 hover:border-blue-300">
                                🇮🇱 עברית
                            </button>
                        </div>

                        <!-- Generate Button -->
                        <button onclick="generateContentPreview('${pid}')" id="generateContentBtn" class="btn-primary w-full flex items-center justify-center gap-2 py-2 text-sm">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
                            Generate Description
                        </button>

                        <!-- Content Preview Area -->
                        <div id="contentPreviewArea" class="hidden" style="margin-top:8px;">
                            <div class="flex items-center justify-between" style="margin-bottom:4px;">
                                <label class="text-xs font-medium text-ink-600">Content Preview</label>
                                <span id="contentCharCount" class="text-[10px] text-ink-400"></span>
                            </div>
                            <textarea id="contentPreviewText" class="input-field w-full text-sm" rows="5" placeholder="Generated content will appear here..." style="resize:vertical;"></textarea>
                            <div class="flex flex-wrap gap-2" style="margin-top:6px;">
                                <button onclick="postWithContent('${pid}')" id="postContentBtn" class="btn-primary btn-sm flex items-center gap-1.5">
                                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg>
                                    Post to <span id="postPlatformLabel">WhatsApp</span>
                                </button>
                                <button onclick="generateContentPreview('${pid}')" class="btn-secondary btn-sm flex items-center gap-1.5">
                                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
                                    Regenerate
                                </button>
                                <button onclick="copyAffiliateLink('${pid}')" id="copyLinkBtn" class="btn-secondary btn-sm flex items-center gap-1.5">
                                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"/></svg>
                                    Copy Link
                                </button>
                            </div>
                        </div>

                        <!-- Quick Post -->
                        <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--color-surface-200,#e5e7eb);">
                            <p class="text-xs text-ink-400" style="margin-bottom:6px;">Or post directly (auto-generates content):</p>
                            <div class="flex gap-2">
                                <button onclick="quickPost('${pid}', 'whatsapp', this)" class="btn-secondary btn-sm flex items-center gap-1.5 flex-1">
                                    <svg class="w-3.5 h-3.5 text-green-600" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/></svg>
                                    WhatsApp
                                </button>
                                <button onclick="quickPost('${pid}', 'telegram', this)" class="btn-secondary btn-sm flex items-center gap-1.5 flex-1">
                                    <svg class="w-3.5 h-3.5 text-blue-600" fill="currentColor" viewBox="0 0 24 24"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
                                    Telegram
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function selectDetailLanguage(lang) {
    _detailState.selectedLanguage = lang;

    const enBtn = document.getElementById('detailLangEn');
    const heBtn = document.getElementById('detailLangHe');

    if (lang === 'en') {
        enBtn.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border-2 border-blue-500 bg-blue-50 text-blue-700';
        heBtn.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border-2 border-surface-200 text-ink-500 hover:border-blue-300';
    } else {
        heBtn.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border-2 border-blue-500 bg-blue-50 text-blue-700';
        enBtn.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border-2 border-surface-200 text-ink-500 hover:border-blue-300';
    }
}

function selectDetailPlatform(platform) {
    _detailState.selectedPlatform = platform;

    const waBtn = document.getElementById('detailPlatformWhatsapp');
    const tgBtn = document.getElementById('detailPlatformTelegram');
    const postLabel = document.getElementById('postPlatformLabel');

    if (platform === 'whatsapp') {
        waBtn.className = 'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all border-2 border-green-500 bg-green-50 text-green-700';
        tgBtn.className = 'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all border-2 border-surface-200 text-ink-500 hover:border-blue-300';
    } else {
        tgBtn.className = 'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all border-2 border-blue-500 bg-blue-50 text-blue-700';
        waBtn.className = 'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all border-2 border-surface-200 text-ink-500 hover:border-green-300';
    }

    if (postLabel) postLabel.textContent = platform === 'whatsapp' ? 'WhatsApp' : 'Telegram';

    // Clear previous generated content when switching platform (since formatting differs)
    _detailState.generatedContent = null;
    const textarea = document.getElementById('contentPreviewText');
    if (textarea) textarea.value = '';
    const previewArea = document.getElementById('contentPreviewArea');
    if (previewArea) previewArea.classList.add('hidden');
}

async function generateContentPreview(productId) {
    const btn = document.getElementById('generateContentBtn');
    const previewArea = document.getElementById('contentPreviewArea');
    const textarea = document.getElementById('contentPreviewText');
    const charCount = document.getElementById('contentCharCount');

    if (!btn || !previewArea || !textarea) return;

    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<div class="loader" style="width:16px;height:16px;"></div> Generating...';

    try {
        const data = await affApiPost('/api/affiliate/products/generate-content', {
            productId,
            platform: _detailState.selectedPlatform,
            language: _detailState.selectedLanguage
        });

        _detailState.affiliateUrl = data.affiliateUrl;
        _detailState.generatedContent = data.text;

        textarea.value = data.text;
        previewArea.classList.remove('hidden');

        // Update char count
        if (charCount) charCount.textContent = `${data.text.length} chars`;
        textarea.addEventListener('input', () => {
            if (charCount) charCount.textContent = `${textarea.value.length} chars`;
        });

        showToast('Description generated!', 'success');
    } catch (error) {
        showToast(error.message || 'Failed to generate content.', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
    }
}

async function postWithContent(productId) {
    const textarea = document.getElementById('contentPreviewText');
    const btn = document.getElementById('postContentBtn');
    const customContent = textarea?.value?.trim();

    if (!customContent) {
        showToast('Generate or write content first.', 'error');
        return;
    }

    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<div class="loader" style="width:14px;height:14px;"></div> Posting...'; }

    try {
        await affApiPost('/api/affiliate/products/post', {
            productId,
            platform: _detailState.selectedPlatform,
            customContent
        });
        showToast(`Product posted to ${_detailState.selectedPlatform === 'whatsapp' ? 'WhatsApp' : 'Telegram'} successfully!`, 'success');
    } catch (error) {
        showToast(error.message || 'Failed to post product.', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
    }
}

async function quickPost(productId, platform, btnEl) {
    const originalHtml = btnEl ? btnEl.innerHTML : '';
    if (btnEl) { btnEl.disabled = true; btnEl.innerHTML = '<div class="loader" style="width:14px;height:14px;"></div>'; }

    try {
        await affApiPost('/api/affiliate/products/post', { productId, platform });
        showToast(`Product posted to ${platform === 'whatsapp' ? 'WhatsApp' : 'Telegram'} successfully!`, 'success');
    } catch (error) {
        showToast(error.message || 'Failed to post product.', 'error');
    } finally {
        if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = originalHtml; }
    }
}

async function copyAffiliateLink(productId) {
    const btn = document.getElementById('copyLinkBtn');

    // If we already have the affiliate URL from content generation, use it
    if (_detailState.affiliateUrl) {
        await navigator.clipboard.writeText(_detailState.affiliateUrl);
        showToast('Affiliate link copied to clipboard!', 'success');
        return;
    }

    // Otherwise, generate it via the content endpoint
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<div class="loader" style="width:14px;height:14px;"></div> Generating...'; }

    try {
        const data = await affApiPost('/api/affiliate/products/generate-content', {
            productId,
            platform: _detailState.selectedPlatform,
            language: _detailState.selectedLanguage
        });

        _detailState.affiliateUrl = data.affiliateUrl;
        await navigator.clipboard.writeText(data.affiliateUrl);
        showToast('Affiliate link copied to clipboard!', 'success');
    } catch (error) {
        showToast(error.message || 'Failed to generate affiliate link.', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
    }
}

// ============================================
// PUBLISHED PRODUCTS HISTORY
// ============================================

async function loadHistory() {
    const container = document.getElementById('historyContainer');
    if (!container) return;

    container.innerHTML = `
        <div class="text-center py-6">
            <div class="loader mx-auto" style="width:24px;height:24px;"></div>
        </div>
    `;

    try {
        const data = await affApiGet('/api/affiliate/history');
        affiliateHistory = data.products || [];
        renderHistory();
    } catch (error) {
        container.innerHTML = `<p class="text-center text-ink-400 py-4">Failed to load history.</p>`;
    }
}

function renderHistory() {
    const container = document.getElementById('historyContainer');
    if (!container) return;

    if (affiliateHistory.length === 0) {
        container.innerHTML = `
            <div class="text-center py-8 text-ink-400">
                <p class="font-medium">No products published yet</p>
                <p class="text-sm mt-1">Products posted through affiliate agents will appear here.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <div class="overflow-x-auto">
            <table class="w-full text-sm">
                <thead>
                    <tr class="text-left text-xs text-ink-400 uppercase tracking-wider border-b border-surface-200">
                        <th class="pb-2 pr-4">Product</th>
                        <th class="pb-2 pr-4">Platform</th>
                        <th class="pb-2 pr-4">Commission</th>
                        <th class="pb-2 pr-4">Price</th>
                        <th class="pb-2">Date</th>
                    </tr>
                </thead>
                <tbody>
                    ${affiliateHistory.map(p => `
                        <tr class="border-b border-surface-100">
                            <td class="py-3 pr-4">
                                <span class="text-ink-800 line-clamp-1">${escapeHtml(p.product_title || p.productTitle || 'Unknown')}</span>
                            </td>
                            <td class="py-3 pr-4">
                                <span class="text-xs px-2 py-0.5 rounded-full ${p.platform === 'whatsapp' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}">
                                    ${p.platform === 'whatsapp' ? 'WhatsApp' : 'Telegram'}
                                </span>
                            </td>
                            <td class="py-3 pr-4 text-green-600">${p.commission_rate || p.commissionRate || 'N/A'}%</td>
                            <td class="py-3 pr-4">$${(p.sale_price || p.salePrice || 0).toFixed(2)}</td>
                            <td class="py-3 text-ink-400">${new Date(p.published_at || p.publishedAt).toLocaleDateString()}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

// ============================================
// AFFILIATE SUB-TAB NAVIGATION
// ============================================

function showAffiliateSubTab(tabName) {
    // Hide all sub-tab contents
    document.querySelectorAll('.aff-subtab-content').forEach(el => el.classList.add('hidden'));

    // Remove active from all sub-tab buttons
    document.querySelectorAll('.aff-tab-btn').forEach(btn => btn.classList.remove('tab-active'));

    // Show selected
    const content = document.getElementById(`aff-content-${tabName}`);
    const tab = document.getElementById(`aff-tab-${tabName}`);
    if (content) content.classList.remove('hidden');
    if (tab) tab.classList.add('tab-active');

    // Lazy-load data for certain tabs
    if (tabName === 'products' && affiliateCredentials?.oauthConnected) {
        // Products tab ready for search
    } else if (tabName === 'history') {
        loadHistory();
    }
}

// ============================================
// API HELPERS (affiliate-specific)
// ============================================

async function affApiGet(url) {
    const token = localStorage.getItem('token');
    const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        credentials: 'include'
    });
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || 'Request failed');
    }
    return data;
}

async function affApiPost(url, body) {
    const token = localStorage.getItem('token');
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-CSRF-Token': getCsrfToken()
        },
        credentials: 'include',
        body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
}

async function affApiPut(url, body) {
    const token = localStorage.getItem('token');
    const response = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-CSRF-Token': getCsrfToken()
        },
        credentials: 'include',
        body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
}

async function affApiDelete(url) {
    const token = localStorage.getItem('token');
    const response = await fetch(url, {
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${token}`,
            'X-CSRF-Token': getCsrfToken()
        },
        credentials: 'include'
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
}

// ============================================
// UTILITIES
// ============================================

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}
